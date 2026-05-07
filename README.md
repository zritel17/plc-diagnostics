# PLC Edge Gateway — Allen-Bradley ControlLogix

Веб-приложение на Raspberry Pi для **диагностики**, **сбора данных** и **визуализации**
тегов ПЛК Allen-Bradley (CompactLogix / ControlLogix). Связь с ПЛК — через
EtherNet/IP (`pylogix`).

## Возможности

**Диагностика** (вкладки «Теги», «I/O»)
- Подключение по IP+slot, автозагрузка списка тегов и I/O-модулей
- Дерево тегов с поиском, фильтром по типам, разворачиванием массивов
- Чтение/запись BOOL, INT (8/16/32/64), REAL, STRING, TIMER, COUNTER, UDT
- Дискретные и аналоговые I/O

**Сбор данных** (вкладка «Сбор данных»)
- Конфигурация тегов для записи в InfluxDB
- Режимы: `on_change` (с deadband для float) и `on_interval` (по таймеру)
- Пакетное чтение через `pylogix.Read([...])`
- Опциональный автозапуск коллектора при загрузке Pi (через systemd)
- Graceful degradation: если InfluxDB недоступна, диагностика продолжает работать

**Дашборды** (вкладка «Дашборды»)
- Несколько дашбордов с произвольным набором виджетов
- Виджеты: график (Chart.js), шкала, число, таблица
- Период: 15 мин ↔ 30 дней, агрегации mean/min/max/last

## Архитектура

```
┌──────────────────────────┐         ┌──────────────────────────┐
│  Браузер (UI на vanilla  │  HTTP/  │       Raspberry Pi 5      │
│  JS + Chart.js)          │  WS     │                          │
└────────────┬─────────────┘ ◄─────► │  systemd: plc-gateway     │
             │                       │   └─ uvicorn → app.py     │
             │                       │       ├─ /api/* (REST)    │
             │                       │       ├─ /ws/live (WS)    │
             │                       │       └─ collector (async)│
             │                       │  Docker: influxdb 2.7     │
             │                       │   └─ raw / hourly / daily │
             │                       │  SQLite: plc_config.db    │
             └───── Tailscale ───────┴──── EtherNet/IP ──► ПЛК   │
                                     └──────────────────────────┘
```

- `app.py` — FastAPI: существующие эндпоинты диагностики + новые конфиг/коллектор/данные/дашборды
- `collector.py` — асинхронный коллектор. Держит **отдельное** соединение с ПЛК,
  не блокирует диагностический поток
- `db.py` — SQLAlchemy (async) для конфига + клиент InfluxDB для временных рядов
- `models.py` — Pydantic-схемы новых API
- `static/` — UI (vanilla JS): `app.js` диагностика, `collector.js`/`config.js`/`dashboard.js` —
  расширения, `init_extras.js` — связка вкладок и WebSocket

## Установка

```bash
cd /home/pi/plc-diagnostics
./install.sh
```

Скрипт ставит Python-зависимости, поднимает Docker и InfluxDB, создаёт бакеты
`plc_data` (30 дней), `plc_hourly` (1 год), `plc_daily` (5 лет) с задачами
агрегации, разворачивает systemd-сервис `plc-gateway.service`.

После успешной установки:
- UI: `http://<ip-пи>:5000`
- InfluxDB UI: `http://<ip-пи>:8086` (admin / `plcgateway123`)

## Управление

```bash
# Сервис
sudo systemctl status plc-gateway
sudo systemctl restart plc-gateway
sudo journalctl -u plc-gateway -f

# Контейнер InfluxDB
sudo docker compose ps
sudo docker compose logs -f influxdb
sudo docker compose restart influxdb
```

## Файлы

```
/home/pi/plc-diagnostics/
├── app.py                      FastAPI: диагностика + новые роуты
├── collector.py                async коллектор → InfluxDB
├── db.py                       SQLite (SQLAlchemy async) + Influx-клиент
├── models.py                   Pydantic-схемы
├── setup_influx.py             идемпотентная настройка бакетов и tasks
├── static/
│   ├── index.html              главная (4 вкладки)
│   ├── app.js                  существующий код диагностики
│   ├── collector.js            UI статуса коллектора
│   ├── config.js               UI конфига тегов сбора
│   ├── dashboard.js            конструктор дашбордов
│   ├── init_extras.js          связка вкладок + WS
│   └── styles.css              стили
├── plc_config.db               SQLite (создаётся автоматически)
├── history.json                история подключений к ПЛК
├── docker-compose.yml          InfluxDB 2.7
├── plc-gateway.service         systemd unit
├── .env                        креды/URL InfluxDB
├── requirements.txt
└── install.sh                  полная установка
```

