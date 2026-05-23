#!/bin/bash
# PLC Gateway — uninstaller
# Usage: sudo ./uninstall.sh
set -euo pipefail

R='\033[0;31m'; G='\033[0;32m'; Y='\033[1;33m'; N='\033[0m'
[[ $EUID -eq 0 ]] || { echo "Run with sudo: sudo ./uninstall.sh"; exit 1; }

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  PLC Gateway — uninstall"
echo "═══════════════════════════════════════════════════════"
echo ""

# ── Stop and remove service ───────────────────────────────────────────────────
echo -e "${Y}→${N} Stopping and removing systemd service..."
systemctl stop plc-gateway 2>/dev/null || true
systemctl disable plc-gateway 2>/dev/null || true
rm -f /etc/systemd/system/plc-gateway.service
systemctl daemon-reload
echo -e "${G}✓${N} Service removed"

# ── Remove desktop shortcuts ──────────────────────────────────────────────────
echo -e "${Y}→${N} Removing application shortcuts..."
rm -f /etc/xdg/autostart/plc-gateway-display.desktop
rm -f /usr/share/applications/plc-gateway-display.desktop
update-desktop-database /usr/share/applications 2>/dev/null || true
echo -e "${G}✓${N} Shortcuts removed"

# ── Ask about InfluxDB ────────────────────────────────────────────────────────
echo ""
read -r -p "Stop and remove InfluxDB container? [y/N] " ans
if [[ "${ans,,}" == "y" || "${ans,,}" == "yes" ]]; then
    cd "$INSTALL_DIR"
    docker compose down -v 2>/dev/null || true
    echo -e "${G}✓${N} InfluxDB stopped and removed"
else
    echo "  InfluxDB left unchanged"
fi

# ── Remaining data ────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo -e "${G}  Uninstall complete${N}"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  The following were kept (remove manually if needed):"
echo "    $INSTALL_DIR/venv/         — Python environment"
echo "    $INSTALL_DIR/plc_config.db — database (dashboards, tags)"
echo "    $INSTALL_DIR/.env          — configuration and passwords"
echo ""
