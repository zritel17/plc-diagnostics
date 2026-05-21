#!/usr/bin/env python3
"""
Minimal InfluxDB v2 mock for local PLC Gateway testing.
Endpoint: http://localhost:8086
Token:    plcgateway-super-secret-token
Org:      factory  Bucket: plc_data

Synthetic data is generated on-the-fly for EMU_BOOL / EMU_DINT / EMU_REAL,
matching the emulator patterns.  Real writes from the collector are also
stored in memory and returned instead of synthetic data when available.
"""
import re
import json
import time as _time
from collections import defaultdict, deque
from datetime import datetime, timezone

import uvicorn
from fastapi import FastAPI, Request, Response

app = FastAPI()

# in-memory store: tag_name -> deque of (ts_ns: int, value: float)
_store: dict[str, deque] = defaultdict(lambda: deque(maxlen=50_000))
_written_tags: set[str] = set()

EMULATOR_TAGS = ['EMU_BOOL', 'EMU_DINT', 'EMU_REAL']


# ── time helpers ──────────────────────────────────────────────────────────────

def _now_ns() -> int:
    return int(_time.time() * 1_000_000_000)

def _rfc3339(ts_ns: int) -> str:
    dt = datetime.fromtimestamp(ts_ns / 1e9, tz=timezone.utc)
    return dt.strftime('%Y-%m-%dT%H:%M:%SZ')

def _rel_to_ns(rel: str, now_ns: int) -> int:
    m = re.match(r'^-(\d+)([smhdw])$', rel.strip())
    if not m:
        return now_ns - 3_600 * 10**9
    n, u = int(m.group(1)), m.group(2)
    secs = {'s': 1, 'm': 60, 'h': 3600, 'd': 86400, 'w': 604800}[u]
    return now_ns - n * secs * 10**9

def _parse_range(flux: str) -> tuple[int, int]:
    now_ns = _now_ns()
    start_ns = now_ns - 3_600 * 10**9
    stop_ns = now_ns

    m = re.search(r'range\(start:\s*([^,\)]+)', flux)
    if m:
        s = m.group(1).strip()
        if s.startswith('-'):
            start_ns = _rel_to_ns(s, now_ns)

    m = re.search(r'range\([^)]*stop:\s*([^)]+)\)', flux)
    if m:
        s = m.group(1).strip()
        if s not in ('now()', ''):
            try:
                stop_ns = int(
                    datetime.fromisoformat(s.rstrip('Z') + '+00:00')
                    .timestamp() * 1_000_000_000
                )
            except Exception:
                pass

    return start_ns, stop_ns


# ── synthetic value generation ────────────────────────────────────────────────

def _synth(tag: str, ts_ns: int) -> float:
    t = ts_ns / 1e9
    if tag == 'EMU_BOOL':
        return float(int(t) % 2)
    if tag == 'EMU_DINT':
        # triangle 0..100, period 20 s (±1 every 100 ms)
        cycle = (t % 20.0) / 10.0          # 0..2
        return float(int((cycle if cycle <= 1.0 else 2.0 - cycle) * 100))
    if tag == 'EMU_REAL':
        # triangle 0.0..100.0, period 80 s (±0.25 every 100 ms)
        cycle = (t % 80.0) / 40.0          # 0..2
        return round((cycle if cycle <= 1.0 else 2.0 - cycle) * 100.0, 2)
    return 0.0

