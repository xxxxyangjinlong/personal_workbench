#!/usr/bin/env python3
"""本地 Web 服务：提供数据库目录与自然语言查询接口，并托管单页前端。"""
import json
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from dbquery import catalog, config, jdbc, llm
from dbquery.main import build_meta, load_catalog

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
CFG = config.load()

BRIDGES = {}
LOCK = threading.Lock()
META_CACHE = {}


def entry_by_id(entries, eid):
    for e in entries:
        if e["id"] == eid:
            return e
    return None


def get_bridge(entry):
    with LOCK:
        b = BRIDGES.get(entry["id"])
        if b is not None:
            try:
                b.ping()
                return b, None
            except Exception:  # noqa: BLE001
                BRIDGES.pop(entry["id"], None)
        try:
            b = jdbc.Bridge(entry["type"], CFG.get("extra_classpath", []))
            info = b.connect(entry["url"], entry["username"], entry["password"], entry["driver"])
            BRIDGES[entry["id"]] = b
            return b, info
        except jdbc.BridgeError as exc:
            return None, {"error": str(exc)}


# ------------------------------------------------------------------ api
def api_catalog():
    entries = load_catalog(CFG)
    grouped = {}
    for e in entries:
        grouped.setdefault(e["project"], {}).setdefault(
            e["profile"], {"env": e["env"], "items": []})
        grouped[e["project"]][e["profile"]]["items"].append({
            "id": e["id"], "type": e["type"], "typeLabel": e["typeLabel"],
            "host": e["host"], "port": e["port"], "database": e["database"],
            "schema": e.get("schema"), "username": e["username"],
            "module": e["module"], "placeholder": e.get("placeholder", False),
        })
    projects = []
    for pname, profiles in sorted(grouped.items()):
        plist = []
        total = 0
        for prof, data in sorted(profiles.items()):
            total += len(data["items"])
            plist.append({"profile": prof, "env": data["env"], "items": data["items"]})
        projects.append({"name": pname, "count": total, "profiles": plist})
    return {"root": CFG["projects_root"], "total": len(entries), "projects": projects,
            "noDbProjects": catalog.projects_without_db(CFG["projects_root"], entries)}


def api_connect(body):
    entries = load_catalog(CFG)
    entry = entry_by_id(entries, body.get("id"))
    if not entry:
        return {"error": "找不到该数据源"}
    bridge, info = get_bridge(entry)
    if not bridge:
        return {"error": info["error"] if isinstance(info, dict) else "连接失败"}
    if not isinstance(info, dict):
        try:
            info = bridge.info()
        except Exception:  # noqa: BLE001
            info = {"product": entry["typeLabel"]}
    if not META_CACHE.get(entry["id"], {}).get("tables"):
        META_CACHE[entry["id"]] = build_meta(entry, bridge)
    meta = META_CACHE[entry["id"]]
    return {"ok": True, "entry": {"id": entry["id"], "typeLabel": entry["typeLabel"],
            "host": entry["host"], "port": entry["port"], "database": entry["database"],
            "schema": entry.get("schema"), "username": entry["username"]},
            "conn": info, "tableCount": len(meta["tables"])}


def _entry_schema(eid, override=None):
    if override:
        return override
    entry = entry_by_id(load_catalog(CFG), eid)
    return entry.get("schema") if entry else None


def api_schemas(body):
    b = BRIDGES.get(body.get("id"))
    if not b:
        return {"error": "未连接"}
    try:
        return {"schemas": b.schemas()}
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}


def api_tables(body):
    b = BRIDGES.get(body.get("id"))
    if not b:
        return {"error": "未连接"}
    return {"tables": b.tables(schema=_entry_schema(body.get("id"), body.get("schema")))}


def api_columns(body):
    b = BRIDGES.get(body.get("id"))
    if not b:
        return {"error": "未连接"}
    return {"columns": b.columns(body.get("table"), schema=_entry_schema(body.get("id"), body.get("schema")))}


def api_query(body):
    entries = load_catalog(CFG)
    entry = entry_by_id(entries, body.get("id"))
    if not entry:
        return {"error": "找不到该数据源"}
    bridge, info = get_bridge(entry)
    if not bridge:
        return {"error": info["error"] if isinstance(info, dict) else "连接失败"}
    if not isinstance(info, dict):
        try:
            info = bridge.info()
        except Exception:  # noqa: BLE001
            info = {"product": entry["typeLabel"]}
    meta = META_CACHE.get(entry["id"]) or build_meta(entry, bridge)
    if not meta.get("tables"):
        meta = build_meta(entry, bridge)
    META_CACHE[entry["id"]] = meta
    max_rows = int(body.get("maxRows") or CFG.get("max_rows", 200))
    try:
        gen = llm.generate_sql(CFG, body.get("question", ""), meta, body.get("history") or [])
    except llm.LLMError as exc:
        return {"error": str(exc)}
    try:
        resp = bridge.query(gen["sql"], max_rows)
    except jdbc.BridgeError as exc:
        return {"error": f"SQL 执行失败：{exc}", "sql": gen["sql"], "explanation": gen["explanation"]}
    out = {"ok": True, "sql": gen["sql"], "explanation": gen.get("explanation"),
           "columns": resp.get("columns", []), "rows": resp.get("rows", []),
           "rowCount": len(resp.get("rows", [])), "elapsedMs": resp.get("elapsedMs"),
           "updateCount": resp.get("updateCount")}
    if body.get("explain") and resp.get("columns") and resp.get("rows"):
        try:
            out["summary"] = llm.summarize(CFG, body.get("question", ""),
                                           resp["columns"], resp["rows"])
        except llm.LLMError as exc:
            out["summaryError"] = str(exc)
    return out


def api_sql(body):
    b = BRIDGES.get(body.get("id"))
    if not b:
        return {"error": "未连接"}
    try:
        resp = b.query(body.get("sql", ""), int(body.get("maxRows") or 200))
    except jdbc.BridgeError as exc:
        return {"error": str(exc)}
    return {"ok": True, "sql": body.get("sql"),
            "columns": resp.get("columns", []), "rows": resp.get("rows", []),
            "rowCount": len(resp.get("rows", [])), "elapsedMs": resp.get("elapsedMs"),
            "updateCount": resp.get("updateCount")}


ROUTES = {"/api/catalog": api_catalog, "/api/connect": api_connect,
          "/api/schemas": api_schemas, "/api/tables": api_tables, "/api/columns": api_columns,
          "/api/query": api_query, "/api/sql": api_sql}


class Handler(BaseHTTPRequestHandler):
    def _json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            html = (WEB / "index.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store, must-revalidate")
            self.send_header("Content-Length", str(len(html)))
            self.end_headers()
            self.wfile.write(html)
            return
        if path in ROUTES:
            try:
                self._json(ROUTES[path]())
            except Exception as exc:  # noqa: BLE001
                self._json({"error": str(exc), "trace": traceback.format_exc()}, 500)
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except Exception:  # noqa: BLE001
            body = {}
        fn = ROUTES.get(path)
        if not fn:
            self.send_response(404)
            self.end_headers()
            return
        try:
            self._json(fn(body))
        except Exception as exc:  # noqa: BLE001
            self._json({"error": str(exc), "trace": traceback.format_exc()}, 500)

    def log_message(self, *args):  # 安静模式
        pass


def main(port=8777):
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"数据库查询工具已启动： http://127.0.0.1:{port}")
    print(f"扫描根目录： {CFG['projects_root']}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    import sys
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 8777)
