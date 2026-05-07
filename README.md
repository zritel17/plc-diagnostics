# PLC Edge Gateway — Allen-Bradley ControlLogix

Веб-приложение на Raspberry Pi 5 для **диагностики, управления, сбора данных и
визуализации** тегов Allen-Bradley (CompactLogix / ControlLogix) по EtherNet/IP
(`pylogix`). Дизайн — Packline+ light theme (SnowUI-derived, Inter, светлая тема).

---

## Текущее состояние проекта (май 2026)

### Реализовано

| Модуль | Состояние |
|---|---|
| FastAPI бэкенд (`app.py`) | ✅ Работает |
| Аутентификация (пароль → JWT-token) | ✅ Работает |
| Вкладка **ПЛК** — подключение + живая таблица тегов | ✅ Работает |
| Вкладка **Контрольная панель** — виджеты управления | ✅ Работает |
| Вкладка **Дашборды** — Chart.js виджеты из InfluxDB | ✅ Работает |
| Вкладка **Теги** — конфиг тегов для сбора данных | ✅ Работает |
| Коллектор → InfluxDB (on_change / on_interval) | ✅ Работает |
| Кэш тегов в localStorage (персистент между перезагрузками) | ✅ Работает |
| Фоновый reader — batch-чтение тегов каждые 500 мс | ✅ Работает |
| Раздельные PLC-соединения для чтения и записи | ✅ Работает |
| GET /api/tags и /api/io — возврат кэша мгновенно | ✅ Работает |
| Секции (заголовки-разделители) в Контрольной панели | ✅ Работает |
| Drag-and-drop сортировка виджетов | ✅ Работает |
| Кнопка + Индикатор в одной карточке | ✅ Работает |
| Авто-подключение к ПЛК после входа (галочка) | ✅ Работает |
| WebSocket /ws/live для live-обновлений | ✅ Работает |
| Systemd сервис `plc-gateway` | ✅ Работает |

---

## Навигация (4 вкладки в сайдбаре)

### ПЛК
Главная рабочая вкладка. Открывается по умолчанию.

- **Блок подключения** (вверху): IP, Slot, кнопка «Подключить/Отключить», галочка **Авто-подключение**, история 10 последних подключений, алерты
- **Живая таблица тегов**: звезда (избранное), адрес, тип, значение, действия:
  - `★ / ☆` — добавить/убрать из избранных (localStorage)
  - `⇄ Toggle` / `⏺ Момент.` — для BOOL-тегов
  - `✎ Запись` — ввод нового значения для числовых / строк (prompt)
  - `▼ Биты` — раскрыть битовое представление (SINT/INT/DINT/LINT)
  - `+ Сбор` — одним кликом добавить тег в коллектор (on_change, deadband 0)
- **Фильтры**: поиск по имени, фильтр по типу, «★ Только избранные»
- **localStorage**: запоминает IP/Slot и кэширует полный список тегов. После перезагрузки страницы теги видны без переподключения к ПЛК. При включённой галочке «Авто-подключение» — ПЛК подключается автоматически.

### Контрольная панель
Редактируемая панель виджетов. Данные берёт из `window.tagsData`.

**Типы виджетов:**
| Тип | Описание |
|---|---|
| Кнопка (удерж.) | Пишет '1' пока нажата, '0' при отпускании. При уходе со страницы автоматически отправляет '0'. |
| Кнопка (фикс.) | Toggle: нажатие переключает '0'↔'1'. Мгновенное обновление DOM, синхронизация с ПЛК через ~300 мс. |
| Индикатор | Отображает булево значение тега (ВКЛ/ВЫКЛ). |
| Числовой индикатор | Отображает числовое значение. |
| Числовой ввод | Показывает значение + поле для ввода нового. |
| Секция (заголовок) | Полноширинный разделитель для группировки виджетов. |

