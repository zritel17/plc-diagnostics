"""
PLC Diagnostics + Edge Gateway.
- Существующие роуты (диагностика, I/O) — без изменений
- Новые роуты: конфиг сбора, коллектор, данные из InfluxDB, дашборды, WS, auth
"""
import asyncio
import json
import os
import secrets
import signal
import subprocess
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from typing import Optional, List

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Query, Request, BackgroundTasks
from starlette.middleware.base import BaseHTTPMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel
from pylogix import PLC
from sqlalchemy import select, delete

import db as db_module
from db import (
    SessionLocal, TagConfig, CollectorSettings, AppSettings, Dashboard, Widget, influx,
    init_db,
)
from models import (
    TagConfigIn, TagConfigOut, SaveTagsRequest,
    CollectorSettingsModel, CollectorStatus,
    WidgetIn, WidgetOut, DashboardIn, DashboardOut, DashboardUpdate,
    RecipeSnapshotCreate, RecipeChangesPayload,
)
from collector import collector

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
HISTORY_FILE = os.path.join(PROJECT_DIR, "history.json")
STATIC_DIR = os.path.join(PROJECT_DIR, "static")


shutdown_event: Optional[asyncio.Event] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global shutdown_event
    shutdown_event = asyncio.Event()
    # 1) SQLite
    try:
        await init_db()
        print("[STARTUP] SQLite готов")
    except Exception as e:
        print(f"[STARTUP] SQLite init error: {e}")
    # 2) InfluxDB — retry up to 10 attempts with 2 s delay
    for _attempt in range(10):
        try:
            ok = await asyncio.to_thread(influx.connect)
            print(f"[STARTUP] InfluxDB available={ok} err={influx.last_error}")
            if ok:
                break
        except Exception as e:
            print(f"[STARTUP] InfluxDB attempt {_attempt + 1} error: {e}")
        if _attempt < 9:
            await asyncio.sleep(2)
    # 3) Автозапуск коллектора
    try:
        async with SessionLocal() as s:
            settings = await s.get(CollectorSettings, 1)
        if settings and settings.autostart and settings.plc_ip:
            print(f"[STARTUP] autostart=ON, запускаю коллектор для {settings.plc_ip}")
            await collector.start()
        else:
            print("[STARTUP] autostart=OFF, коллектор не запущен")
    except Exception as e:
        print(f"[STARTUP] autostart error: {e}")
    asyncio.create_task(_plc_bg_reader())
    asyncio.create_task(_influx_reconnect_loop())
    yield
    # shutdown
    print("[SHUTDOWN] остановка…")
    shutdown_event.set()
    try:
        await collector.stop()
    except Exception as e:
        print(f"[SHUTDOWN] collector.stop error: {e}")
    try:
        await asyncio.to_thread(influx.close)
    except Exception:
        pass
    print("[SHUTDOWN] готово")


# ============================================================================
# AUTH
# ============================================================================

WEB_PASSWORD = os.environ.get("WEB_PASSWORD", "plcadmin")
_tokens: dict = {}  # token -> expiry datetime

def _issue_token() -> str:
    token = secrets.token_urlsafe(32)
    _tokens[token] = datetime.utcnow() + timedelta(hours=24)
    return token

def _valid_token(token: str) -> bool:
    exp = _tokens.get(token)
    if not exp:
        return False
    if datetime.utcnow() > exp:
        _tokens.pop(token, None)
        return False
    return True

_NO_AUTH = {"/", "/login", "/api/auth/login"}

class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if path in _NO_AUTH or path.startswith("/static/"):
            return await call_next(request)
        auth = request.headers.get("Authorization", "")
        token = auth.removeprefix("Bearer ").strip()
        if not token:
            # EventSource не может слать заголовки — принимаем токен из query param
            token = request.query_params.get("token", "")
        if not _valid_token(token):
            return JSONResponse({"detail": "Unauthorized"}, status_code=401)
        return await call_next(request)


class LoginRequest(BaseModel):
    password: str

app = FastAPI(lifespan=lifespan)
app.add_middleware(AuthMiddleware)

current_plc = None       # dedicated read connection (bg reader only)
_write_plc = None        # dedicated write connection (write_tag only)
_write_lock = asyncio.Lock()  # serializes concurrent writes
current_ip = None
current_slot = 0

# ── WebSocket broadcast ──────────────────────────────────────────────────────
_ws_queues: list = []  # asyncio.Queue per connected WS client

def _ws_broadcast(msg: dict) -> None:
    for q in list(_ws_queues):
        try:
            q.put_nowait(msg)
        except Exception:
            pass

def _plc_state_msg() -> dict:
    if not current_plc:
        return {"type": "connection_state", "status": "offline", "ip": None, "slot": None}
    return {"type": "connection_state", "status": "online", "ip": current_ip, "slot": current_slot}
all_tags_raw = []
tag_structure = {}
io_modules = []
last_update = None
_plc_lock = asyncio.Lock()   # kept for legacy; no longer used by bg reader
_tags_cache = None            # последний успешный ответ /api/tags
_io_cache = None              # последний успешный ответ /api/io

_emulator_mode = False
_emulator_values: dict = {}
_emulator_task: asyncio.Task = None

class _EmulatorPLC:
    """Sentinel object that replaces real PLC when emulator is active."""
    def Close(self): pass

TIMER_FIELDS = [
    {'name': 'PRE', 'type': 'DINT', 'desc': 'Предустановка'},
    {'name': 'ACC', 'type': 'DINT', 'desc': 'Накопленное'},
    {'name': 'EN',  'type': 'BOOL', 'desc': 'Включён'},
    {'name': 'TT',  'type': 'BOOL', 'desc': 'Идёт отсчёт'},
    {'name': 'DN',  'type': 'BOOL', 'desc': 'Выполнен'}
]
COUNTER_FIELDS = [
    {'name': 'PRE', 'type': 'DINT', 'desc': 'Предустановка'},
    {'name': 'ACC', 'type': 'DINT', 'desc': 'Накопленное'},
    {'name': 'CU',  'type': 'BOOL', 'desc': 'Счёт вверх'},
    {'name': 'CD',  'type': 'BOOL', 'desc': 'Счёт вниз'},
    {'name': 'DN',  'type': 'BOOL', 'desc': 'Выполнен'},
    {'name': 'OV',  'type': 'BOOL', 'desc': 'Переполнение'},
    {'name': 'UN',  'type': 'BOOL', 'desc': 'Переполнение вниз'}
]

INT_BITS = {
    'SINT': 8,
    'INT': 16,
    'DINT': 32,
    'LINT': 64
}

class PLCConnectRequest(BaseModel):
    ip: str
    slot: int = 0

class WriteTagRequest(BaseModel):
    tag: str
    value: str

def load_history():
    if os.path.exists(HISTORY_FILE):
        try:
            with open(HISTORY_FILE, 'r') as f:
                return json.load(f)
        except:
            return []
    return []

def save_history(history):
    with open(HISTORY_FILE, 'w') as f:
        json.dump(history, f, indent=2, ensure_ascii=False)