def _points(tag: str, start_ns: int, stop_ns: int, max_pts: int = 500) -> list[tuple[int, float]]:
    """Return (ts_ns, value) list from store or generated synthetically."""
    if tag in _written_tags and _store[tag]:
        data = [(ts, v) for ts, v in _store[tag] if start_ns <= ts <= stop_ns]
        if data:
            step = max(1, len(data) // max_pts)
            return data[::step][:max_pts]

    duration_ns = max(stop_ns - start_ns, 1)
    interval_ns = max(duration_ns // max_pts, 100_000_000)  # min 100 ms
    result, ts = [], start_ns
    while ts <= stop_ns and len(result) < max_pts:
        result.append((ts, _synth(tag, ts)))
        ts += interval_ns
    return result


# ── line-protocol parser (for writes from collector) ─────────────────────────

def _parse_lp(body: str) -> None:
    for line in body.strip().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        try:
            parts = line.split(' ')
            if len(parts) < 2:
                continue
            meas_tags, fields_str = parts[0], parts[1]
            ts_ns = int(parts[2]) if len(parts) > 2 else _now_ns()

            tags: dict[str, str] = {}
            for seg in meas_tags.split(',')[1:]:
                if '=' in seg:
                    k, v = seg.split('=', 1)
                    tags[k] = v

            tag_name = tags.get('tag_name', '')
            if not tag_name:
                continue

            value: float | None = None
            for f in fields_str.split(','):
                if f.startswith('value='):
                    try:
                        value = float(f.split('=', 1)[1])
                    except Exception:
                        pass
                    break

            if value is not None:
                _store[tag_name].append((ts_ns, value))
                _written_tags.add(tag_name)
        except Exception:
            pass


# ── annotated CSV builders ────────────────────────────────────────────────────

_EPOCH = '1970-01-01T00:00:00Z'
_FAR   = '2099-01-01T00:00:00Z'

def _csv_timeseries(pts: list[tuple[int, float]], tag: str, s: int, e: int) -> str:
    hdr = (
        '#datatype,string,long,dateTime:RFC3339,dateTime:RFC3339,'
        'dateTime:RFC3339,double,string,string,string\n'
        '#group,false,false,true,true,false,false,true,true,true\n'
        '#default,_result,,,,,,,,\n'
        ',result,table,_start,_stop,_time,_value,_field,_measurement,tag_name\n'
    )
    s_s, e_s = _rfc3339(s), _rfc3339(e)
    rows = ''.join(
        f',,0,{s_s},{e_s},{_rfc3339(ts)},{v},value,tag_values,{tag}\n'
        for ts, v in pts
    )
    return hdr + rows + '\n'

def _csv_strings(values: list[str]) -> str:
    hdr = (
        '#datatype,string,long,dateTime:RFC3339,dateTime:RFC3339,string\n'
        '#group,false,false,true,true,false\n'
        '#default,_result,,,,\n'
        ',result,table,_start,_stop,_value\n'
    )
    rows = ''.join(f',,{i},{_EPOCH},{_FAR},{v}\n' for i, v in enumerate(values))
    return hdr + rows + '\n'

def _csv_scalar(val: float, s: int, e: int) -> str:
    s_s, e_s = _rfc3339(s), _rfc3339(e)
    return (
        '#datatype,string,long,dateTime:RFC3339,dateTime:RFC3339,double\n'
        '#group,false,false,true,true,false\n'
        '#default,_result,,,,\n'
        ',result,table,_start,_stop,_value\n'
        f',,0,{s_s},{e_s},{val}\n'
        '\n'
    )

def _csv_empty() -> str:
    return '#datatype,string,long\n#group,false,false\n#default,_result,\n,result,table\n\n'


# ── Flux query router ─────────────────────────────────────────────────────────

def _handle_flux(flux: str) -> str:
    # 1. schema.tagValues → list all known tags
    if 'tagValues' in flux:
        all_tags = sorted(set(EMULATOR_TAGS) | _written_tags)
        return _csv_strings(all_tags)

    # 2. Extract tag_name from filter
    m = re.search(r'tag_name\s*==\s*"([^"]+)"', flux)
    if not m:
        return _csv_empty()
    tag = m.group(1)

    start_ns, stop_ns = _parse_range(flux)

    # 3. Aggregate function?
    agg_m = re.search(r'\|>\s*(mean|min|max|last|first|sum)\(\)', flux)
    if agg_m:
        fn = agg_m.group(1)
        pts = _points(tag, start_ns, stop_ns, max_pts=2000)
        if not pts:
            return _csv_empty()
        vals = [v for _, v in pts]
        agg = {
            'mean':  sum(vals) / len(vals),
            'min':   min(vals),
            'max':   max(vals),
            'last':  vals[-1],
            'first': vals[0],
            'sum':   sum(vals),
        }[fn]
        return _csv_scalar(round(agg, 4), start_ns, stop_ns)

    # 4. Time series
    lm = re.search(r'limit\(n:\s*(\d+)\)', flux)
    max_pts = min(int(lm.group(1)), 2000) if lm else 500
    pts = _points(tag, start_ns, stop_ns, max_pts=max_pts)
    return _csv_timeseries(pts, tag, start_ns, stop_ns)


# ── HTTP routes ───────────────────────────────────────────────────────────────

@app.get('/health')
async def health():
    return {'status': 'pass', 'name': 'influxdb-mock', 'message': 'ready'}

@app.get('/ping')
async def ping():
    return Response(status_code=204)

@app.post('/api/v2/write')
async def write(request: Request):
    body = await request.body()
    _parse_lp(body.decode('utf-8', errors='replace'))
    return Response(status_code=204)

@app.post('/api/v2/query')
async def query(request: Request):
    body = await request.body()
    try:
        flux = json.loads(body).get('query', '')
    except Exception:
        flux = body.decode('utf-8', errors='replace')
    csv = _handle_flux(flux)
    return Response(content=csv, media_type='application/csv; charset=utf-8')

@app.api_route('/api/v2/{path:path}', methods=['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
async def v2_catchall(path: str):
    return Response(content='{}', media_type='application/json', status_code=200)


if __name__ == '__main__':
    uvicorn.run(app, host='0.0.0.0', port=8086, log_level='warning')