**Особенности:**
- Кнопка (удерж. / фикс.) поддерживает дополнительный **тег-индикатор**: в одной карточке кнопка пишет один тег, а ниже показывается состояние другого (например, обратная связь от ПЛК).
- **Режим правки**: добавление/удаление виджетов, **drag-and-drop** сортировка (порядок сохраняется в localStorage), фильтр по избранным тегам.
- Конфигурация виджетов хранится в `localStorage` (`plc_ctrl_widgets`).

### Дашборды
Исторические данные из InfluxDB. Несколько дашбордов с произвольными виджетами.

Виджеты: **график** (Chart.js, линейный), **шкала**, **число** (stat card), **таблица**.

Период: 15 мин / 1 ч / 6 ч / 24 ч / 7 дней / 30 дней. Агрегации: mean / min / max / last.

### Теги (коллектор)
- Статус коллектора: состояние, IP ПЛК, кол-во опросов/записей/ошибок, статус InfluxDB
- Кнопки «▶ Запустить» / «■ Остановить»
- Настройки: IP ПЛК, Slot, интервал опроса (мс), автозапуск при старте Pi
- Список тегов в сборе: тег, тип, режим (on_change / on_interval), параметр (deadband или интервал), активен
- «+ Добавить из ПЛК» — открывает модальное окно со списком тегов с возможностью отфильтровать и выбрать несколько

---

## Архитектура

```
┌──────────────────────────┐         ┌─────────────────────────────────────┐
│  Браузер                 │  HTTP/  │  Raspberry Pi 5                     │
│  Packline+ UI            │  WS     │                                     │
│  vanilla JS + Chart.js   │ ◄─────► │  systemd: plc-gateway.service       │
└──────────────────────────┘         │   └─ uvicorn → app.py (FastAPI)     │
                                     │       ├─ /api/auth/*                │
                                     │       ├─ /api/connect|disconnect    │
                                     │       ├─ /api/tags  (кэш, мгновен.) │
                                     │       ├─ /api/io    (кэш, мгновен.) │
                                     │       ├─ /api/write (прямо в ПЛК)  │
                                     │       ├─ /api/config/tags*          │
                                     │       ├─ /api/collector/*           │
                                     │       ├─ /api/data/*                │
                                     │       ├─ /api/dashboard*            │
                                     │       └─ /ws/live (WebSocket)       │
                                     │  _plc_bg_reader() — asyncio task    │
                                     │   └─ batch plc.Read([все теги])     │
                                     │      каждые 500 мс → _tags_cache    │
                                     │  collector.py (asyncio background)  │
                                     │   └─ отдельный PLC-коннект          │
                                     │  Docker: influxdb 2.7               │
                                     │   └─ plc_data / plc_hourly / plc_daily│
                                     │  SQLite: plc_config.db              │
                                     └─────────────────────────────────────┘
```

### Как работает чтение и запись тегов

```
Фронтенд (300 мс)           Сервер                         ПЛК
──────────────────          ──────────────────────          ──────────────
GET /api/tags ──────────►  вернуть _tags_cache (0 мс)
GET /api/tags ──────────►  вернуть _tags_cache (0 мс)
                            _plc_bg_reader()  ─[current_plc]─► plc.Read([все теги])
                                              ◄──────────────  все значения за 1 вызов
                            обновить _tags_cache

POST /api/write ────────►  async with _write_lock ─[_write_plc]─► plc.Write(tag, val)
                           (не зависит от чтения)               ◄── ок
```

---

## Файловая структура

