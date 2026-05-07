#!/bin/bash
set -euo pipefail

# Полная установка PLC Edge Gateway на Raspberry Pi.
# Запускать ИЗ каталога проекта (/home/pi/plc-diagnostics).

cd "$(dirname "$0")"

echo "📦 1/5 Python зависимости…"
sudo pip3 install --break-system-packages -r requirements.txt

echo "🐳 2/5 InfluxDB через docker compose…"
if ! command -v docker >/dev/null 2>&1; then
    echo "→ Устанавливаю docker.io"
    sudo apt-get update
    sudo apt-get install -y docker.io docker-compose-plugin
    sudo usermod -aG docker "$USER" || true
fi
sudo docker compose up -d

echo "⏳ 3/5 жду пока InfluxDB поднимется…"
for i in $(seq 1 30); do
    if curl -fs http://localhost:8086/health >/dev/null; then
        echo "→ InfluxDB готов"
        break
    fi
    sleep 1
done

echo "🪣 4/5 настраиваю бакеты и задачи агрегации…"
python3 setup_influx.py || echo "⚠ setup_influx.py вернул ошибку — повторите вручную позже"

echo "🔧 5/5 systemd сервис…"
# Останавливаем старую службу диагностики если есть
sudo systemctl stop plc-diagnostics 2>/dev/null || true
sudo systemctl disable plc-diagnostics 2>/dev/null || true
# Останавливаем ручной uvicorn если запущен
pkill -f "uvicorn app:app" 2>/dev/null || true

sudo cp plc-gateway.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable plc-gateway
sudo systemctl restart plc-gateway

echo ""
echo "✅ Готово."
echo "🔗 UI:        http://$(hostname -I | awk '{print $1}'):5000"
echo "📈 InfluxDB:  http://$(hostname -I | awk '{print $1}'):8086 (admin / plcgateway123)"
sudo systemctl status plc-gateway --no-pager -n 10