## Сценарий пользователя

1. **Подключение к ПЛК** (вкладка «Теги»): ввести IP и slot, нажать «Подключить».
   В дереве появятся теги; на «I/O» — модули.
2. **Конфигурация сбора** (вкладка «Сбор данных»):
   - в «Настройках» указать IP ПЛК, slot, интервал опроса (мс), включить «Автозапуск»
   - нажать «+ Добавить из ПЛК» → выбрать теги, выбрать режим (`on_change` или `on_interval`)
     и параметр (deadband для float или интервал в секундах) → «Добавить выбранные»
3. **Запуск коллектора**: «▶ Запустить» в верхней карточке. Появятся значения
   счётчиков `polls/writes`. Через несколько секунд в InfluxDB появятся точки.
4. **Дашборд** (вкладка «Дашборды»):
   - «+ Новый» → ввести имя
   - выбрать тег из выпадающего, тип виджета и период → «＋ Добавить»

## API

| Метод | Путь | Описание |
|---|---|---|
| GET | `/` | UI |
| POST | `/api/connect` | подключение к ПЛК (диагностика) |
| POST | `/api/disconnect` | |
| GET | `/api/tags` | онлайн-значения всех тегов |
| GET | `/api/io` | онлайн-значения I/O |
| POST | `/api/write` | запись в тег |
| GET | `/api/status` | состояние подключения |
| GET | `/api/history` | история подключений |
| GET | `/api/config/tags` | список тегов в сборе |
| POST | `/api/config/tags/save` | upsert тегов |
| DELETE | `/api/config/tags/{name}` | удалить тег из сбора |
| GET | `/api/collector/settings` | настройки коллектора |
| POST | `/api/collector/settings` | сохранить настройки |
| GET | `/api/collector/status` | статус коллектора |
| POST | `/api/collector/start` | старт коллектора |
| POST | `/api/collector/stop` | стоп коллектора |
| GET | `/api/data/tags` | теги, по которым есть данные в Influx |
| GET | `/api/data/{name}/history?from=&to=&bucket=&agg=` | история |
| GET | `/api/data/{name}/stats?from=&to=` | агрегаты mean/min/max/last |
| GET | `/api/dashboard` | список дашбордов |
| POST | `/api/dashboard` | создать |
| GET | `/api/dashboard/{id}` | дашборд + виджеты |
| PUT | `/api/dashboard/{id}` | обновить (включая список виджетов целиком) |
| DELETE | `/api/dashboard/{id}` | удалить |
| WS | `/ws/live` | поток изменений тегов |

## Принципы реализации

- **Не ломать существующее**. Диагностические роуты и UI сохранены без изменений.
  Коллектор использует своё соединение с ПЛК — независимо от диагностического
  состояния.
- **Graceful degradation**. Если InfluxDB недоступен, коллектор не пишет,
  диагностика и UI продолжают работать.
- **Один процесс**. Коллектор живёт как `asyncio` background task внутри FastAPI,
  без отдельного демона.
- **Pacing**. `pylogix.Read([...])` пакетом для on_change тегов; on_interval
  обрабатываются отдельными задачами для каждого тега.

## Хранение

| Бакет Influx | Retention | Назначение |
|---|---|---|
| `plc_data` | 30 дней | сырые точки от коллектора |
| `plc_hourly` | 1 год | средние за час (Flux task `plc_to_hourly`) |
| `plc_daily` | 5 лет | средние за сутки (Flux task `plc_hourly_to_daily`) |

Конфиг (теги, настройки, дашборды) — `plc_config.db` (SQLite).

## Известные ограничения

- При большом количестве тегов в сборе (>500) увеличить интервал опроса до 200–500 мс.
- Задачи агрегации Influx идут по расписанию `every: 1h / 24h`. Свежие данные
  в `plc_hourly` появляются с задержкой до 1 часа.