```
plc-diagnostics/
├── app.py                     FastAPI: все роуты, auth, PLC-диагностика,
│                              фоновый reader (_plc_bg_reader)
├── collector.py               async коллектор (отдельный PLC-коннект → InfluxDB)
├── db.py                      SQLAlchemy async (SQLite) + InfluxDB client
├── models.py                  Pydantic-схемы API
├── setup_influx.py            идемпотентная настройка бакетов и Flux tasks
├── install.sh                 полная установка (зависимости, Docker, systemd)
├── docker-compose.yml         InfluxDB 2.7
├── plc-gateway.service        systemd unit (название: plc-gateway)
├── .env                       INFLUX_URL, INFLUX_TOKEN, INFLUX_ORG, AUTH_PASSWORD
├── requirements.txt           Python-зависимости
├── plc_config.db              SQLite (создаётся автоматически)
├── history.json               история подключений к ПЛК
├── static/
│   ├── index.html             главная (Packline+ UI, кэш-bust ?v=15)
│   ├── app.js                 ядро: PLC-подключение, дерево тегов, write
│   ├── diagnostics.js         живая таблица тегов (ПЛК-вкладка)
│   ├── collector.js           UI статуса коллектора
│   ├── config.js              UI конфига тегов (TagCfg)
│   ├── dashboard.js           конструктор дашбордов
│   ├── control.js             виджеты контрольной панели
│   ├── init_extras.js         auth + вкладки + WebSocket + localStorage
│   ├── styles.css             Packline+ light theme
│   ├── login.html             страница входа
│   └── assets/                SVG-иконки, логотип (logo-glyph.svg)
└── QUICK_START.txt / SETUP_INSTRUCTIONS.txt / README.md
```

---

## Ключевые технические детали

### Auth
- Один пароль — в `.env` переменная `AUTH_PASSWORD`
- `POST /api/auth/login { password }` → `{ token }` (UUID, хранится в `_tokens` dict в памяти)
- Токен кладётся в `localStorage.plc_token`, добавляется в каждый запрос через `fetch`-обёртку в `init_extras.js`
- При перезапуске сервиса `_tokens` очищается → `init_extras.js` делает `GET /api/auth/check` при старте, на 401 редиректит на `/login`
- WS закрывается с кодом 4001 при невалидном токене → редирект на логин

### Фоновый reader и кэширование тегов

`_plc_bg_reader()` — asyncio task, стартует в `lifespan()`:
- Каждые 500 мс вызывает `plc.Read([список_всех_тегов])` на `current_plc` — **один batch-запрос** вместо N отдельных
- Результат строится через `_build_tags_result()` и кладётся в `_tags_cache`
- IO-модули читаются аналогично batch-вызовом → `_io_cache`
- `GET /api/tags` и `GET /api/io` возвращают кэш **мгновенно** без обращения к ПЛК

### Раздельные соединения для чтения и записи

`POST /api/write` использует отдельный объект `_write_plc` (независимый TCP-сокет к ПЛК):
- `current_plc` — только для фонового reader, без конкуренции
- `_write_plc` — только для записи, с `_write_lock` против одновременных записей
- Нет FIFO-голодания: запись не ждёт завершения batch-чтения
- Ошибка в read-соединении не ломает write-соединение
- Оба создаются в `/api/connect`, оба закрываются в `/api/disconnect`

### Контрольная панель — поведение кнопок
- `_toggle()` (фикс.) обновляет DOM **немедленно**, без ожидания следующего опроса
- `ctrlPending` на 600 мс защищает от race condition при быстрых двойных кликах
- `beforeunload` отправляет `'0'` для всех удерживаемых momentary-кнопок
- Поллинг `updateValues` — 300 мс

### Зависимость модулей от `window.tagsData`
`app.js` хранит данные тегов в `let tagsData`.
`diagnostics.js` при каждом `loadTags()` явно пишет `window.tagsData = tagsData` и `window.isConnected = isConnected`.
Это даёт доступ к данным для `control.js` и `config.js`.

### localStorage ключи
| Ключ | Значение |
|---|---|
| `plc_token` | токен авторизации |
| `plc_last_ip` | последний подключённый IP |
| `plc_last_slot` | последний слот |
| `plc_autoconnect` | `'1'` = авто-подключение при загрузке страницы |
| `plc_tags_cache` | JSON `tagsData` (восстанавливается без переподключения) |
| `plc_diag_favs` | список избранных тегов |
| `plc_ctrl_widgets` | конфигурация виджетов контрольной панели |

### import middleware
```python
from starlette.middleware.base import BaseHTTPMiddleware  # НЕ fastapi.middleware.base
```

### CSS кэш-бастинг
Все статические файлы подключены с `?v=18` в `<link>` и `<script>` тегах.
При изменении JS/CSS увеличивать версию чтобы браузер подгрузил новые файлы.