def add_to_history(ip: str, slot: int, status: str):
    history = load_history()
    history = [h for h in history if not (h.get('ip') == ip and h.get('slot') == slot)]
    history.insert(0, {
        "ip": ip, "slot": slot, "status": status,
        "timestamp": datetime.now().isoformat()
    })
    history = history[:10]
    save_history(history)

def get_tag_category(data_type: str, is_array: bool = False) -> str:
    """Определить категорию тега"""
    dt = str(data_type).upper().strip()
    
    if is_array:
        # Массивы выделяем в отдельные категории по базовому типу
        if dt == 'BOOL': return 'BOOL_ARRAY'
        if dt == 'SINT': return 'SINT_ARRAY'
        if dt == 'INT': return 'INT_ARRAY'
        if dt == 'DINT': return 'DINT_ARRAY'
        if dt == 'LINT': return 'LINT_ARRAY'
        if dt == 'REAL': return 'REAL_ARRAY'
        if dt == 'STRING': return 'STRING_ARRAY'
        if dt == 'TIMER': return 'TIMER_ARRAY'
        if dt == 'COUNTER': return 'COUNTER_ARRAY'
        return 'UDT_ARRAY'
    
    if dt == 'BOOL': return 'BOOL'
    if dt == 'SINT': return 'SINT'
    if dt == 'INT': return 'INT'
    if dt == 'DINT': return 'DINT'
    if dt == 'LINT': return 'LINT'
    if dt == 'REAL': return 'REAL'
    if dt == 'STRING': return 'STRING'
    if dt == 'TIMER': return 'TIMER'
    if dt == 'COUNTER': return 'COUNTER'
    if 'EMBEDDED' in dt or 'DISCRETEIO' in dt: return 'IO'
    if '_' in dt and ':' in dt: return 'MODULE'
    return 'UDT'

def is_integer_type(data_type: str) -> bool:
    return str(data_type).upper().strip() in INT_BITS

def format_value(val, data_type=""):
    if val is None:
        return "N/A"
    dt = str(data_type).upper().strip()
    if isinstance(val, bytes):
        if dt == 'STRING':
            try:
                return val.decode('utf-8', errors='ignore').rstrip('\x00')
            except:
                return f"<{len(val)} bytes>"
        return f"<{len(val)} bytes>"
    if isinstance(val, bool):
        return "1" if val else "0"
    if dt == 'REAL' and isinstance(val, (int, float)):
        return f"{float(val):.4f}"
    return str(val)

def format_hex(val, bits):
    try:
        int_val = int(val)
        if int_val < 0:
            int_val = (1 << bits) + int_val
        digits = bits // 4
        return f"0x{int_val:0{digits}X}"
    except:
        return "0x0"

def get_bits(val, num_bits):
    try:
        int_val = int(val)
        if int_val < 0:
            int_val = (1 << num_bits) + int_val
        return [(int_val >> i) & 1 for i in range(num_bits)]
    except:
        return [0] * num_bits

def _fields_from_udt(plc, udt_obj, tag_name: str, depth: int = 0) -> list:
    if depth > 3:
        return []
    members = []
    udt_by_name = getattr(plc, 'UDTByName', {})
    for field in getattr(udt_obj, 'Fields', []):
        fname = getattr(field, 'TagName', '')
        if not fname or fname.startswith('__'):
            continue
        if getattr(field, 'Internal', False):
            continue
        full_name = f"{tag_name}.{fname}"
        rel_name = full_name[len(tag_name) + 1:]
        ftype = str(getattr(field, 'DataType', None) or 'DINT').upper()
        is_struct = bool(getattr(field, 'Struct', 0))
        if is_struct and ftype in udt_by_name and depth < 3:
            nested = _fields_from_udt(plc, udt_by_name[ftype], full_name, depth + 1)
            if nested:
                members.extend(nested)
                continue
        members.append({'name': full_name, 'display_name': rel_name, 'type': ftype})
    return members

def _py_to_plc_type(val) -> str:
    if isinstance(val, bool):            return 'BOOL'
    if isinstance(val, int):             return 'DINT'
    if isinstance(val, float):           return 'REAL'
    if isinstance(val, (str, bytes)):    return 'STRING'
    return 'DINT'

def _flatten_udt_dict(d: dict, prefix: str, base: str, depth: int = 0) -> list:
    members = []
    if depth > 5: return members
    for key, val in d.items():
        full_name = f"{prefix}.{key}"
        rel_name = full_name[len(base) + 1:]
        if isinstance(val, dict):
            members.extend(_flatten_udt_dict(val, full_name, base, depth + 1))
        else:
            members.append({
                'name': full_name,
                'display_name': rel_name,
                'type': _py_to_plc_type(val),
            })
    return members

def enumerate_udt_members(plc, tag_name: str, udt_type_name: str = '') -> list:
    udt_by_name = getattr(plc, 'UDTByName', {})
    if udt_type_name and udt_type_name in udt_by_name:
        members = _fields_from_udt(plc, udt_by_name[udt_type_name], tag_name)
        if members:
            print(f"[UDT] {tag_name} ({udt_type_name}): {len(members)} членов из шаблона")
            return members
    try:
        r = plc.Read(tag_name)
        val = getattr(r, 'Value', None)
        if getattr(r, 'Status', '') == "Success" and isinstance(val, dict) and val:
            return _flatten_udt_dict(val, tag_name, tag_name)
    except Exception as e:
        print(f"[WARN] UDT read {tag_name}: {e}")
    return []


@app.get("/")
async def root():
    return FileResponse(f"{STATIC_DIR}/index.html")

@app.get("/login")
async def login_page():
    return FileResponse(f"{STATIC_DIR}/login.html")

@app.post("/api/auth/login")
async def auth_login(body: LoginRequest):
    if body.password != WEB_PASSWORD:
        raise HTTPException(status_code=401, detail="Invalid password")
    return {"token": _issue_token()}

@app.get("/api/auth/check")
async def auth_check():
    return {"ok": True}


@app.post("/api/system/quit")
async def system_quit(background_tasks: BackgroundTasks):
    async def do_quit():
        await asyncio.sleep(0.3)
        subprocess.run(["pkill", "-f", "chromium.*localhost:5000"], capture_output=True)
        subprocess.run(["pkill", "-f", "plc_app.py"], capture_output=True)
    background_tasks.add_task(do_quit)
    return {"status": "closing"}


_REPO_DIR = os.path.dirname(os.path.abspath(__file__))

