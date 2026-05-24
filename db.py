"""
Конфигурация (SQLite через SQLAlchemy async) + временные ряды (InfluxDB 2.x).
"""
import os
from datetime import datetime
from typing import Optional, List, Dict, Any

from sqlalchemy import (
    String, Integer, Float, DateTime, ForeignKey, select, text
)
from sqlalchemy.ext.asyncio import (
    create_async_engine, AsyncSession, async_sessionmaker
)
from sqlalchemy.orm import DeclarativeBase, mapped_column, Mapped, relationship

# === SQLite ===

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("PLC_DB_PATH", os.path.join(PROJECT_DIR, "plc_config.db"))
DATABASE_URL = f"sqlite+aiosqlite:///{DB_PATH}"

engine = create_async_engine(DATABASE_URL, echo=False, future=True)
SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


class TagConfig(Base):
    __tablename__ = "tags_config"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tag_name: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    tag_type: Mapped[Optional[str]] = mapped_column(String, default=None)
    update_mode: Mapped[str] = mapped_column(String, nullable=False)
    interval_sec: Mapped[Optional[int]] = mapped_column(Integer, default=None)
    deadband: Mapped[float] = mapped_column(Float, default=0.0)
    enabled: Mapped[int] = mapped_column(Integer, default=1)
    description: Mapped[Optional[str]] = mapped_column(String, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class CollectorSettings(Base):
    __tablename__ = "collector_settings"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    autostart: Mapped[int] = mapped_column(Integer, default=0)
    poll_interval_ms: Mapped[int] = mapped_column(Integer, default=100)
    plc_ip: Mapped[Optional[str]] = mapped_column(String, default=None)
    plc_slot: Mapped[int] = mapped_column(Integer, default=0)


class AppSettings(Base):
    __tablename__ = "app_settings"
    key: Mapped[str] = mapped_column(String, primary_key=True)
    value: Mapped[Optional[str]] = mapped_column(String, default=None)


class Dashboard(Base):
    __tablename__ = "dashboards"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, default=None)
    widgets: Mapped[List["Widget"]] = relationship(
        back_populates="dashboard", cascade="all, delete-orphan", lazy="selectin"
    )


class Widget(Base):
    __tablename__ = "widgets"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    dashboard_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("dashboards.id", ondelete="CASCADE")
    )
    tag_name: Mapped[str] = mapped_column(String, nullable=False)
    widget_type: Mapped[str] = mapped_column(String, nullable=False)
    time_range: Mapped[str] = mapped_column(String, default="1h")
    aggregation: Mapped[Optional[str]] = mapped_column(String, default=None)
    position_x: Mapped[int] = mapped_column(Integer, default=0)
    position_y: Mapped[int] = mapped_column(Integer, default=0)
    width: Mapped[int] = mapped_column(Integer, default=6)
    height: Mapped[int] = mapped_column(Integer, default=4)
    title: Mapped[Optional[str]] = mapped_column(String, default=None)
    dashboard: Mapped[Dashboard] = relationship(back_populates="widgets")


