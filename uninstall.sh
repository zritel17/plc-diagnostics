#!/bin/bash
# PLC Gateway — деинсталлятор
# Запуск: sudo ./uninstall.sh
set -euo pipefail

R='\033[0;31m'; G='\033[0;32m'; Y='\033[1;33m'; N='\033[0m'
[[ $EUID -eq 0 ]] || { echo "Запустите с sudo: sudo ./uninstall.sh"; exit 1; }

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  PLC Gateway — деинсталляция"
echo "═══════════════════════════════════════════════════════"
echo ""

# ── Остановить и удалить сервис ───────────────────────────────────────────────
echo -e "${Y}→${N} Останавливаю и удаляю systemd-сервис..."
systemctl stop plc-gateway 2>/dev/null || true
systemctl disable plc-gateway 2>/dev/null || true
rm -f /etc/systemd/system/plc-gateway.service
systemctl daemon-reload
echo -e "${G}✓${N} Сервис удалён"

# ── Удалить ярлыки ────────────────────────────────────────────────────────────
echo -e "${Y}→${N} Удаляю ярлыки приложения..."
rm -f /etc/xdg/autostart/plc-gateway-display.desktop
rm -f /usr/share/applications/plc-gateway-display.desktop
update-desktop-database /usr/share/applications 2>/dev/null || true
echo -e "${G}✓${N} Ярлыки удалены"

# ── Спросить про InfluxDB ─────────────────────────────────────────────────────
echo ""
read -r -p "Остановить и удалить контейнер InfluxDB? [д/N] " ans
if [[ "${ans,,}" == "д" || "${ans,,}" == "y" || "${ans,,}" == "yes" ]]; then
    cd "$INSTALL_DIR"
    docker compose down -v 2>/dev/null || true
    echo -e "${G}✓${N} InfluxDB остановлен и удалён"
else
    echo "  InfluxDB оставлен без изменений"
fi

# ── Информация об оставшихся данных ───────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo -e "${G}  Деинсталляция завершена${N}"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  Сохранены (удалите вручную если нужно):"
echo "    $INSTALL_DIR/venv/         — Python окружение"
echo "    $INSTALL_DIR/plc_config.db — база данных (дашборды, теги)"
echo "    $INSTALL_DIR/.env          — конфигурация и пароли"
echo ""
