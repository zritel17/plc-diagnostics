"""
Однократная настройка InfluxDB: создаёт бакеты plc_hourly / plc_daily и
агрегационные задачи raw → hourly → daily.

Запускать после первого старта influxdb (docker compose up -d):
    python3 setup_influx.py

Идемпотентно: повторный запуск не ломает существующие объекты.
"""
import os
import sys
from typing import Optional

try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
except Exception:
    pass

from influxdb_client import InfluxDBClient, BucketRetentionRules
from influxdb_client.rest import ApiException

URL = os.environ.get("INFLUX_URL", "http://localhost:8086")
TOKEN = os.environ.get("INFLUX_TOKEN", "plcgateway-super-secret-token")
ORG = os.environ.get("INFLUX_ORG", "factory")

BUCKET_RAW = os.environ.get("INFLUX_BUCKET_RAW", "plc_data")
BUCKET_HOURLY = os.environ.get("INFLUX_BUCKET_HOURLY", "plc_hourly")
BUCKET_DAILY = os.environ.get("INFLUX_BUCKET_DAILY", "plc_daily")

# retentions in seconds
RET_RAW = 30 * 24 * 3600       # 30 дней (уже задано в docker-compose, обновим если нужно)
RET_HOURLY = 365 * 24 * 3600   # 1 год
RET_DAILY = 5 * 365 * 24 * 3600  # 5 лет


def ensure_bucket(client: InfluxDBClient, name: str, retention_sec: int):
    api = client.buckets_api()
    org_id = next((o.id for o in client.organizations_api().find_organizations() if o.name == ORG), None)
    if org_id is None:
        raise RuntimeError(f"Org '{ORG}' не найдена")
    existing = api.find_bucket_by_name(name)
    if existing:
        # Обновляем retention если не совпадает
        rules = existing.retention_rules or []
        cur = rules[0].every_seconds if rules else 0
        if cur != retention_sec:
            existing.retention_rules = [BucketRetentionRules(type="expire", every_seconds=retention_sec)]
            api.update_bucket(bucket=existing)
            print(f"[bucket] {name}: обновил retention → {retention_sec}s")
        else:
            print(f"[bucket] {name}: уже есть, retention OK")
        return existing
    bucket = api.create_bucket(
        bucket_name=name,
        org_id=org_id,
        retention_rules=BucketRetentionRules(type="expire", every_seconds=retention_sec),
    )
    print(f"[bucket] {name}: создан")
    return bucket


def ensure_task(client: InfluxDBClient, name: str, flux: str):
    tapi = client.tasks_api()
    tasks = tapi.find_tasks(name=name)
    if tasks:
        existing = tasks[0]
        if existing.flux.strip() == flux.strip():
            print(f"[task] {name}: уже есть, Flux совпадает")
            return existing
        existing.flux = flux
        tapi.update_task(existing)
        print(f"[task] {name}: обновил Flux")
        return existing
    org_id = next((o.id for o in client.organizations_api().find_organizations() if o.name == ORG), None)
    task = tapi.create_task_every(
        name=name, flux=flux, every="1h" if "hourly" in name else "24h", organization_id=org_id
    ) if hasattr(tapi, 'create_task_every') else None
    if task is None:
        # fallback: build the task script with `option task` block
        script = f'option task = {{name: "{name}", every: {"1h" if "hourly" in name else "24h"}}}\n\n{flux}'
        task = tapi.create_task_with_flux(flux=script, organization_id=org_id) if hasattr(tapi, 'create_task_with_flux') else tapi.create_task_(script, org_id)
    print(f"[task] {name}: создан")
    return task


HOURLY_FLUX = f'''
from(bucket: "{BUCKET_RAW}")
  |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == "tag_values" and r._field == "value")
  |> aggregateWindow(every: 1h, fn: mean, createEmpty: false)
  |> set(key: "_measurement", value: "tag_values")
  |> to(bucket: "{BUCKET_HOURLY}")
'''

DAILY_FLUX = f'''
from(bucket: "{BUCKET_HOURLY}")
  |> range(start: -24h)
  |> filter(fn: (r) => r._measurement == "tag_values" and r._field == "value")
  |> aggregateWindow(every: 24h, fn: mean, createEmpty: false)
  |> set(key: "_measurement", value: "tag_values")
  |> to(bucket: "{BUCKET_DAILY}")
'''


def main() -> int:
    print(f"InfluxDB: {URL} org={ORG}")
    try:
        with InfluxDBClient(url=URL, token=TOKEN, org=ORG, timeout=10_000) as client:
            ok = client.ping()
            if not ok:
                print("ERROR: ping вернул False — проверьте URL/токен.", file=sys.stderr)
                return 2

            ensure_bucket(client, BUCKET_RAW, RET_RAW)
            ensure_bucket(client, BUCKET_HOURLY, RET_HOURLY)
            ensure_bucket(client, BUCKET_DAILY, RET_DAILY)

            # tasks: используем create через сырой Flux (надёжнее)
            tapi = client.tasks_api()
            for name, body, every in (
                ("plc_to_hourly", HOURLY_FLUX, "1h"),
                ("plc_hourly_to_daily", DAILY_FLUX, "24h"),
            ):
                tasks = tapi.find_tasks(name=name)
                script = f'option task = {{name: "{name}", every: {every}}}\n{body}'
                if tasks:
                    t = tasks[0]
                    if t.flux.strip() != script.strip():
                        t.flux = script
                        tapi.update_task(t)
                        print(f"[task] {name}: обновлён")
                    else:
                        print(f"[task] {name}: OK")
                    continue
                org = next((o for o in client.organizations_api().find_organizations() if o.name == ORG), None)
                if org is None:
                    print(f"ERROR: org {ORG} not found", file=sys.stderr)
                    return 3
                tapi.create_task_every(name=name, flux=body, every=every, organization=org)
                print(f"[task] {name}: создан")
        print("Готово.")
        return 0
    except ApiException as e:
        print(f"InfluxDB API error: {e}", file=sys.stderr)
        return 4
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