---

## Управление сервисом

```bash
# Статус
sudo systemctl status plc-gateway

# Перезапуск (после git pull)
sudo systemctl restart plc-gateway

# Логи в реальном времени
sudo journalctl -u plc-gateway -f

# Тестовый запуск без systemd
cd /home/pi/plc-diagnostics
uvicorn app:app --host 0.0.0.0 --port 5000

# Docker InfluxDB
sudo docker compose ps
sudo docker compose logs -f influxdb
sudo docker compose restart influxdb
```

---

## API

| Метод | Путь | Описание |
|---|---|---|
| POST | `/api/auth/login` | вход (password → token) |
| GET | `/api/auth/check` | проверка токена |
| GET | `/` | главный UI |
| GET | `/login` | страница входа |
| POST | `/api/connect` | подключение к ПЛК |
| POST | `/api/disconnect` | отключение |
| GET | `/api/tags` | значения всех тегов (из кэша, мгновенно) |
| GET | `/api/tags/list` | плоский список name/type из кэша |
| GET | `/api/io` | I/O модули (из кэша, мгновенно) |
| POST | `/api/write` | запись в тег (прямо в ПЛК, с lock) |
| GET | `/api/status` | статус подключения |
| GET | `/api/history` | история подключений |
| GET | `/api/config/tags` | теги в сборе |
| POST | `/api/config/tags/save` | upsert тегов |
| DELETE | `/api/config/tags/{name}` | удалить тег |
| GET | `/api/collector/settings` | настройки коллектора |
| POST | `/api/collector/settings` | сохранить настройки |
| GET | `/api/collector/status` | статус коллектора |
| POST | `/api/collector/start` | старт |
| POST | `/api/collector/stop` | стоп |
| GET | `/api/data/tags` | теги с историей в Influx |
| GET | `/api/data/{name}/history` | история значений |
| GET | `/api/data/{name}/stats` | агрегаты |
| GET/POST | `/api/dashboard` | список / создать дашборд |
| GET/PUT/DELETE | `/api/dashboard/{id}` | дашборд + виджеты |
| WS | `/ws/live?token=` | поток tag_update событий |

---

## Хранение данных

| Хранилище | Что хранит |
|---|---|
| `plc_config.db` (SQLite) | теги для сбора, настройки коллектора, дашборды и виджеты |
| InfluxDB `plc_data` (30 дней) | сырые точки от коллектора |
| InfluxDB `plc_hourly` (1 год) | средние за час (Flux task) |
| InfluxDB `plc_daily` (5 лет) | средние за сутки (Flux task) |
| `history.json` | последние 10 подключений к ПЛК |
| `localStorage` (браузер) | токен, IP, кэш тегов, избранные, виджеты панели |

---

## Установка (первый раз)

```bash
ssh pi@<ip-малинки>
cd /home/pi/plc-diagnostics
./install.sh
```

После: UI на `http://<ip>:5000`, InfluxDB UI на `http://<ip>:8086` (admin / `plcgateway123`).

---

## Типичные проблемы

| Симптом | Причина / Решение |
|---|---|
| Редирект на `/login` при каждом запуске | Токен в localStorage устарел (сервер перезапустился, `_tokens` очистился). Норма — войдите снова. |
| `ModuleNotFoundError: fastapi.middleware.base` | Используется `from starlette.middleware.base import BaseHTTPMiddleware` |
| Теги не показываются в Контрольной панели | `window.tagsData` не заполнен — нужно подключиться к ПЛК на вкладке «ПЛК» (или включить «Авто-подключение») |
| Коллектор не стартует | Проверить `.env` (INFLUX_URL, TOKEN), `sudo docker compose ps` |
| Изменения CSS/JS не применяются | Проверить `?v=N` в `index.html`, сбросить кэш браузера (Ctrl+Shift+R) |
| Теги не загружаются сразу после подключения | Нормально — фоновый reader делает первый batch-запрос за ~500 мс |
