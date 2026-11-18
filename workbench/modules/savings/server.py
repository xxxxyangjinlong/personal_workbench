"""存钱进度模块：按日期记录最新总数，自动计算较上次的变化与目标进度。"""
import datetime
import json
import os
import re
import sqlite3
import sys
import uuid
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from zoneinfo import ZoneInfo

DATA = Path(os.environ["FIREFLY_MODULE_DATA_DIR"])
CONFIG = json.loads(os.environ.get("FIREFLY_MODULE_CONFIG", "{}"))
UI = "ui://savings/progress"
TZ = ZoneInfo(CONFIG.get("timezone", "Asia/Shanghai"))
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def schema(properties=None, required=None):
    return {"type": "object", "properties": properties or {}, "required": required or [], "additionalProperties": False}


TOOLS = [
    {"name": "list_savings", "description": "列出每次更新的日期、总数与较上次的变化", "inputSchema": schema(), "annotations": {"readOnlyHint": True}, "_meta": {"ui": {"resourceUri": UI}}},
    {"name": "save_saving", "description": "新增或更新某一天的最新存款总数；同一天只保留一条，传 id 时更新该条", "inputSchema": schema({"id": {"type": "string", "maxLength": 100}, "date": {"type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"}, "total": {"type": "number", "minimum": 0}, "note": {"type": "string", "maxLength": 500}}, ["date", "total"]), "annotations": {"idempotentHint": True}},
    {"name": "delete_saving", "description": "删除某一天的存款总数记录", "inputSchema": schema({"id": {"type": "string", "minLength": 1}}, ["id"]), "annotations": {"idempotentHint": True, "destructiveHint": True}},
    {"name": "set_goal", "description": "设置或清除存款目标（单位：元）", "inputSchema": schema({"amount": {"type": ["number", "null"], "minimum": 0}}), "annotations": {"idempotentHint": True}},
    {"name": "check_monthly_reminder", "description": "检查本月是否已更新存款总数", "inputSchema": schema(), "annotations": {"readOnlyHint": True}},
]


def parse_cents(value):
    if value is None or value == "":
        raise ValueError("金额不能为空")
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, TypeError):
        raise ValueError("金额格式不正确")
    if not amount.is_finite():
        raise ValueError("金额格式不正确")
    amount = amount.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    if amount < 0:
        raise ValueError("金额不能为负数")
    return int(amount * 100)


def yuan(cents):
    return round(cents / 100, 2)


def validate_date(value):
    text = str(value or "")
    if not DATE_RE.match(text):
        raise ValueError("日期格式应为 YYYY-MM-DD")
    try:
        datetime.date.fromisoformat(text)
    except ValueError:
        raise ValueError("日期不存在")
    return text


def today():
    return datetime.datetime.now(TZ).date().isoformat()


def snapshot(database):
    rows = database.execute("SELECT id, date, total_cents, note FROM snapshots ORDER BY date, rowid").fetchall()
    entries = []
    previous = None
    for index, (ident, day, cents, note) in enumerate(rows, start=1):
        change = cents if previous is None else cents - previous
        entries.append({
            "id": ident,
            "date": day,
            "totalCents": cents,
            "total": yuan(cents),
            "changeCents": change,
            "change": yuan(change),
            "note": note or "",
            "index": index,
        })
        previous = cents
    goal_row = database.execute("SELECT value FROM settings WHERE key = 'goal_cents'").fetchone()
    goal_cents = int(goal_row[0]) if goal_row else None
    total_cents = entries[-1]["totalCents"] if entries else 0
    progress = round(total_cents / goal_cents * 100, 1) if goal_cents else None
    return {
        "entries": list(reversed(entries)),
        "summary": {
            "totalCents": total_cents,
            "total": yuan(total_cents),
            "count": len(entries),
            "goalCents": goal_cents,
            "goal": yuan(goal_cents) if goal_cents is not None else None,
            "progress": progress,
            "latestDate": entries[-1]["date"] if entries else None,
            "firstDate": entries[0]["date"] if entries else None,
            "first": entries[0]["total"] if entries else 0,
            "changeTotal": round(entries[-1]["total"] - entries[0]["total"], 2) if entries else 0,
            "lastChange": entries[-1]["change"] if entries else 0,
            "lastChangeDate": entries[-1]["date"] if entries else None,
        },
    }


