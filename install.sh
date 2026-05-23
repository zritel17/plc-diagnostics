#!/bin/bash
# PLC Gateway — installer for Raspberry Pi OS (Bookworm, 64-bit)
# Usage: sudo ./install.sh
set -euo pipefail

# ── Output colors ─────────────────────────────────────────────────────────────
R='\033[0;31m'; G='\033[0;32m'; Y='\033[1;33m'; B='\033[0;34m'; N='\033[0m'
info()    { echo -e "${B}→${N} $*"; }
success() { echo -e "${G}✓${N} $*"; }
warn()    { echo -e "${Y}⚠${N} $*"; }
error()   { echo -e "${R}✗${N} $*"; exit 1; }

# ── Check privileges ──────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || error "Run with sudo: sudo ./install.sh"

ACTUAL_USER="${SUDO_USER:-pi}"
INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$INSTALL_DIR/.env"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  PLC Gateway — installation"
echo "  Directory: $INSTALL_DIR"
echo "  User: $ACTUAL_USER"
echo "═══════════════════════════════════════════════════════"
echo ""

# ── 1. System dependencies ────────────────────────────────────────────────────
info "1/7 System packages..."
apt-get update -qq
apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip \
    python3-gi gir1.2-webkit2-4.1 gir1.2-gtk-3.0 \
    rsync curl \
    > /dev/null 2>&1
success "System packages installed"

# ── 2. Docker + InfluxDB ──────────────────────────────────────────────────────
info "2/7 Docker and InfluxDB..."
if ! command -v docker &>/dev/null; then
    info "  Installing Docker..."
    apt-get install -y --no-install-recommends docker.io docker-compose-plugin > /dev/null 2>&1
    usermod -aG docker "$ACTUAL_USER" || true
    systemctl enable docker --quiet
    systemctl start docker
    success "  Docker installed"
else
    success "  Docker already installed ($(docker --version | cut -d' ' -f3 | tr -d ','))"
fi

info "  Starting InfluxDB..."
cd "$INSTALL_DIR"
docker compose up -d > /dev/null 2>&1 || warn "docker compose up returned an error — check docker-compose.yml"

info "  Waiting for InfluxDB (up to 30 s)..."
for i in $(seq 1 30); do
    if curl -sf http://localhost:8086/health > /dev/null 2>&1; then
        success "  InfluxDB ready"
        break
    fi
    sleep 1
    if [[ $i -eq 30 ]]; then
        warn "  InfluxDB did not respond in 30 s. Set up buckets manually: python3 setup_influx.py"
    fi
done

# ── 3. Python venv + dependencies ─────────────────────────────────────────────
info "3/7 Python virtual environment..."
VENV_DIR="$INSTALL_DIR/venv"

if [[ -d "$VENV_DIR" ]]; then
    info "  Updating existing venv..."
else
    sudo -u "$ACTUAL_USER" python3 -m venv "$VENV_DIR"
fi

sudo -u "$ACTUAL_USER" "$VENV_DIR/bin/pip" install -q --upgrade pip
sudo -u "$ACTUAL_USER" "$VENV_DIR/bin/pip" install -q -r "$INSTALL_DIR/requirements.txt"
success "Python dependencies installed"

# ── 4. InfluxDB buckets ───────────────────────────────────────────────────────
info "4/7 InfluxDB buckets..."
if curl -sf http://localhost:8086/health > /dev/null 2>&1; then
    sudo -u "$ACTUAL_USER" "$VENV_DIR/bin/python3" "$INSTALL_DIR/setup_influx.py" \
        && success "  Buckets configured (plc_data / plc_hourly / plc_daily)" \
        || warn "  setup_influx.py returned an error — retry manually: python3 setup_influx.py"
else
    warn "  InfluxDB unavailable — skipping bucket setup"
fi

# ── 5. Ollama (local AI) ──────────────────────────────────────────────────────
info "5/7 Ollama (local AI model)..."
if ! command -v ollama &>/dev/null; then
    info "  Installing Ollama..."
    curl -fsSL https://ollama.ai/install.sh | sh > /dev/null 2>&1
    success "  Ollama installed"
