#!/bin/bash
# PLC Gateway — установщик для Raspberry Pi OS (Bookworm, 64-bit)
# Запуск: sudo ./install.sh
set -euo pipefail

# ── Цвета для вывода ──────────────────────────────────────────────────────────
R='\033[0;31m'; G='\033[0;32m'; Y='\033[1;33m'; B='\033[0;34m'; N='\033[0m'
info()    { echo -e "${B}→${N} $*"; }
success() { echo -e "${G}✓${N} $*"; }
warn()    { echo -e "${Y}⚠${N} $*"; }
error()   { echo -e "${R}✗${N} $*"; exit 1; }

# ── Проверка прав ─────────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || error "Запустите с sudo: sudo ./install.sh"

ACTUAL_USER="${SUDO_USER:-pi}"
INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$INSTALL_DIR/.env"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  PLC Gateway — установка"
echo "  Директория: $INSTALL_DIR"
echo "  Пользователь: $ACTUAL_USER"
echo "═══════════════════════════════════════════════════════"
echo ""

# ── 1. Системные зависимости ──────────────────────────────────────────────────
info "1/7 Системные пакеты..."
apt-get update -qq
apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip \
    python3-gi gir1.2-webkit2-4.1 gir1.2-gtk-3.0 \
    rsync curl \
    > /dev/null 2>&1
success "Системные пакеты установлены"

# ── 2. Docker + InfluxDB ──────────────────────────────────────────────────────
info "2/7 Docker и InfluxDB..."
if ! command -v docker &>/dev/null; then
    info "  Устанавливаю Docker..."
    apt-get install -y --no-install-recommends docker.io docker-compose-plugin > /dev/null 2>&1
    usermod -aG docker "$ACTUAL_USER" || true
    systemctl enable docker --quiet
    systemctl start docker
    success "  Docker установлен"
else
    success "  Docker уже установлен ($(docker --version | cut -d' ' -f3 | tr -d ','))"
fi

info "  Запускаю InfluxDB..."
cd "$INSTALL_DIR"
docker compose up -d > /dev/null 2>&1 || warn "docker compose up вернул ошибку — проверьте docker-compose.yml"

info "  Жду готовности InfluxDB (до 30 сек)..."
for i in $(seq 1 30); do
    if curl -sf http://localhost:8086/health > /dev/null 2>&1; then
        success "  InfluxDB готов"
        break
    fi
    sleep 1
    if [[ $i -eq 30 ]]; then
        warn "  InfluxDB не ответил за 30 сек. Настройте бакеты вручную: python3 setup_influx.py"
    fi
done

# ── 3. Python venv + зависимости ─────────────────────────────────────────────
info "3/7 Python виртуальное окружение..."
VENV_DIR="$INSTALL_DIR/venv"

if [[ -d "$VENV_DIR" ]]; then
    info "  Обновляю существующий venv..."
else
    sudo -u "$ACTUAL_USER" python3 -m venv "$VENV_DIR"
fi

sudo -u "$ACTUAL_USER" "$VENV_DIR/bin/pip" install -q --upgrade pip
sudo -u "$ACTUAL_USER" "$VENV_DIR/bin/pip" install -q -r "$INSTALL_DIR/requirements.txt"
success "Python зависимости установлены"

# ── 4. Настройка бакетов InfluxDB ─────────────────────────────────────────────
info "4/7 Бакеты InfluxDB..."
if curl -sf http://localhost:8086/health > /dev/null 2>&1; then
    sudo -u "$ACTUAL_USER" "$VENV_DIR/bin/python3" "$INSTALL_DIR/setup_influx.py" \
        && success "  Бакеты настроены (plc_data / plc_hourly / plc_daily)" \
        || warn "  setup_influx.py вернул ошибку — повторите вручную: python3 setup_influx.py"
else
    warn "  InfluxDB недоступен — пропускаю настройку бакетов"
fi

# ── 5. Ollama (локальный ИИ) ──────────────────────────────────────────────────
info "5/7 Ollama (локальная ИИ-модель)..."
if ! command -v ollama &>/dev/null; then
    info "  Устанавливаю Ollama..."
    curl -fsSL https://ollama.ai/install.sh | sh > /dev/null 2>&1
    success "  Ollama установлен"
else
    success "  Ollama уже установлен"
