"""
PLC Diagnostics + Edge Gateway.
- Существующие роуты (диагностика, I/O) — без изменений
- Новые роуты: конфиг сбора, коллектор, данные из InfluxDB, дашборды, WS
"""
import asyncio
import json
import os
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional, List

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from pylogix import PLC
from sqlalchemy import select, delete

import db as db_module
from db import (
    SessionLocal, TagConfig, CollectorSettings, Dashboard, Widget, influx,
    init_db,
)
from models import (
    TagConfigIn, TagConfigOut, SaveTagsRequest,
    CollectorSettingsModel, CollectorStatus,
    WidgetIn, WidgetOut, DashboardIn, DashboardOut, DashboardUpdate,
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
    # 2) InfluxDB
    try:
        ok = await asyncio.to_thread(influx.connect)
        print(f"[STARTUP] InfluxDB available={ok} err={influx.last_error}")
    except Exception as e:
        print(f"[STARTUP] InfluxDB connect error: {e}")
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


app = FastAPI(lifespan=lifespan)

current_plc = None
current_ip = None
current_slot = 0
all_tags_raw = []
tag_structure = {}
io_modules = []
last_update = None

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

@app.get("/")
async def root():
    return FileResponse(f"{STATIC_DIR}/index.html")

@app.post("/api/connect")
async def connect(request: PLCConnectRequest):
    global current_plc, current_ip, current_slot, all_tags_raw, tag_structure, io_modules
    
    ip = request.ip.strip()
    slot = request.slot
    
    if not ip:
        raise HTTPException(status_code=400, detail="IP адрес не может быть пустым")
    
    try:
        if current_plc:
            try:
                current_plc.Close()
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
            add_to_history(ip, slot, "failed - нет тегов")
            raise HTTPException(status_code=400, detail="Не удалось получить теги")
        
        # Сканируем I/O модули
        print(f"[CONNECT] Сканирую I/O слоты 0-15...")
        io_modules = scan_io_modules(plc)
        print(f"[CONNECT] Найдено I/O модулей: {len(io_modules)}")
        
        current_plc = plc
        current_ip = ip
        current_slot = slot
        
        add_to_history(ip, slot, "success")
        
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
        raise HTTPException(status_code=400, detail=f"Ошибка: {error_str}")

@app.post("/api/disconnect")
async def disconnect():
    global current_plc, current_ip, current_slot, all_tags_raw, tag_structure, io_modules
    
    if current_plc:
        try:
            current_plc.Close()
        except:
            pass
    current_plc = None
    current_ip = None
    current_slot = 0
    all_tags_raw = []
    tag_structure = {}
    io_modules = []
    
    return {"status": "disconnected"}

def scan_io_modules(plc):
    """Сканирование I/O модулей в слотах 0-15"""
    modules = []
    
    for slot_num in range(16):
        module = {
            'slot': slot_num,
            'has_input': False,
            'has_output': False,
            'inputs': [],
            'outputs': [],
            'analog_inputs': [],
            'analog_outputs': [],
            'data_size': 32,  # Сколько битов в модуле
            'output_size': 32
        }
        
        # Дискретные входы - читаем .Data как int
        try:
            r = plc.Read(f"Local:{slot_num}:I.Data")
            if r.Status == "Success" and r.Value is not None:
                module['has_input'] = True
                int_val = int(r.Value)
                if int_val < 0:
                    int_val = (1 << 32) + int_val
                
                # Определяем размер - читаем биты пока статус успешен
                num_bits = 32
                # Можно начать с 32 и подстраивать
                module['data_size'] = num_bits
                module['inputs'] = [{
                    'channel': i,
                    'tag': f"Local:{slot_num}:I.Data.{i}",
                    'value': (int_val >> i) & 1
                } for i in range(num_bits)]
        except Exception as e:
            pass
        
        # Дискретные выходы
        try:
            r = plc.Read(f"Local:{slot_num}:O.Data")
            if r.Status == "Success" and r.Value is not None:
                module['has_output'] = True
                int_val = int(r.Value)
                if int_val < 0:
                    int_val = (1 << 32) + int_val
                num_bits = 32
                module['output_size'] = num_bits
                module['outputs'] = [{
                    'channel': i,
                    'tag': f"Local:{slot_num}:O.Data.{i}",
                    'value': (int_val >> i) & 1
                } for i in range(num_bits)]
        except:
            pass
        
        # Аналоговые входы (Ch0Data .. Ch7Data)
        for ch in range(16):
            try:
                r = plc.Read(f"Local:{slot_num}:I.Ch{ch}Data")
                if r.Status == "Success" and r.Value is not None:
                    module['analog_inputs'].append({
                        'channel': ch,
                        'tag': f"Local:{slot_num}:I.Ch{ch}Data",
                        'value': float(r.Value) if isinstance(r.Value, (int, float)) else 0
                    })
            except:
                pass
        
        # Аналоговые выходы
        for ch in range(16):
            try:
                r = plc.Read(f"Local:{slot_num}:O.Ch{ch}Data")
                if r.Status == "Success" and r.Value is not None:
                    module['analog_outputs'].append({
                        'channel': ch,
                        'tag': f"Local:{slot_num}:O.Ch{ch}Data",
                        'value': float(r.Value) if isinstance(r.Value, (int, float)) else 0
                    })
            except:
                pass
        
        # Если нашли что-то - добавляем модуль
        if module['has_input'] or module['has_output'] or module['analog_inputs'] or module['analog_outputs']:
            modules.append(module)
    
    return modules

@app.get("/api/tags")
async def get_tags():
    global current_plc, all_tags_raw, tag_structure, last_update
    
    if not current_plc:
        raise HTTPException(status_code=400, detail="Нет подключения к ПЛК")
    
    try:
        # Читаем все теги
        tag_values = {}
        for tag_info in all_tags_raw:
            try:
                response = current_plc.Read(tag_info['name'])
                if hasattr(response, 'Value') and response.Value is not None:
                    tag_values[tag_info['name']] = response.Value
                else:
                    tag_values[tag_info['name']] = None
            except:
                tag_values[tag_info['name']] = None
        
        # Формируем результат
        result = {}
        for category, tags in tag_structure.items():
            result[category] = []
            for tag in tags:
                tag_name = tag['name']
                
                if tag.get('is_array'):
                    # МАССИВ
                    elements = []
                    for elem in tag['elements']:
                        elem_value = tag_values.get(elem['name'])
                        elem_data = {
                            'name': elem['name'],
                            'index': elem['index'],
                            'display_name': f"[{elem['index']}]",
                            'type': elem['type'],
                            'value': format_value(elem_value, elem['type'])
                        }
                        # Для целочисленных - добавляем hex и биты
                        if is_integer_type(elem['type']):
                            bits = INT_BITS[elem['type']]
                            elem_data['hex'] = format_hex(elem_value, bits)
                            elem_data['bits'] = get_bits(elem_value, bits)
                            elem_data['num_bits'] = bits
                        elements.append(elem_data)
                    
                    result[category].append({
                        'name': tag_name,
                        'type': tag['type'],
                        'is_array': True,
                        'array_size': tag['array_size'],
                        'value': f"[{tag['array_size']} элементов]",
                        'elements': elements
                    })
                else:
                    # Обычный тег
                    main_value = tag_values.get(tag_name)
                    tag_result = {
                        'name': tag_name,
                        'type': tag['type'],
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
                            field_name = f"{tag_name}.{f['name']}"
                            fv = tag_values.get(field_name)
                            fields.append({
                                'name': field_name,
                                'display_name': f['name'],
                                'desc': f.get('desc', ''),
                                'type': f['type'],
                                'value': format_value(fv, f['type'])
                            })
                        tag_result['fields'] = fields
                    
                    result[category].append(tag_result)
        
        last_update = datetime.now().isoformat()
        return {"tags": result, "last_update": last_update}
        
    except Exception as e:
        print(f"[ERROR] tags read: {e}")
        raise HTTPException(status_code=400, detail=f"Ошибка чтения: {str(e)}")

@app.get("/api/io")
async def get_io():
    global current_plc, io_modules
    
    if not current_plc:
        raise HTTPException(status_code=400, detail="Нет подключения к ПЛК")
    
    try:
        for module in io_modules:
            slot_num = module['slot']
            
            if module['has_input']:
                try:
                    r = current_plc.Read(f"Local:{slot_num}:I.Data")
                    if r.Status == "Success" and r.Value is not None:
                        int_val = int(r.Value)
                        if int_val < 0:
                            int_val = (1 << 32) + int_val
                        for inp in module['inputs']:
                            inp['value'] = (int_val >> inp['channel']) & 1
                except:
                    pass
            
            if module['has_output']:
                try:
                    r = current_plc.Read(f"Local:{slot_num}:O.Data")
                    if r.Status == "Success" and r.Value is not None:
                        int_val = int(r.Value)
                        if int_val < 0:
                            int_val = (1 << 32) + int_val
                        for out in module['outputs']:
                            out['value'] = (int_val >> out['channel']) & 1
                except:
                    pass
            
            for ch in module['analog_inputs']:
                try:
                    r = current_plc.Read(ch['tag'])
                    if r.Status == "Success" and r.Value is not None:
                        ch['value'] = float(r.Value) if isinstance(r.Value, (int, float)) else 0
                except:
                    pass
            
            for ch in module['analog_outputs']:
                try:
                    r = current_plc.Read(ch['tag'])
                    if r.Status == "Success" and r.Value is not None:
                        ch['value'] = float(r.Value) if isinstance(r.Value, (int, float)) else 0
                except:
                    pass
        
        return io_modules
        
    except Exception as e:
        print(f"[ERROR] io read: {e}")
        raise HTTPException(status_code=400, detail=f"Ошибка чтения I/O: {str(e)}")

@app.post("/api/write")
async def write_tag(request: WriteTagRequest):
    global current_plc
    
    if not current_plc:
        raise HTTPException(status_code=400, detail="Нет подключения к ПЛК")
    
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
        
        response = current_plc.Write(tag_name, value)
        
        if hasattr(response, 'Status') and response.Status == "Success":
            return {"status": "success", "tag": tag_name, "value": str(value)}
        else:
            status = response.Status if hasattr(response, 'Status') else "Unknown"
            raise HTTPException(status_code=400, detail=f"Ошибка записи: {status}")
            
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Ошибка: {str(e)}")

@app.get("/api/status")
async def get_status():
    global current_plc, current_ip, current_slot, all_tags_raw, last_update
    
    if not current_plc:
        return {"status": "offline", "ip": None, "slot": None}
    
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
        raise HTTPException(status_code=400, detail="Нет подключения к ПЛК")
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
            else:
                s.add(TagConfig(
                    tag_name=t.tag_name,
                    tag_type=t.tag_type,
                    update_mode=t.update_mode,
                    interval_sec=t.interval_sec,
                    deadband=t.deadband,
                    enabled=t.enabled,
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
            raise HTTPException(status_code=404, detail="Дашборд не найден")
        return d


@app.put("/api/dashboard/{dash_id}", response_model=DashboardOut)
async def dash_update(dash_id: int, payload: DashboardUpdate):
    async with SessionLocal() as s:
        d = await s.get(Dashboard, dash_id)
        if d is None:
            raise HTTPException(status_code=404, detail="Дашборд не найден")
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
            raise HTTPException(status_code=404, detail="Дашборд не найден")
        await s.delete(d)
        await s.commit()
    return {"status": "ok"}


# ============================================================================
# НОВОЕ: WebSocket — поток изменений тегов
# ============================================================================

@app.websocket("/ws/live")
async def ws_live(ws: WebSocket):
    await ws.accept()
    q = collector.subscribe()
    try:
        await ws.send_json({"type": "status", "data": collector.stats()})
        while not (shutdown_event and shutdown_event.is_set()):
            try:
                msg = await asyncio.wait_for(q.get(), timeout=15)
                await ws.send_json({"type": "tag_update", "data": msg})
            except asyncio.TimeoutError:
                # heartbeat — заодно даёт WS обнаружить мёртвое соединение
                await ws.send_json({"type": "ping"})
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[WS] error: {e}")
    finally:
        collector.unsubscribe(q)
        try:
            await ws.close()
        except Exception:
            pass


# ============================================================================
# Static + main
# ============================================================================

if os.path.exists(STATIC_DIR):
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=5000)