class RecipeSnapshot(Base):
    __tablename__ = "recipe_snapshots"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    recipe_tag: Mapped[str] = mapped_column(String, nullable=False, index=True)
    label: Mapped[str] = mapped_column(String, nullable=False, default="Снимок")
    values_json: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class RecipeChange(Base):
    __tablename__ = "recipe_changes"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    recipe_tag: Mapped[str] = mapped_column(String, nullable=False, index=True)
    member: Mapped[str] = mapped_column(String, nullable=False)
    old_value: Mapped[Optional[str]] = mapped_column(String)
    new_value: Mapped[str] = mapped_column(String, nullable=False, default="")
    changed_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Migrate existing tags_config table (SQLAlchemy create_all won't add new columns)
        try:
            await conn.execute(text("ALTER TABLE tags_config ADD COLUMN description TEXT"))
        except Exception:
            pass  # column already exists
    async with SessionLocal() as s:
        row = await s.get(CollectorSettings, 1)
        if row is None:
            s.add(CollectorSettings(id=1))
            await s.commit()
        for key in ("ollama_url", "ai_model"):
            if not await s.get(AppSettings, key):
                s.add(AppSettings(key=key))
        await s.commit()


# === InfluxDB ===

INFLUX_URL = os.environ.get("INFLUX_URL", "http://localhost:8086")
INFLUX_TOKEN = os.environ.get("INFLUX_TOKEN", "plcgateway-super-secret-token")
INFLUX_ORG = os.environ.get("INFLUX_ORG", "factory")
INFLUX_BUCKET_RAW = os.environ.get("INFLUX_BUCKET_RAW", "plc_data")
INFLUX_BUCKET_HOURLY = os.environ.get("INFLUX_BUCKET_HOURLY", "plc_hourly")
INFLUX_BUCKET_DAILY = os.environ.get("INFLUX_BUCKET_DAILY", "plc_daily")


class InfluxClient:
    """
    Тонкая обёртка над influxdb-client. Допускает graceful degradation:
    если Influx недоступен, операции no-op, флаг available=False.
    Все методы синхронные — вызывайте через asyncio.to_thread из async-кода.
    """

    def __init__(self):
        self._client = None
        self._write_api = None
        self._query_api = None
        self.available = False
        self.last_error: Optional[str] = None

    def connect(self) -> bool:
        try:
            from influxdb_client import InfluxDBClient
            from influxdb_client.client.write_api import SYNCHRONOUS
            self._client = InfluxDBClient(
                url=INFLUX_URL, token=INFLUX_TOKEN, org=INFLUX_ORG, timeout=5_000
            )
            self._write_api = self._client.write_api(write_options=SYNCHRONOUS)
            self._query_api = self._client.query_api()
            ok = self._client.ping()
            self.available = bool(ok)
            self.last_error = None if self.available else "ping вернул False"
            return self.available
        except Exception as e:
            self.last_error = str(e)
            self.available = False
            return False

    def close(self):
        try:
            if self._client:
                self._client.close()
        except Exception:
            pass
        self._client = None
        self._write_api = None
        self._query_api = None
        self.available = False

    def write_point(
        self,
        tag_name: str,
        value,
        plc_ip: Optional[str],
        update_mode: str,
        ts: Optional[datetime] = None,
    ) -> bool:
        if not self.available:
            return False
        try:
            from influxdb_client import Point, WritePrecision
            p = Point("tag_values").tag("tag_name", tag_name).tag("update_mode", update_mode)
            if plc_ip:
                p = p.tag("plc_ip", plc_ip)
            if isinstance(value, bool):
                p = p.field("value_bool", value).field("value", 1.0 if value else 0.0)
            elif isinstance(value, int):
                p = p.field("value_int", value).field("value", float(value))
            elif isinstance(value, float):
                p = p.field("value", float(value))
            else:
                p = p.field("value_str", str(value))
            if ts:
                p = p.time(ts, WritePrecision.NS)
            self._write_api.write(bucket=INFLUX_BUCKET_RAW, record=p)
            return True
        except Exception as e:
            self.last_error = f"write {tag_name}: {e}"
            return False

    def list_tags_with_data(self) -> List[str]:
        if not self.available:
            return []
        flux = (
            'import "influxdata/influxdb/schema"\n'
            f'schema.tagValues(bucket: "{INFLUX_BUCKET_RAW}", tag: "tag_name")'
        )
        try:
            tables = self._query_api.query(flux, org=INFLUX_ORG)
            out = []
            for t in tables:
                for rec in t.records:
                    out.append(rec.get_value())
            return out
        except Exception as e:
            self.last_error = f"list_tags: {e}"
            return []

    def query_history(
        self,
        tag_name: str,
        frm: str = "-1h",
        to: str = "now()",
        bucket: str = "raw",
        agg: Optional[str] = None,
        max_points: int = 2000,
    ) -> List[Dict[str, Any]]:
        if not self.available:
            return []
        b = {
            "raw": INFLUX_BUCKET_RAW,
            "hourly": INFLUX_BUCKET_HOURLY,
            "daily": INFLUX_BUCKET_DAILY,
        }.get(bucket, INFLUX_BUCKET_RAW)

        # Защита от слишком большого результата: aggregateWindow если задан agg
        agg_clause = ""
        if agg in ("mean", "min", "max", "last", "first", "sum"):
            agg_clause = f'  |> aggregateWindow(every: 1m, fn: {agg}, createEmpty: false)\n'

        flux = (
            f'from(bucket: "{b}")\n'
            f'  |> range(start: {frm}, stop: {to})\n'
            f'  |> filter(fn: (r) => r._measurement == "tag_values" '
            f'and r.tag_name == "{tag_name}" and r._field == "value")\n'
            f'{agg_clause}'
            f'  |> tail(n: {max_points})'
        )
        try:
            tables = self._query_api.query(flux, org=INFLUX_ORG)
            out = []
            for t in tables:
                for rec in t.records:
                    out.append({
                        "time": rec.get_time().isoformat(),
                        "value": rec.get_value(),
                    })
            return out
        except Exception as e:
            self.last_error = f"query {tag_name}: {e}"
            return []

    def stats(self, tag_name: str, frm: str = "-1h", to: str = "now()") -> Dict[str, float]:
        if not self.available:
            return {}
        out: Dict[str, float] = {}
        for fn in ("mean", "min", "max", "last", "first"):
            flux = (
                f'from(bucket: "{INFLUX_BUCKET_RAW}")\n'
                f'  |> range(start: {frm}, stop: {to})\n'
                f'  |> filter(fn: (r) => r._measurement == "tag_values" '
                f'and r.tag_name == "{tag_name}" and r._field == "value")\n'
                f'  |> {fn}()'
            )
            try:
                tables = self._query_api.query(flux, org=INFLUX_ORG)
                for t in tables:
                    for rec in t.records:
                        v = rec.get_value()
                        if v is not None:
                            out[fn] = float(v)
            except Exception:
                pass
        return out


    def db_summary(self) -> Dict[str, Any]:
        tags = self.list_tags_with_data()
        out: Dict[str, Any] = {
            "available": self.available,
            "tags_with_data": len(tags),
            "oldest": None,
            "newest": None,
            "error": self.last_error,
        }
        if not self.available:
            return out
        for fn, key in (("first", "oldest"), ("last", "newest")):
            flux = (
                f'from(bucket: "{INFLUX_BUCKET_RAW}")\n'
                f'  |> range(start: -365d)\n'
                f'  |> filter(fn: (r) => r._measurement == "tag_values" and r._field == "value")\n'
                f'  |> {fn}()\n'
                f'  |> keep(columns: ["_time"])\n'
                f'  |> limit(n: 1)'
            )
            try:
                tables = self._query_api.query(flux, org=INFLUX_ORG)
                for t in tables:
                    for rec in t.records:
                        out[key] = rec.get_time().isoformat()
            except Exception as e:
                self.last_error = f"db_summary {fn}: {e}"
        return out


influx = InfluxClient()
