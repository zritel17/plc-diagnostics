"""
Async-коллектор. Опрашивает ПЛК в фоне, пишет в InfluxDB.

Принцип:
- Свой `pylogix.PLC` (не делит соединение с диагностическими роутами)
- on_change теги — пакетный pylogix.Read([...]) каждые poll_interval_ms,
  пишет только при изменении (с учётом deadband для чисел)
- on_interval теги — отдельный asyncio task на каждый, пишет независимо
- При ошибке соединения — пауза 5 сек и реконнект, не падаем
"""
import asyncio
from datetime import datetime
from typing import Optional, Dict, Any, List

from sqlalchemy import select

from db import SessionLocal, TagConfig, CollectorSettings, influx


def _to_thread(fn, *args, **kwargs):
    return asyncio.to_thread(fn, *args, **kwargs)


class Collector:
    def __init__(self):
        self._task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()
        self._plc = None
        self._cache: Dict[str, Any] = {}
        self._interval_tasks: Dict[int, asyncio.Task] = {}
        self._listeners: List[asyncio.Queue] = []
        self._stats: Dict[str, Any] = {
            "running": False,
            "started_at": None,
            "polls": 0,
            "writes": 0,
            "errors": 0,
            "last_poll_at": None,
            "last_error": None,
            "plc_ip": None,
            "on_change_count": 0,
            "on_interval_count": 0,
        }

    @property
    def is_running(self) -> bool:
        return self._task is not None and not self._task.done()

    def stats(self) -> Dict[str, Any]:
        s = dict(self._stats)
        s["influx_available"] = influx.available
        s["influx_error"] = influx.last_error
        return s

    # ------- pub/sub для WebSocket -------
    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=200)
        self._listeners.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        try:
            self._listeners.remove(q)
        except ValueError:
            pass

    def _notify(self, msg: dict) -> None:
        for q in list(self._listeners):
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                # потребитель отстал — отбрасываем
                pass

    # ------- управление жизненным циклом -------
    async def start(self) -> Dict[str, Any]:
        if self.is_running:
            return {"status": "already_running"}
        self._stop.clear()
        self._cache = {}
        self._stats["polls"] = 0
        self._stats["writes"] = 0
        self._stats["errors"] = 0
        self._stats["last_error"] = None
        self._stats["started_at"] = datetime.utcnow().isoformat()
        self._task = asyncio.create_task(self._run(), name="plc-collector")
        return {"status": "starting"}

    async def stop(self) -> Dict[str, Any]:
        if not self.is_running:
            self._stats["running"] = False
            return {"status": "not_running"}
        self._stop.set()
        try:
            await asyncio.wait_for(self._task, timeout=10)
        except asyncio.TimeoutError:
            self._task.cancel()
            try:
                await self._task
            except Exception:
                pass
        self._task = None
        self._stats["running"] = False
        return {"status": "stopped"}

    # ------- внутреннее -------
    async def _connect_plc(self, ip: str, slot: int) -> bool:
        from pylogix import PLC
        if self._plc:
            try:
                await _to_thread(self._plc.Close)
            except Exception:
                pass
            self._plc = None
        plc = PLC(ip, timeout=5)
        plc.ProcessorSlot = slot
        # лёгкая проверка соединения — пробуем GetPLCTime
        try:
            r = await _to_thread(plc.GetPLCTime)
            if getattr(r, "Status", "") != "Success":
                # не критично, оставляем как есть
                pass
        except Exception:
            pass
        self._plc = plc
        return True

    async def _load_configs(self):
        async with SessionLocal() as s:
            res = await s.execute(select(TagConfig).where(TagConfig.enabled == 1))
            rows = list(res.scalars().all())
        on_change = [r for r in rows if r.update_mode == "on_change"]
        on_interval = [r for r in rows if r.update_mode == "on_interval"]
        self._stats["on_change_count"] = len(on_change)
        self._stats["on_interval_count"] = len(on_interval)
        return on_change, on_interval

    async def _read_batch(self, names: List[str]):
        return await _to_thread(self._plc.Read, names)

    async def _read_one(self, name: str):
        return await _to_thread(self._plc.Read, name)

    async def _run(self):
        # Прочитать настройки коллектора
        async with SessionLocal() as s:
            settings = await s.get(CollectorSettings, 1)
            if settings is None or not settings.plc_ip:
                self._stats["last_error"] = "Не задан IP ПЛК. Откройте 'Сбор данных' и сохраните настройки."
                self._stats["running"] = False
                return
            ip = settings.plc_ip
            slot = settings.plc_slot
            poll_ms = max(50, int(settings.poll_interval_ms or 100))

        self._stats["plc_ip"] = ip
        self._stats["running"] = True
        print(f"[COLLECTOR] start ip={ip} slot={slot} poll={poll_ms}ms")

        # Реконнект до первой удачи
        while not self._stop.is_set():
            try:
                await self._connect_plc(ip, slot)
                break
            except Exception as e:
                self._stats["errors"] += 1
                self._stats["last_error"] = f"PLC connect: {e}"
                print(f"[COLLECTOR] connect error: {e}, retry в 5с")
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=5)
                    break  # был сигнал stop
                except asyncio.TimeoutError:
                    continue

        try:
            while not self._stop.is_set():
                t0 = asyncio.get_event_loop().time()
                try:
                    on_change, on_interval = await self._load_configs()

                    # синхронизируем интервал-таски
                    desired = {r.id: r for r in on_interval}
                    for tid, t in list(self._interval_tasks.items()):
                        if tid not in desired or t.done():
                            t.cancel()
                            del self._interval_tasks[tid]
                    for tid, cfg in desired.items():
                        if tid not in self._interval_tasks:
                            self._interval_tasks[tid] = asyncio.create_task(
                                self._interval_task(cfg), name=f"int-{cfg.tag_name}"
                            )

                    # пакетное чтение on_change
                    if on_change:
                        names = [r.tag_name for r in on_change]
                        by_name = {r.tag_name: r for r in on_change}
                        try:
                            responses = await self._read_batch(names)
                        except Exception as e:
                            self._stats["errors"] += 1
                            self._stats["last_error"] = f"batch read: {e}"
                            await self._reconnect(ip, slot)
                            responses = []

                        if responses is not None:
                            if not isinstance(responses, list):
                                responses = [responses]
                            ts = datetime.utcnow()
                            for resp, name in zip(responses, names):
                                # некоторые версии pylogix не возвращают TagName для batch
                                resp_name = getattr(resp, "TagName", None) or name
                                status = getattr(resp, "Status", "")
                                value = getattr(resp, "Value", None)
                                if status != "Success" or value is None:
                                    continue
                                cfg = by_name.get(resp_name)
                                if cfg is None:
                                    continue
                                self._maybe_write(cfg, value, ts)

                    self._stats["polls"] += 1
                    self._stats["last_poll_at"] = datetime.utcnow().isoformat()
                except Exception as e:
                    self._stats["errors"] += 1
                    self._stats["last_error"] = f"poll: {e}"

                # сон ровно poll_ms - время цикла
                elapsed = (asyncio.get_event_loop().time() - t0) * 1000
                sleep_ms = max(0, poll_ms - elapsed)
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=sleep_ms / 1000)
                except asyncio.TimeoutError:
                    pass
        finally:
            print("[COLLECTOR] stopping…")
            for t in list(self._interval_tasks.values()):
                t.cancel()
            for t in list(self._interval_tasks.values()):
                try:
                    await t
                except Exception:
                    pass
            self._interval_tasks.clear()
            if self._plc:
                try:
                    await _to_thread(self._plc.Close)
                except Exception:
                    pass
                self._plc = None
            self._stats["running"] = False
            print("[COLLECTOR] stopped")

    async def _reconnect(self, ip: str, slot: int):
        try:
            await asyncio.wait_for(self._stop.wait(), timeout=5)
            return
        except asyncio.TimeoutError:
            pass
        try:
            await self._connect_plc(ip, slot)
        except Exception as e:
            self._stats["last_error"] = f"reconnect: {e}"

    async def _interval_task(self, cfg: TagConfig):
        interval = max(1, int(cfg.interval_sec or 1))
        try:
            while not self._stop.is_set():
                try:
                    if self._plc is None:
                        await asyncio.sleep(1)
                        continue
                    resp = await self._read_one(cfg.tag_name)
                    if getattr(resp, "Status", "") == "Success":
                        val = getattr(resp, "Value", None)
                        if val is not None:
                            self._write_value(cfg, val)
                            self._cache[cfg.tag_name] = val
                            self._notify({
                                "tag": cfg.tag_name,
                                "value": _serialize_value(val),
                                "ts": datetime.utcnow().isoformat(),
                                "mode": "on_interval",
                            })
                except Exception as e:
                    self._stats["errors"] += 1
                    self._stats["last_error"] = f"interval {cfg.tag_name}: {e}"
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=interval)
                except asyncio.TimeoutError:
                    continue
        except asyncio.CancelledError:
            pass

    # ------- запись с deadband -------
    def _maybe_write(self, cfg: TagConfig, value, ts: datetime):
        prev = self._cache.get(cfg.tag_name, _MISSING)
        changed = True
        if prev is _MISSING:
            changed = True
        elif isinstance(value, float) and isinstance(prev, (int, float)) and (cfg.deadband or 0) > 0:
            changed = abs(float(value) - float(prev)) >= cfg.deadband
        else:
            changed = prev != value
        if not changed:
            return
        self._cache[cfg.tag_name] = value
        self._write_value(cfg, value, ts)
        self._notify({
            "tag": cfg.tag_name,
            "value": _serialize_value(value),
            "ts": ts.isoformat(),
            "mode": "on_change",
        })

    def _write_value(self, cfg: TagConfig, value, ts: Optional[datetime] = None):
        ok = influx.write_point(
            cfg.tag_name, value, self._stats.get("plc_ip"), cfg.update_mode, ts
        )
        if ok:
            self._stats["writes"] += 1


_MISSING = object()


def _serialize_value(v):
    if isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, bytes):
        try:
            return v.decode("utf-8", errors="ignore").rstrip("\x00")
        except Exception:
            return f"<{len(v)} bytes>"
    return str(v)


# Singleton
collector = Collector()