else
    success "  Ollama already installed"
fi

systemctl enable ollama --quiet 2>/dev/null || true
systemctl start ollama 2>/dev/null || true
sleep 2

AI_MODEL_NAME="${AI_MODEL:-phi3:mini}"
if sudo -u "$ACTUAL_USER" ollama list 2>/dev/null | grep -q "^${AI_MODEL_NAME}"; then
    success "  Model $AI_MODEL_NAME already downloaded"
else
    info "  Downloading model $AI_MODEL_NAME (may take 5-10 min)..."
    sudo -u "$ACTUAL_USER" ollama pull "$AI_MODEL_NAME" \
        && success "  Model $AI_MODEL_NAME downloaded" \
        || warn "  Failed to download $AI_MODEL_NAME. Run manually: ollama pull $AI_MODEL_NAME"
fi

# ── 6. .env file ──────────────────────────────────────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
    cp "$INSTALL_DIR/.env.example" "$ENV_FILE"
    chown "$ACTUAL_USER:$ACTUAL_USER" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    warn "Created $ENV_FILE — set your password: nano $ENV_FILE"
else
    success ".env already exists — not modified"
fi

# ── 7. systemd service ────────────────────────────────────────────────────────
info "7/7 systemd service and shortcuts..."

systemctl stop plc-gateway 2>/dev/null || true
systemctl stop plc-diagnostics 2>/dev/null || true
systemctl disable plc-diagnostics 2>/dev/null || true
pkill -f "uvicorn app:app" 2>/dev/null || true

SERVICE_DEST=/etc/systemd/system/plc-gateway.service
sed "s/^User=pi$/User=${ACTUAL_USER}/; s/^Group=pi$/Group=${ACTUAL_USER}/" \
    "$INSTALL_DIR/plc-gateway.service" > "$SERVICE_DEST"

systemctl daemon-reload
systemctl enable plc-gateway --quiet
systemctl start plc-gateway

DESKTOP_SRC="$INSTALL_DIR/plc-gateway-display.desktop"
ACTUAL_HOME=$(getent passwd "$ACTUAL_USER" | cut -d: -f6)
sed "s|/home/pi|$ACTUAL_HOME|g" "$DESKTOP_SRC" | \
    sed "s|plc-diagnostics|$(basename "$INSTALL_DIR")|g" \
    > /usr/share/applications/plc-gateway-display.desktop
update-desktop-database /usr/share/applications 2>/dev/null || true

mkdir -p /etc/xdg/autostart
cp /usr/share/applications/plc-gateway-display.desktop /etc/xdg/autostart/

success "Service and shortcuts installed"

# ── Summary ───────────────────────────────────────────────────────────────────
PI_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "?")

echo ""
echo "═══════════════════════════════════════════════════════"
echo -e "${G}  Installation complete!${N}"
echo "═══════════════════════════════════════════════════════"
echo ""
echo -e "  Web UI:    ${B}http://${PI_IP}:5000${N}"
echo -e "  InfluxDB:  ${B}http://${PI_IP}:8086${N}  (admin / plcgateway123)"
echo -e "  Config:    ${B}${ENV_FILE}${N}"
echo ""
echo "  Service management:"
echo "    sudo systemctl status plc-gateway"
echo "    sudo journalctl -u plc-gateway -f"
echo ""
echo "  Launch GUI manually:"
echo "    $VENV_DIR/bin/python3 $INSTALL_DIR/plc_app.py"
echo ""
echo "  Note: GUI will open automatically on next desktop login."
echo ""

if [[ ! -f "$ENV_FILE" ]] || grep -q "plcadmin" "$ENV_FILE" 2>/dev/null; then
    echo -e "${Y}  ⚠  Remember to set your password in ${ENV_FILE}${N}"
    echo ""
fi

sudo systemctl status plc-gateway --no-pager -n 5
