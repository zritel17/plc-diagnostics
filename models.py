"""
Pydantic схемы для новых API-эндпоинтов.
"""
from datetime import datetime
from typing import Optional, List, Literal
from pydantic import BaseModel, Field


# ===== Tags config =====

class TagConfigIn(BaseModel):
    tag_name: str
    tag_type: Optional[str] = None
    update_mode: Literal["on_change", "on_interval"]
    interval_sec: Optional[int] = Field(default=None, ge=1)
    deadband: float = 0.0
    enabled: int = 1
    description: Optional[str] = None


class TagConfigOut(TagConfigIn):
    id: int
    created_at: datetime

    class Config:
        from_attributes = True


class SaveTagsRequest(BaseModel):
    tags: List[TagConfigIn]
    replace_all: bool = False


# ===== Collector =====

class CollectorSettingsModel(BaseModel):
    autostart: int = 0
    poll_interval_ms: int = Field(default=100, ge=50, le=10_000)
    plc_ip: Optional[str] = None
    plc_slot: int = Field(default=0, ge=0, le=15)


class CollectorStatus(BaseModel):
    running: bool
    started_at: Optional[str] = None
    polls: int = 0
    writes: int = 0
    errors: int = 0
    last_poll_at: Optional[str] = None
    last_error: Optional[str] = None
    plc_ip: Optional[str] = None
    influx_available: bool = False
    influx_error: Optional[str] = None
    on_change_count: int = 0
    on_interval_count: int = 0


# ===== Dashboards =====

class WidgetIn(BaseModel):
    tag_name: str
    widget_type: Literal[
        "line_chart", "gauge", "table", "stat", "boolean",
        "bar_chart", "state_timeline", "donut",
    ]
    time_range: str = "1h"
    aggregation: Optional[str] = None
    position_x: int = 0
    position_y: int = 0
    width: int = 6
    height: int = 4
    title: Optional[str] = None
    gauge_min:    Optional[float] = None
    gauge_max:    Optional[float] = None
    threshold_hh: Optional[float] = None
    threshold_h:  Optional[float] = None
    threshold_l:  Optional[float] = None
    threshold_ll: Optional[float] = None
    max_points:   int = 100
    color:        Optional[str] = None
    bar_window:   Optional[str] = None
    bar_count:    Optional[int] = None


class WidgetOut(WidgetIn):
    id: int

    class Config:
        from_attributes = True


class DashboardIn(BaseModel):
    name: str


class DashboardOut(BaseModel):
    id: int
    name: str
    created_at: datetime
    updated_at: Optional[datetime] = None
    widgets: List[WidgetOut] = []

    class Config:
        from_attributes = True


class DashboardUpdate(BaseModel):
    name: Optional[str] = None
    widgets: Optional[List[WidgetIn]] = None  # если заданы — заменить полностью


# ===== Batch data =====

class BatchItem(BaseModel):
    tag: str
    type: str            # "history" | "stats" | "bars" | "delta" | "uptime" | "timeline"
    range: str = "1h"
    agg: str = "mean"
    window: str = "8h"
    count: int = 7
    max_points: int = 200


class BatchDataRequest(BaseModel):
    items: List[BatchItem]


# ===== Recipes =====

class RecipeSnapshotCreate(BaseModel):
    label: str = "Снимок"
    values: dict  # {member_name: value_str}


class RecipeChangeItem(BaseModel):
    member: str
    old_value: Optional[str] = None
    new_value: str


class RecipeChangesPayload(BaseModel):
    changes: List[RecipeChangeItem]