fi

# Запустить сервис если нет
systemctl enable ollama --quiet 2>/dev/null || true
systemctl start ollama 2>/dev/null || true
sleep 2

# Скачать модель
AI_MODEL_NAME="${AI_MODEL:-phi3:mini}"
if sudo -u "$ACTUAL_USER" ollama list 2>/dev/null | grep -q "^${AI_MODEL_NAME}"; then
    success "  Модель $AI_MODEL_NAME уже загружена"
else
    info "  Скачиваю модель $AI_MODEL_NAME (может занять 5-10 мин)..."
    sudo -u "$ACTUAL_USER" ollama pull "$AI_MODEL_NAME" \
        && success "  Модель $AI_MODEL_NAME загружена" \
        || warn "  Не удалось скачать $AI_MODEL_NAME. Запустите вручную: ollama pull $AI_MODEL_NAME"
fi

# ── 6. .env файл ──────────────────────────────────────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
    cp "$INSTALL_DIR/.env.example" "$ENV_FILE"
    chown "$ACTUAL_USER:$ACTUAL_USER" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    warn "Создан $ENV_FILE — задайте пароль: nano $ENV_FILE"
else
    success ".env уже существует — не изменяю"
fi

# ── 7. systemd сервис ─────────────────────────────────────────────────────────
info "7/7 systemd сервис и ярлыки..."

# Остановить старые версии
systemctl stop plc-gateway 2>/dev/null || true
systemctl stop plc-diagnostics 2>/dev/null || true
systemctl disable plc-diagnostics 2>/dev/null || true
pkill -f "uvicorn app:app" 2>/dev/null || true

# Записать service-файл с реальным пользователем
SERVICE_DEST=/etc/systemd/system/plc-gateway.service
sed "s/^User=pi$/User=${ACTUAL_USER}/; s/^Group=pi$/Group=${ACTUAL_USER}/" \
    "$INSTALL_DIR/plc-gateway.service" > "$SERVICE_DEST"

systemctl daemon-reload
systemctl enable plc-gateway --quiet
systemctl start plc-gateway

# .desktop для запуска из меню приложений
DESKTOP_SRC="$INSTALL_DIR/plc-gateway-display.desktop"
# Заменяем /home/pi на реальный домашний каталог
ACTUAL_HOME=$(getent passwd "$ACTUAL_USER" | cut -d: -f6)
sed "s|/home/pi|$ACTUAL_HOME|g" "$DESKTOP_SRC" | \
    sed "s|plc-diagnostics|$(basename "$INSTALL_DIR")|g" \
    > /usr/share/applications/plc-gateway-display.desktop
update-desktop-database /usr/share/applications 2>/dev/null || true

# XDG autostart — запуск GUI при входе в рабочий стол
mkdir -p /etc/xdg/autostart
cp /usr/share/applications/plc-gateway-display.desktop /etc/xdg/autostart/

success "Сервис и ярлыки установлены"

# ── Итог ──────────────────────────────────────────────────────────────────────
PI_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "?")

echo ""
echo "═══════════════════════════════════════════════════════"
echo -e "${G}  Установка завершена!${N}"
echo "═══════════════════════════════════════════════════════"
echo ""
echo -e "  Web UI (браузер):  ${B}http://${PI_IP}:5000${N}"
echo -e "  InfluxDB:          ${B}http://${PI_IP}:8086${N}  (admin / plcgateway123)"
echo -e "  Конфигурация:      ${B}${ENV_FILE}${N}"
echo ""
echo "  Управление сервисом:"
echo "    sudo systemctl status plc-gateway"
echo "    sudo journalctl -u plc-gateway -f"
echo ""
echo "  Запуск GUI вручную:"
echo "    $VENV_DIR/bin/python3 $INSTALL_DIR/plc_app.py"
echo ""
echo "  Примечание: GUI откроется автоматически при следующем"
echo "  входе в рабочий стол Raspberry Pi."
echo ""

if [[ ! -f "$ENV_FILE" ]] || grep -q "plcadmin" "$ENV_FILE" 2>/dev/null; then
    echo -e "${Y}  ⚠  Не забудьте сменить пароль в ${ENV_FILE}${N}"
    echo ""
fi

sudo systemctl status plc-gateway --no-pager -n 5