@app.get("/api/update/check")
async def update_check():
    try:
        local = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=_REPO_DIR, text=True, timeout=5
        ).strip()
        current_msg = subprocess.check_output(
            ["git", "log", "-1", "--pretty=%s"], cwd=_REPO_DIR, text=True, timeout=5
        ).strip()
        subprocess.run(
            ["git", "fetch", "--quiet"], cwd=_REPO_DIR, timeout=15,
            capture_output=True
        )
        remote = subprocess.check_output(
            ["git", "rev-parse", "origin/main"], cwd=_REPO_DIR, text=True, timeout=5
        ).strip()
        behind = int(subprocess.check_output(
            ["git", "rev-list", "--count", f"HEAD..origin/main"],
            cwd=_REPO_DIR, text=True, timeout=5
        ).strip())
        new_msg = ""
        if local != remote:
            new_msg = subprocess.check_output(
                ["git", "log", "-1", "--pretty=%s", "origin/main"],
                cwd=_REPO_DIR, text=True, timeout=5
            ).strip()
        return {
            "current_hash": local[:7],
            "current_msg": current_msg,
            "update_available": local != remote,
            "commits_behind": behind,
            "new_msg": new_msg,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/update/apply")
async def update_apply(background_tasks: BackgroundTasks):
    async def do_update():
        await asyncio.sleep(0.4)
        subprocess.run(["git", "pull", "--ff-only"], cwd=_REPO_DIR, timeout=60)
        pip_path = os.path.join(os.path.dirname(sys.executable), "pip")
        subprocess.run(
            [pip_path, "install", "-q", "-r", os.path.join(_REPO_DIR, "requirements.txt")],
            timeout=120,
        )
        os.kill(os.getpid(), signal.SIGTERM)

    background_tasks.add_task(do_update)
    return {"status": "updating"}


@app.post("/api/connect")
async def connect(request: PLCConnectRequest):
    global current_plc, _write_plc, current_ip, current_slot, all_tags_raw, tag_structure, io_modules, _tags_cache, _io_cache, _emulator_mode
    _emulator_mode = False
    _tags_cache = None
    _io_cache = None

    ip = request.ip.strip()
    slot = request.slot

    if not ip:
        raise HTTPException(status_code=400, detail="IP address cannot be empty")

    try:
        if current_plc and not isinstance(current_plc, _EmulatorPLC):
            try:
                current_plc.Close()
            except:
                pass
        if _write_plc and not isinstance(_write_plc, _EmulatorPLC):
            try:
                _write_plc.Close()
            except:
                pass

        print(f"[CONNECT] {ip} slot={slot}")
        plc = PLC(ip, timeout=5)
        plc.ProcessorSlot = slot
        
        response = plc.GetTagList()
        
        all_tags_raw = []
        tag_structure = {
            'BOOL': [], 'SINT': [], 'INT': [], 'DINT': [], 'LINT': [],
            'REAL': [], 'STRING': [], 'TIMER': [], 'COUNTER': [],
            'BOOL_ARRAY': [], 'SINT_ARRAY': [], 'INT_ARRAY': [], 
            'DINT_ARRAY': [], 'LINT_ARRAY': [], 'REAL_ARRAY': [],
            'STRING_ARRAY': [], 'TIMER_ARRAY': [], 'COUNTER_ARRAY': [], 
            'UDT_ARRAY': [],
            'UDT': [], 'IO': [], 'MODULE': []
        }
        
        if response.Value:
            for tag in response.Value:
                try:
                    tag_name = tag.TagName if hasattr(tag, 'TagName') else str(tag)
                    data_type = str(tag.DataType) if hasattr(tag, 'DataType') else "Unknown"
                    array_dim = getattr(tag, 'Array', 0) or 0
                    array_size = getattr(tag, 'Size', 0) or 0
                    
                    is_array = array_dim > 0 and array_size > 0
                    category = get_tag_category(data_type, is_array)
                    
                    if is_array:
                        # МАССИВ - создаем элементы [0], [1], [2]...
                        elements = []
                        for i in range(array_size):
                            elem_name = f"{tag_name}[{i}]"
                            elements.append({
                                'name': elem_name,
                                'index': i,
                                'type': data_type
                            })
                            all_tags_raw.append({'name': elem_name, 'type': data_type})
                        
                        tag_structure[category].append({
                            'name': tag_name,
                            'type': data_type,
                            'is_array': True,
                            'array_size': array_size,
                            'elements': elements
                        })
                    elif category == 'TIMER':
                        for f in TIMER_FIELDS:
                            field_name = f"{tag_name}.{f['name']}"
                            all_tags_raw.append({'name': field_name, 'type': f['type']})
                        tag_structure[category].append({
                            'name': tag_name, 'type': 'TIMER',
                            'fields': TIMER_FIELDS
                        })
                    elif category == 'COUNTER':
                        for f in COUNTER_FIELDS:
                            field_name = f"{tag_name}.{f['name']}"
                            all_tags_raw.append({'name': field_name, 'type': f['type']})
                        tag_structure[category].append({
                            'name': tag_name, 'type': 'COUNTER',
                            'fields': COUNTER_FIELDS
                        })
                    else:
                        all_tags_raw.append({'name': tag_name, 'type': data_type})
                        tag_structure[category].append({
                            'name': tag_name, 'type': data_type
                        })
                except Exception as e:
                    print(f"[WARN] tag error: {e}")
            
            total = sum(len(t) for t in tag_structure.values())
            print(f"[CONNECT] Тегов: {total}")
        
        if not all_tags_raw:
            add_to_history(ip, slot, "failed - no tags")
            raise HTTPException(status_code=400, detail="Failed to retrieve tags")
        
        # Сканируем I/O модули из известных MODULE тегов
        print(f"[CONNECT] Сканирую I/O модули...")
        io_modules = scan_io_modules(plc, tag_structure)
        print(f"[CONNECT] Найдено I/O модулей: {len(io_modules)}")
        
        # Enumerate UDT members for recipe support (limit to first 30 to stay fast)
        udt_list = tag_structure.get('UDT', [])
        print(f"[CONNECT] Читаю структуру {min(len(udt_list), 30)} UDT тегов...")
        for udt_tag in udt_list[:30]:
            members = enumerate_udt_members(plc, udt_tag['name'], udt_tag.get('type', ''))
            if members:
                udt_tag['fields'] = members
                for m in members:
                    all_tags_raw.append({'name': m['name'], 'type': m['type']})
                print(f"[CONNECT]   {udt_tag['name']}: {len(members)} членов")

        current_plc = plc
        # Separate write connection — independent TCP socket, no lock contention
        write_plc = PLC(ip, timeout=5)
        write_plc.ProcessorSlot = slot
        _write_plc = write_plc
        current_ip = ip
        current_slot = slot

        add_to_history(ip, slot, "success")
        _ws_broadcast(_plc_state_msg())

        return {
            "status": "connected",
            "ip": ip, "slot": slot,
            "tag_count": sum(len(t) for t in tag_structure.values()),
            "io_count": len(io_modules)
        }
        
    except HTTPException:
        raise
    except Exception as e:
        error_str = str(e)
        print(f"[ERROR] {error_str}")
        add_to_history(ip, slot, f"error - {error_str[:80]}")
        raise HTTPException(status_code=400, detail=f"Error: {error_str}")

@app.post("/api/disconnect")
async def disconnect():
    global current_plc, _write_plc, current_ip, current_slot, all_tags_raw, tag_structure, io_modules, _emulator_mode, _tags_cache, _io_cache

    _emulator_mode = False
    if current_plc and not isinstance(current_plc, _EmulatorPLC):
        try:
            current_plc.Close()
        except:
            pass
    if _write_plc and not isinstance(_write_plc, _EmulatorPLC):
        try:
            _write_plc.Close()
        except:
            pass
    current_plc = None
    _write_plc = None
    current_ip = None
    current_slot = 0
    all_tags_raw = []
    tag_structure = {}
    io_modules = []
    _tags_cache = None
    _io_cache = None

    _ws_broadcast(_plc_state_msg())
    return {"status": "disconnected"}

@app.post("/api/emulator/connect")
async def emulator_connect():
    global current_plc, _write_plc, current_ip, current_slot
    global all_tags_raw, tag_structure, io_modules
    global _emulator_mode, _emulator_values, _tags_cache, _io_cache

    # Close any real PLC connection first
    _emulator_mode = False
    if current_plc and not isinstance(current_plc, _EmulatorPLC):
        try: current_plc.Close()
        except: pass
    if _write_plc and not isinstance(_write_plc, _EmulatorPLC):
        try: _write_plc.Close()
        except: pass

    tag_structure = {
        'BOOL': [{'name': 'EMU_BOOL', 'type': 'BOOL'}],
        'DINT': [{'name': 'EMU_DINT', 'type': 'DINT'}],
        'REAL': [{'name': 'EMU_REAL', 'type': 'REAL'}],
        'SINT': [], 'INT': [], 'LINT': [], 'STRING': [], 'TIMER': [], 'COUNTER': [],
        'BOOL_ARRAY': [], 'SINT_ARRAY': [], 'INT_ARRAY': [],
        'DINT_ARRAY': [], 'LINT_ARRAY': [], 'REAL_ARRAY': [],
        'STRING_ARRAY': [], 'TIMER_ARRAY': [], 'COUNTER_ARRAY': [],
        'UDT_ARRAY': [], 'UDT': [], 'IO': [], 'MODULE': []
    }
    all_tags_raw = [
        {'name': 'EMU_BOOL', 'type': 'BOOL'},
        {'name': 'EMU_DINT', 'type': 'DINT'},
        {'name': 'EMU_REAL', 'type': 'REAL'},
    ]
    _emulator_values = {'EMU_BOOL': 0, 'EMU_DINT': 0, 'EMU_REAL': 0.0}
    io_modules = []
    current_plc = _EmulatorPLC()
    _write_plc = _EmulatorPLC()
    current_ip = "EMULATOR"
    current_slot = 0
    _tags_cache = None
    _io_cache = []

    global _emulator_task
    _emulator_mode = True
    if _emulator_task and not _emulator_task.done():
        _emulator_task.cancel()
    _emulator_task = asyncio.create_task(_emulator_bg_tick())
    _ws_broadcast(_plc_state_msg())

    return {
        "status": "connected",
        "ip": "EMULATOR",
        "slot": 0,
        "tag_count": 3,
        "io_count": 0,
    }

def parse_channel_count(dtype: str) -> int:
    """Extract channel count from AB module type. AB:5000_DI16:I:0 → 16"""
    import re
    # Match only standard AB channel-count suffixes: DI16, DO16, AI8, AO4, IB16, OB16, etc.
    m = re.search(r'(?:DI|DO|AI|AO|IB|OB|IV|OV)(\d{1,3})(?:[^0-9]|$)', dtype.upper())
    if m:
        n = int(m.group(1))
        if 1 <= n <= 128:
            return n
    return 1

def get_channel_tags_and_values(plc, base_tag: str, ch_count: int):
    """Read per-channel values; return (values, tag_per_channel).

    Tries in order:
      1. PtXX.Data  — AB 5069/5000 series
      2. .Data DINT bitmask
      3. .0 .1 ... individual bit members
    """
    # Pattern 1: Pt00.Data ... Pt(N-1).Data
    r0 = plc.Read(f"{base_tag}.Pt00.Data")
    if r0.Status == "Success":
        vals = []
        tags = []
        for i in range(ch_count):
            tag = f"{base_tag}.Pt{i:02d}.Data"
            r = plc.Read(tag)
            tags.append(tag)
            vals.append((1 if r.Value else 0) if r.Status == "Success" and r.Value is not None else None)
        return vals, tags

    default_tags = [f"{base_tag}.{i}" for i in range(ch_count)]

    # Pattern 2: .Data as DINT bitmask
    try:
        r = plc.Read(f"{base_tag}.Data")
        if r.Status == "Success" and r.Value is not None and isinstance(r.Value, (int, bool)):
            int_val = int(r.Value)
            if int_val < 0:
                int_val = (1 << 32) + int_val
            return [(int_val >> i) & 1 for i in range(ch_count)], default_tags
    except Exception:
        pass

    # Pattern 3: individual bit members
    vals = []
    any_ok = False
    for i in range(ch_count):
        try:
            r = plc.Read(f"{base_tag}.{i}")
            if r.Status == "Success" and r.Value is not None:
                vals.append(1 if r.Value else 0)
                any_ok = True
                continue
        except Exception:
            pass
        vals.append(None)
    return vals if any_ok else [None] * ch_count, default_tags

def scan_io_modules(plc, tag_structure: dict):
    """Build I/O module list from known MODULE/IO tags in tag_structure."""
    import re
    groups = {}   # prefix → module dict

    for cat in ('MODULE', 'IO'):
        for tag in tag_structure.get(cat, []):
            name = tag['name']
            dtype = tag.get('type', '')
            # Match: Local:4:O  or  GC_1000:I1  or  Local:1:I
            m = re.match(r'^(.+):([IOC])(\d*)$', name)
            if not m:
                continue
            prefix, dir_char, suffix = m.groups()
            if dir_char == 'C':
                continue  # config assembly, skip

            if prefix not in groups:
                slot_m = re.search(r'(\d+)$', prefix)
                groups[prefix] = {
                    'slot': int(slot_m.group(1)) if slot_m else 0,
                    'name': prefix,
                    'has_input': False, 'has_output': False,
                    'inputs': [], 'outputs': [],
                    'analog_inputs': [], 'analog_outputs': [],
                }

            mod = groups[prefix]
            ch_count = parse_channel_count(dtype)
            tag_full = name  # e.g. Local:1:I

            if dir_char == 'I':
                # Skip diagnostic feedback assemblies of output modules
                # (AB:5000_DO16_Diag:I:0 → these are faults, not real inputs)
                if 'DO' in dtype.upper() and 'DIAG' in dtype.upper():
                    continue
                mod['has_input'] = True
                mod['input_type'] = dtype
                values, ch_tags = get_channel_tags_and_values(plc, tag_full, ch_count)
                mod['inputs'] = [
                    {'channel': i, 'tag': ch_tags[i], 'value': values[i]}
                    for i in range(ch_count)
                ]

            elif dir_char == 'O':
                mod['has_output'] = True
                mod['output_type'] = dtype
                values, ch_tags = get_channel_tags_and_values(plc, tag_full, ch_count)
                mod['outputs'] = [
                    {'channel': i, 'tag': ch_tags[i], 'value': values[i]}
                    for i in range(ch_count)
                ]

    result = [m for m in groups.values() if m['has_input'] or m['has_output']]
    result.sort(key=lambda m: (m['slot'], m['name']))
    return result

# ── background PLC reader ──────────────────────────────────────────────────

def _sync_batch_read_tags():
    """Читает все теги одним batch-вызовом pylogix."""
    if not all_tags_raw:
        return {}
    names = [t['name'] for t in all_tags_raw]
    try:
        resp = current_plc.Read(names) if len(names) > 1 else [current_plc.Read(names[0])]
        if not isinstance(resp, list):
            resp = [resp]
        return {names[i]: (resp[i].Value if i < len(resp) and hasattr(resp[i], 'Value') else None)
                for i in range(len(names))}
    except Exception as e:
        print(f"[BG] batch read tags: {e}")
        return {}

def _sync_batch_read_io():
    """Читает все IO-каналы одним batch-вызовом pylogix."""
    tasks = []
    for module in io_modules:
        for ch in module.get('inputs', []) + module.get('outputs', []):
            tasks.append((ch, False))
        for ch in module.get('analog_inputs', []) + module.get('analog_outputs', []):
            tasks.append((ch, True))
    if not tasks:
        return
    tags = [t[0]['tag'] for t in tasks]
    try:
        resp = current_plc.Read(tags) if len(tags) > 1 else [current_plc.Read(tags[0])]
        if not isinstance(resp, list):
            resp = [resp]
        for i, (ch, is_analog) in enumerate(tasks):
            if i < len(resp) and hasattr(resp[i], 'Value') and resp[i].Value is not None:
                ch['value'] = float(resp[i].Value) if is_analog else (1 if resp[i].Value else 0)
    except Exception as e:
        print(f"[BG] batch read io: {e}")

def _build_tags_result(tag_values):
    """Строит структурированный результат из сырых значений (без обращения к PLC)."""
    result = {}
    for category, tags in tag_structure.items():
        result[category] = []
        for tag in tags:
            tag_name = tag['name']
            if tag.get('is_array'):
                elements = []
                for elem in tag['elements']:
                    elem_value = tag_values.get(elem['name'])
                    elem_data = {
                        'name': elem['name'], 'index': elem['index'],
                        'display_name': f"[{elem['index']}]",
                        'type': elem['type'], 'value': format_value(elem_value, elem['type'])
                    }
                    if is_integer_type(elem['type']):
                        bits = INT_BITS[elem['type']]
                        elem_data['hex'] = format_hex(elem_value, bits)
                        elem_data['bits'] = get_bits(elem_value, bits)
                        elem_data['num_bits'] = bits
                    elements.append(elem_data)
                result[category].append({
                    'name': tag_name, 'type': tag['type'], 'is_array': True,
                    'array_size': tag['array_size'],
                    'value': f"[{tag['array_size']} elements]", 'elements': elements
                })
            else:
                main_value = tag_values.get(tag_name)
                tag_result = {
                    'name': tag_name, 'type': tag['type'],
                    'value': format_value(main_value, tag['type'])
                }
                if is_integer_type(tag['type']):
                    bits = INT_BITS[tag['type']]
                    tag_result['hex'] = format_hex(main_value, bits)
                    tag_result['bits'] = get_bits(main_value, bits)
                    tag_result['num_bits'] = bits
                if tag.get('fields'):
                    fields = []
                    for f in tag['fields']:
                        field_name = f['name'] if f['name'].startswith(tag_name + '.') else f"{tag_name}.{f['name']}"
                        fv = tag_values.get(field_name)
                        fields.append({
                            'name': field_name,
                            'display_name': f.get('display_name', f['name']),
                            'desc': f.get('desc', ''),
                            'type': f['type'], 'value': format_value(fv, f['type'])
                        })
                    tag_result['fields'] = fields
                result[category].append(tag_result)
    return result

async def _influx_reconnect_loop():
    """Раз в 30 с пробует переподключиться к InfluxDB если недоступен."""
    while not (shutdown_event and shutdown_event.is_set()):
        await asyncio.sleep(30)
        if not influx.available:
            try:
                ok = await asyncio.to_thread(influx.connect)
                if ok:
                    print("[INFLUX] переподключение успешно")
            except Exception as e:
                print(f"[INFLUX] переподключение не удалось: {e}")


async def _plc_bg_reader():
    """Фоновый task: batch-читает теги и IO каждые 500 мс, кладёт в кэш."""
    global _tags_cache, _io_cache, last_update
    while not (shutdown_event and shutdown_event.is_set()):
        if _emulator_mode:
            await asyncio.sleep(0.5)
            continue
        if current_plc and all_tags_raw:
            try:
                raw = await asyncio.to_thread(_sync_batch_read_tags)
                if raw:
                    ts = datetime.now().isoformat()
                    _tags_cache = {"tags": _build_tags_result(raw), "last_update": ts}
                    last_update = ts
            except Exception as e:
                print(f"[BG] tags: {e}")
            try:
                await asyncio.to_thread(_sync_batch_read_io)
                _io_cache = io_modules
            except Exception as e:
                print(f"[BG] io: {e}")
        await asyncio.sleep(0.5)

async def _emulator_bg_tick():
    """Генерирует синтетические значения тегов в режиме эмулятора."""
    global _tags_cache, _io_cache, _emulator_values, last_update
    tick = 0
    bool_state = 0
    dint_val = 0
    dint_dir = 1
    real_val = 0.0
    real_dir = 1
    while _emulator_mode and not (shutdown_event and shutdown_event.is_set()):
        tick += 1
        if tick % 10 == 0:
            bool_state = 1 - bool_state
        dint_val += dint_dir
        if dint_val >= 100:
            dint_dir = -1
        elif dint_val <= 0:
            dint_dir = 1
        real_val = round(real_val + real_dir * 0.25, 2)
        if real_val >= 100.0:
            real_dir = -1
        elif real_val <= 0.0:
            real_dir = 1
        _emulator_values = {
            'EMU_BOOL': bool_state,
            'EMU_DINT': dint_val,
            'EMU_REAL': real_val,
        }
        ts = datetime.now().isoformat()
        _tags_cache = {"tags": _build_tags_result(_emulator_values), "last_update": ts}
        _io_cache = []
        last_update = ts
        if influx.available:
            ts_dt = datetime.utcnow()
            for _tag, _val in _emulator_values.items():
                await asyncio.to_thread(
                    influx.write_point, _tag, _val, "EMULATOR", "on_change", ts_dt
                )
        await asyncio.sleep(0.1)

@app.get("/api/tags")
async def get_tags():
    if not current_plc:
        raise HTTPException(status_code=400, detail="No PLC connection")
    if _tags_cache is None:
        raise HTTPException(status_code=503, detail="Loading data…")
    return _tags_cache

@app.get("/api/io")
async def get_io():
    if not current_plc:
        raise HTTPException(status_code=400, detail="No PLC connection")
    return _io_cache if _io_cache is not None else []

@app.post("/api/write")
async def write_tag(request: WriteTagRequest):
    plc = _write_plc or current_plc
    if not plc:
        raise HTTPException(status_code=400, detail="No PLC connection")

    try:
        tag_name = request.tag.strip()
        tag_value = request.value.strip()

        value = None
        try:
            if '.' in tag_value:
                value = float(tag_value)
            else:
                value = int(tag_value)
        except ValueError:
            if tag_value.lower() in ['true', '1', 'yes', 'on']:
                value = True
            elif tag_value.lower() in ['false', '0', 'no', 'off']:
                value = False
            else:
                value = tag_value

        if _emulator_mode:
            _emulator_values[tag_name] = value
            return {"status": "success", "tag": tag_name, "value": str(value)}

        async with _write_lock:
            response = await asyncio.to_thread(plc.Write, tag_name, value)

        if hasattr(response, 'Status') and response.Status == "Success":
            return {"status": "success", "tag": tag_name, "value": str(value)}
        else:
            status = response.Status if hasattr(response, 'Status') else "Unknown"
            raise HTTPException(status_code=400, detail=f"Write error: {status}")

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Error: {str(e)}")

@app.post("/api/tags/write")
async def write_tag_v2(request: WriteTagRequest):
    return await write_tag(request)

@app.get("/api/status")
async def get_status():
    global current_plc, current_ip, current_slot, all_tags_raw, last_update
    
    if not current_plc:
        return {"status": "offline", "ip": None, "slot": None}

    if _emulator_mode:
        return {"status": "online", "ip": current_ip, "slot": current_slot, "last_update": last_update}

    try:
        if all_tags_raw:
            current_plc.Read(all_tags_raw[0]['name'])
        return {"status": "online", "ip": current_ip, "slot": current_slot, "last_update": last_update}
    except:
        return {"status": "error", "ip": current_ip, "slot": current_slot}

@app.get("/api/history")
async def get_history():
    return load_history()


@app.get("/api/tags/list")
async def get_tags_list():
    """
    Только имена и типы тегов из кэша после /api/connect (без чтения значений с ПЛК).
    Используется UI «Сбор данных» для модалки добавления тегов.
    """
    global all_tags_raw, current_plc
    if not current_plc:
        raise HTTPException(status_code=400, detail="No PLC connection")
    return {"tags": all_tags_raw, "count": len(all_tags_raw)}


# ============================================================================
# НОВОЕ: Конфигурация тегов для сбора
# ============================================================================

@app.get("/api/config/tags", response_model=List[TagConfigOut])
async def cfg_get_tags():
    async with SessionLocal() as s:
        res = await s.execute(select(TagConfig).order_by(TagConfig.tag_name))
        return list(res.scalars().all())


@app.post("/api/config/tags/save")
async def cfg_save_tags(req: SaveTagsRequest):
    async with SessionLocal() as s:
        if req.replace_all:
            await s.execute(delete(TagConfig))
            await s.commit()
        for t in req.tags:
            existing = (await s.execute(
                select(TagConfig).where(TagConfig.tag_name == t.tag_name)
            )).scalar_one_or_none()
            if existing:
                existing.tag_type = t.tag_type
                existing.update_mode = t.update_mode
                existing.interval_sec = t.interval_sec
                existing.deadband = t.deadband
                existing.enabled = t.enabled
                existing.description = t.description
            else:
                s.add(TagConfig(
                    tag_name=t.tag_name,
                    tag_type=t.tag_type,
                    update_mode=t.update_mode,
                    interval_sec=t.interval_sec,
                    deadband=t.deadband,
                    enabled=t.enabled,
                    description=t.description,
                ))
        await s.commit()
    return {"status": "ok", "count": len(req.tags)}


@app.delete("/api/config/tags/{tag_name:path}")
async def cfg_delete_tag(tag_name: str):
    async with SessionLocal() as s:
        result = await s.execute(delete(TagConfig).where(TagConfig.tag_name == tag_name))
        await s.commit()
        return {"status": "ok", "removed": result.rowcount}


# ============================================================================
# НОВОЕ: Настройки и управление коллектором
# ============================================================================

@app.get("/api/collector/settings", response_model=CollectorSettingsModel)
async def coll_get_settings():
    async with SessionLocal() as s:
        row = await s.get(CollectorSettings, 1)
        if row is None:
            row = CollectorSettings(id=1)
            s.add(row)
            await s.commit()
        return CollectorSettingsModel(
            autostart=row.autostart,
            poll_interval_ms=row.poll_interval_ms,
            plc_ip=row.plc_ip,
            plc_slot=row.plc_slot,
        )


@app.post("/api/collector/settings", response_model=CollectorSettingsModel)
async def coll_save_settings(payload: CollectorSettingsModel):
    async with SessionLocal() as s:
        row = await s.get(CollectorSettings, 1)
        if row is None:
            row = CollectorSettings(id=1)
            s.add(row)
        row.autostart = int(payload.autostart)
        row.poll_interval_ms = int(payload.poll_interval_ms)
        row.plc_ip = payload.plc_ip
        row.plc_slot = int(payload.plc_slot)
        await s.commit()
    return payload


@app.get("/api/collector/status", response_model=CollectorStatus)
async def coll_status():
    return CollectorStatus(**collector.stats())


@app.post("/api/collector/start")
async def coll_start():
    res = await collector.start()
    return res


@app.post("/api/collector/stop")
async def coll_stop():
    res = await collector.stop()
    return res


# ============================================================================
# App-wide settings
# ============================================================================

@app.get("/api/settings")
async def get_settings():
    async with SessionLocal() as s:
        coll = await s.get(CollectorSettings, 1)
        ollama_row = await s.get(AppSettings, "ollama_url")
        model_row  = await s.get(AppSettings, "ai_model")
    return {
        "plc_ip":          coll.plc_ip if coll else None,
        "plc_slot":        coll.plc_slot if coll else 0,
        "poll_interval_ms": coll.poll_interval_ms if coll else 100,
        "autostart":       bool(coll.autostart) if coll else False,
        "ollama_url":      (ollama_row.value if ollama_row and ollama_row.value else None) or OLLAMA_URL,
        "ai_model":        (model_row.value if model_row and model_row.value else None) or AI_MODEL,
    }


@app.post("/api/settings")
async def save_settings(payload: dict):
    async with SessionLocal() as s:
        coll = await s.get(CollectorSettings, 1)
        if coll is None:
            coll = CollectorSettings(id=1)
            s.add(coll)
        if "plc_ip" in payload:
            coll.plc_ip = payload["plc_ip"] or None
        if "plc_slot" in payload:
            coll.plc_slot = int(payload["plc_slot"])
        if "poll_interval_ms" in payload:
            coll.poll_interval_ms = max(50, min(10000, int(payload["poll_interval_ms"])))
        if "autostart" in payload:
            coll.autostart = 1 if payload["autostart"] else 0
        for key in ("ollama_url", "ai_model"):
            if key in payload:
                row = await s.get(AppSettings, key)
                if row is None:
                    row = AppSettings(key=key)
                    s.add(row)
                row.value = payload[key] or None
        await s.commit()
    return {"status": "ok"}


@app.get("/api/db/stats")
async def db_stats():
    async with SessionLocal() as s:
        res = await s.execute(select(TagConfig))
        tags_configured = len(list(res.scalars().all()))
    summary = await asyncio.to_thread(influx.db_summary)
    summary["tags_configured"] = tags_configured
    return summary


# ============================================================================
# НОВОЕ: Данные из InfluxDB
# ============================================================================

@app.get("/api/data/tags")
async def data_list_tags():
    tags = await asyncio.to_thread(influx.list_tags_with_data)
    return {"tags": tags, "available": influx.available, "error": influx.last_error}


@app.get("/api/data/{tag_name:path}/history")
async def data_history(
    tag_name: str,
    frm: str = Query("-1h", alias="from"),
    to: str = Query("now()"),
    bucket: str = Query("raw"),
    agg: Optional[str] = Query(None),
    max_points: int = Query(2000, ge=10, le=10000),
):
    points = await asyncio.to_thread(
        influx.query_history, tag_name, frm, to, bucket, agg, max_points
    )
    return {"tag_name": tag_name, "points": points, "available": influx.available}


@app.get("/api/data/{tag_name:path}/stats")
async def data_stats(
    tag_name: str,
    frm: str = Query("-1h", alias="from"),
    to: str = Query("now()"),
):
    stats = await asyncio.to_thread(influx.stats, tag_name, frm, to)
    return {"tag_name": tag_name, "stats": stats, "available": influx.available}


# ============================================================================
# НОВОЕ: Дашборды
# ============================================================================

@app.get("/api/dashboard", response_model=List[DashboardOut])
async def dash_list():
    async with SessionLocal() as s:
        res = await s.execute(select(Dashboard).order_by(Dashboard.id))
        return list(res.scalars().all())


@app.post("/api/dashboard", response_model=DashboardOut)
async def dash_create(payload: DashboardIn):
    async with SessionLocal() as s:
        d = Dashboard(name=payload.name, created_at=datetime.utcnow())
        s.add(d)
        await s.commit()
        await s.refresh(d)
        return d


@app.get("/api/dashboard/{dash_id}", response_model=DashboardOut)
async def dash_get(dash_id: int):
    async with SessionLocal() as s:
        d = await s.get(Dashboard, dash_id)
        if d is None:
            raise HTTPException(status_code=404, detail="Dashboard not found")
        return d


@app.put("/api/dashboard/{dash_id}", response_model=DashboardOut)
async def dash_update(dash_id: int, payload: DashboardUpdate):
    async with SessionLocal() as s:
        d = await s.get(Dashboard, dash_id)
        if d is None:
            raise HTTPException(status_code=404, detail="Dashboard not found")
        if payload.name is not None:
            d.name = payload.name
        if payload.widgets is not None:
            await s.execute(delete(Widget).where(Widget.dashboard_id == dash_id))
            for w in payload.widgets:
                s.add(Widget(dashboard_id=dash_id, **w.model_dump()))
        d.updated_at = datetime.utcnow()
        await s.commit()
        await s.refresh(d)
        return d


@app.delete("/api/dashboard/{dash_id}")
async def dash_delete(dash_id: int):
    async with SessionLocal() as s:
        d = await s.get(Dashboard, dash_id)
        if d is None:
            raise HTTPException(status_code=404, detail="Dashboard not found")
        await s.delete(d)
        await s.commit()
    return {"status": "ok"}


# ============================================================================
# НОВОЕ: WebSocket — поток изменений тегов
# ============================================================================

@app.websocket("/ws/live")
async def ws_live(ws: WebSocket, token: str = ""):
    if not _valid_token(token):
        await ws.close(code=4001)
        return
    await ws.accept()

    merged_q: asyncio.Queue = asyncio.Queue(maxsize=500)
    _ws_queues.append(merged_q)
    tag_q = collector.subscribe()

    async def _fwd_tags():
        while True:
            msg = await tag_q.get()
            try:
                merged_q.put_nowait({"type": "tag_update", "data": msg})
            except asyncio.QueueFull:
                pass

    fwd = asyncio.create_task(_fwd_tags(), name="ws-fwd")
    try:
        await ws.send_json(_plc_state_msg())
        await ws.send_json({"type": "collector_status", "data": collector.stats()})
        while not (shutdown_event and shutdown_event.is_set()):
            try:
                msg = await asyncio.wait_for(merged_q.get(), timeout=15)
                await ws.send_json(msg)
            except asyncio.TimeoutError:
                await ws.send_json({"type": "ping"})
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[WS] error: {e}")
    finally:
        fwd.cancel()
        try:
            await fwd
        except asyncio.CancelledError:
            pass
        collector.unsubscribe(tag_q)
        if merged_q in _ws_queues:
            _ws_queues.remove(merged_q)
        try:
            await ws.close()
        except Exception:
            pass


# ============================================================================
# РЕЦЕПТЫ (UDT)
# ============================================================================

@app.get("/api/recipes")
async def get_recipes():
    """Список UDT тегов как рецептов с определениями членов."""
    if not current_plc:
        return {"recipes": [], "connected": False}
    recipes = []
    for t in tag_structure.get('UDT', []):
        fields = t.get('fields', [])
        recipes.append({
            'name': t['name'],
            'udt_type': t['type'],
            'member_count': len(fields),
            'members': [{'name': f['name'], 'display_name': f['display_name'], 'type': f['type']}
                        for f in fields],
        })
    return {"recipes": recipes, "connected": True}


@app.get("/api/recipes/{tag_name:path}/read")
async def read_recipe_values(tag_name: str):
    """Читает живые значения всех членов UDT тега."""
    if not current_plc:
        raise HTTPException(status_code=400, detail="No PLC connection")

    fields = []
    for t in tag_structure.get('UDT', []):
        if t['name'] == tag_name:
            fields = t.get('fields', [])
            break

    if not fields:
        fields = await asyncio.to_thread(enumerate_udt_members, current_plc, tag_name)

    if not fields:
        raise HTTPException(status_code=404, detail="UDT members not found")

    members = []
    for f in fields:
        try:
            r = await asyncio.to_thread(current_plc.Read, f['name'])
            val = format_value(r.Value, f['type']) if r.Status == "Success" else "N/A"
        except Exception:
            val = "N/A"
        members.append({
            'name': f['name'],
            'display_name': f['display_name'],
            'type': f['type'],
            'value': val,
        })
    return {"tag": tag_name, "members": members}


@app.get("/api/recipes/{tag_name:path}/snapshots")
async def list_snapshots(tag_name: str):
    async with SessionLocal() as s:
        res = await s.execute(
            select(db_module.RecipeSnapshot)
            .where(db_module.RecipeSnapshot.recipe_tag == tag_name)
            .order_by(db_module.RecipeSnapshot.created_at.desc())
        )
        rows = list(res.scalars().all())
    return [{"id": r.id, "label": r.label,
             "created_at": r.created_at.isoformat(),
             "values": json.loads(r.values_json)} for r in rows]


@app.post("/api/recipes/{tag_name:path}/snapshots")
async def save_snapshot(tag_name: str, body: RecipeSnapshotCreate):
    if not body.values:
        raise HTTPException(status_code=400, detail="No values to save")
    async with SessionLocal() as s:
        snap = db_module.RecipeSnapshot(
            recipe_tag=tag_name,
            label=body.label,
            values_json=json.dumps(body.values, ensure_ascii=False),
        )
        s.add(snap)
        await s.commit()
        await s.refresh(snap)
    return {"id": snap.id, "label": snap.label, "created_at": snap.created_at.isoformat()}


@app.delete("/api/recipes/snapshots/{snap_id}")
async def delete_snapshot(snap_id: int):
    async with SessionLocal() as s:
        row = await s.get(db_module.RecipeSnapshot, snap_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Snapshot not found")
        await s.delete(row)
        await s.commit()
    return {"status": "ok"}


@app.get("/api/recipes/{tag_name:path}/changes")
async def get_recipe_changes(tag_name: str, limit: int = Query(100, le=500)):
    async with SessionLocal() as s:
        res = await s.execute(
            select(db_module.RecipeChange)
            .where(db_module.RecipeChange.recipe_tag == tag_name)
            .order_by(db_module.RecipeChange.changed_at.desc())
            .limit(limit)
        )
        rows = list(res.scalars().all())
    return [{"id": r.id, "member": r.member, "old_value": r.old_value,
             "new_value": r.new_value, "changed_at": r.changed_at.isoformat()} for r in rows]


@app.post("/api/recipes/{tag_name:path}/changes")
async def log_recipe_changes(tag_name: str, payload: RecipeChangesPayload):
    async with SessionLocal() as s:
        for c in payload.changes:
            s.add(db_module.RecipeChange(
                recipe_tag=tag_name,
                member=c.member,
                old_value=c.old_value,
                new_value=c.new_value,
            ))
        await s.commit()
    return {"status": "ok", "logged": len(payload.changes)}


# ============================================================================
# AI Analytics (Ollama)
# ============================================================================

OLLAMA_URL  = os.getenv("OLLAMA_URL", "http://localhost:11434")
AI_MODEL    = os.getenv("AI_MODEL", "phi3:mini")

_SYSTEM_PROMPT = (
    "You are an industrial automation expert analyzing data from an Allen-Bradley ControlLogix PLC. "
    "Respond in English. Be specific and practical. Use engineering terminology. "
    "Format: concise bullet points. List critical issues first."
)

_ANALYSIS_INTROS = {
    "anomalies":   "Analyze the PLC tag data and identify anomalies, outliers, and deviations from normal operation. "
                   "Name the specific tags with issues and recommend corrective actions.\n\n",
    "diagnostics": "Perform an equipment diagnostic based on PLC tag data. "
                   "Identify potential failures, degradation trends, and preventive maintenance recommendations.\n\n",
    "report":      "Generate a summary report of equipment operation for the given period based on PLC tag data. "
                   "Include: normal operating time, detected deviations, extreme values.\n\n",
}


async def _get_ai_config() -> tuple:
    """Returns (ollama_url, ai_model) — DB overrides env if set."""
    async with SessionLocal() as s:
        ollama_row = await s.get(AppSettings, "ollama_url")
        model_row  = await s.get(AppSettings, "ai_model")
    url   = (ollama_row.value if ollama_row and ollama_row.value else None) or OLLAMA_URL
    model = (model_row.value  if model_row  and model_row.value  else None) or AI_MODEL
    return url, model


def _build_context_text(tag_stats: dict, current_values: dict, tag_descs: dict = None) -> str:
    lines = []
    for tag_name, s in tag_stats.items():
        if not s:
            continue
        cur = current_values.get(tag_name)
        desc = (tag_descs or {}).get(tag_name)
        label = f"Tag: {tag_name}"
        if desc:
            label += f" [{desc}]"
        parts = [label]
        if "mean" in s:
            parts.append(f"mean={s['mean']:.3g}")
        if "min" in s:
            parts.append(f"min={s['min']:.3g}")
        if "max" in s:
            parts.append(f"max={s['max']:.3g}")
        if cur is not None:
            parts.append(f"current={cur}")
            if "mean" in s and "min" in s and "max" in s:
                spread = s["max"] - s["min"]
                if spread > 0:
                    try:
                        cur_f = float(cur)
                        threshold = s["mean"] + 2 * (spread / 4)
                        if cur_f > threshold or cur_f < s["mean"] - 2 * (spread / 4):
                            parts.append("⚠ ANOMALY")
                    except (ValueError, TypeError):
                        pass
        lines.append(", ".join(parts))
    return "\n".join(lines) if lines else "No data in InfluxDB."


@app.get("/api/ai/analyze/stream")
async def ai_analyze_stream(
    analysis_type: str = Query("anomalies"),
    time_range:    str = Query("-8h"),
    tags:          str = Query(""),
    custom_prompt: str = Query(""),
    token:         str = Query(""),
):
    if not _valid_token(token):
        raise HTTPException(status_code=401, detail="Unauthorized")

    requested_tags = [t.strip() for t in tags.split(",") if t.strip()] if tags else []

    # Gather InfluxDB stats
    available_tags = influx.list_tags_with_data() if influx.available else []
    if requested_tags:
        selected = [t for t in requested_tags if t in available_tags] or available_tags[:20]
    else:
        selected = available_tags[:20]

    tag_stats: dict = {}
    for tag_name in selected:
        tag_stats[tag_name] = influx.stats(tag_name, frm=time_range)

    # Get current PLC values from cache
    current_values: dict = {}
    if _tags_cache and "tags" in _tags_cache:
        for cat_tags in _tags_cache["tags"].values():
            if isinstance(cat_tags, list):
                for entry in cat_tags:
                    if isinstance(entry, dict) and "name" in entry:
                        current_values[entry["name"]] = entry.get("value")

    # Load tag descriptions for AI context
    async with SessionLocal() as s:
        res = await s.execute(select(TagConfig))
        tag_descs = {r.tag_name: r.description for r in res.scalars().all() if r.description}

    context_text = _build_context_text(tag_stats, current_values, tag_descs)
    intro = custom_prompt.strip() + "\n\n" if custom_prompt.strip() else _ANALYSIS_INTROS.get(analysis_type, _ANALYSIS_INTROS["anomalies"])
    user_prompt = intro + f"Tag data (period {time_range}):\n{context_text}"

    ollama_url, ai_model = await _get_ai_config()

    async def generate():
        import httpx
        try:
            async with httpx.AsyncClient(timeout=120) as client:
                async with client.stream(
                    "POST",
                    f"{ollama_url}/api/chat",
                    json={
                        "model": ai_model,
                        "messages": [
                            {"role": "system", "content": _SYSTEM_PROMPT},
                            {"role": "user",   "content": user_prompt},
                        ],
                        "stream": True,
                    },
                ) as resp:
                    if resp.status_code != 200:
                        yield f"data: [ERROR] Ollama returned {resp.status_code}\n\n"
                        return
                    async for line in resp.aiter_lines():
                        if not line:
                            continue
                        try:
                            chunk = json.loads(line)
                            content = chunk.get("message", {}).get("content", "")
                            if content:
                                yield f"data: {content}\n\n"
                            if chunk.get("done"):
                                break
                        except json.JSONDecodeError:
                            pass
        except httpx.ConnectError:
            yield f"data: [ERROR] Ollama unavailable ({ollama_url}). Run: sudo systemctl start ollama\n\n"
        except Exception as e:
            yield f"data: [ERROR] {e}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ============================================================================
# Static + main
# ============================================================================

if os.path.exists(STATIC_DIR):
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=5000)