def migrate_legacy(database):
    has_entries = database.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entries'").fetchone()
    if not has_entries:
        return
    existing = database.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0]
    if existing:
        return
    running = 0
    for month, cents in database.execute("SELECT month, amount_cents FROM entries ORDER BY month").fetchall():
        running += cents
        database.execute("INSERT INTO snapshots (id, date, total_cents, note) VALUES (?, ?, ?, ?)", (uuid.uuid4().hex, month + "-01", running, "从旧版月度记录迁移"))


def call(name, arguments):
    DATA.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DATA / "savings.sqlite3") as database:
        database.execute("CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, date TEXT NOT NULL UNIQUE, total_cents INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '')")
        database.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        migrate_legacy(database)
        if name == "save_saving":
            day = validate_date(arguments.get("date"))
            cents = parse_cents(arguments.get("total"))
            note = str(arguments.get("note") or "").strip()[:500]
            ident = str(arguments.get("id") or "").strip()
            existing = database.execute("SELECT id FROM snapshots WHERE date = ? OR (id <> '' AND id = ?)", (day, ident)).fetchone()
            try:
                if existing:
                    database.execute("UPDATE snapshots SET date = ?, total_cents = ?, note = ? WHERE id = ?", (day, cents, note, existing[0]))
                else:
                    database.execute("INSERT INTO snapshots (id, date, total_cents, note) VALUES (?, ?, ?, ?)", (ident or uuid.uuid4().hex, day, cents, note))
            except sqlite3.IntegrityError:
                raise ValueError("这一天已有记录，请直接编辑那一条")
        elif name == "delete_saving":
            database.execute("DELETE FROM snapshots WHERE id = ?", (str(arguments.get("id", "")),))
        elif name == "set_goal":
            value = arguments.get("amount")
            if value is None or value == "":
                database.execute("DELETE FROM settings WHERE key = 'goal_cents'")
            else:
                database.execute("INSERT INTO settings (key, value) VALUES ('goal_cents', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (str(parse_cents(value)),))
        elif name not in {"list_savings", "check_monthly_reminder"}:
            raise ValueError("Unknown tool")
        value = snapshot(database)
    if name == "check_monthly_reminder":
        month = today()[:7]
        recorded = any(entry["date"][:7] == month for entry in value["entries"])
        value = {"currentMonth": month, "recorded": recorded, "summary": value["summary"]}
    return {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}], "structuredContent": value}


def handle(message):
    method, params = message.get("method"), message.get("params") or {}
    if method == "initialize":
        return {"protocolVersion": "2025-11-25", "capabilities": {"tools": {}, "resources": {}}, "serverInfo": {"name": "savings", "version": "0.2.0"}}
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        try:
            return call(params["name"], params.get("arguments", {}))
        except (KeyError, ValueError, sqlite3.Error) as error:
            return {"isError": True, "content": [{"type": "text", "text": str(error)}]}
    if method == "resources/list":
        return {"resources": [{"uri": UI, "name": "Savings", "mimeType": "text/html;profile=mcp-app"}]}
    if method == "resources/read" and params.get("uri") == UI:
        return {"contents": [{"uri": UI, "mimeType": "text/html;profile=mcp-app", "text": (Path(__file__).resolve().parent / "savings.html").read_text()}]}
    raise ValueError("Unsupported method")


def serve():
    for line in sys.stdin:
        try:
            message = json.loads(line)
            if "id" not in message:
                continue
            try:
                response = {"jsonrpc": "2.0", "id": message["id"], "result": handle(message)}
            except Exception as error:
                print(str(error), file=sys.stderr, flush=True)
                response = {"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32603, "message": "Module request failed"}}
            print(json.dumps(response, ensure_ascii=False), flush=True)
        except json.JSONDecodeError:
            print("Invalid JSON request", file=sys.stderr, flush=True)


if __name__ == "__main__":
    serve()
