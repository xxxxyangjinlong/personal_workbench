#!/usr/bin/env python3
"""本地 Web 服务：提供数据库目录与自然语言查询接口，并托管单页前端。"""
import json
import re
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs

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
def reset_runtime():
    with LOCK:
        for b in BRIDGES.values():
            try:
                b.close()
            except Exception:  # noqa: BLE001
                pass
        BRIDGES.clear()
    META_CACHE.clear()


def api_catalog(refresh=False):
    if refresh:
        reset_runtime()
    entries = load_catalog(CFG, refresh=refresh)
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


# --------------------------------------------------------------- 数据浏览 / 写操作 / 历史
EXEC_LOCK = threading.Lock()  # 事务序列（begin→execute→rollback/commit）不可被打断


def _qi(dbtype, name):
    """按方言包标识符（表名/列名），引号内双写转义"""
    if dbtype == "mysql":
        return "`" + str(name).replace("`", "``") + "`"
    return '"' + str(name).replace('"', '""') + '"'


def _page_clause(dbtype, page, size):
    off = page * size
    if dbtype == "hive2":
        return f" LIMIT {size}" if page == 0 else None
    if dbtype in ("mysql", "postgresql", "h2", "dm"):
        return f" LIMIT {size} OFFSET {off}"
    return f" OFFSET {off} ROWS FETCH NEXT {size} ROWS ONLY"  # oracle / sqlserver


def _sanitize_where(w):
    w = str(w or "").strip().rstrip(";").strip()
    if not w:
        return ""
    if re.search(r";|--|/\*|\*/", w):
        raise ValueError("WHERE 片段里不允许分号或注释")
    return w


def _write_kind(sql):
    s = re.sub(r"^\s*(--[^\n]*\n|\s|/\*.*?\*/)*", "", str(sql or ""), flags=re.S).lstrip()
    m = re.match(r"(insert|update|delete|merge|create|drop|alter|truncate)\b", s, re.I)
    return m.group(1).lower() if m else None


def _require_where(sql, kind):
    if kind in ("update", "delete") and not re.search(r"\bwhere\b", sql, re.I):
        raise ValueError(f"{kind.upper()} 语句必须带 WHERE 条件")


def _entry_bridge(body):
    entries = load_catalog(CFG)
    entry = entry_by_id(entries, body.get("id"))
    if not entry:
        return None, None, {"error": "找不到该数据源"}
    bridge, info = get_bridge(entry)
    if not bridge:
        return None, entry, {"error": info["error"] if isinstance(info, dict) else "连接失败"}
    return bridge, entry, None


def api_rows(body):
    bridge, entry, err = _entry_bridge(body)
    if err:
        return err
    dbtype = entry["type"]
    schema = body.get("schema") or entry.get("schema")
    table = str(body.get("table") or "").strip()
    if not table:
        return {"error": "缺少 table"}
    page = max(0, int(body.get("page") or 0))
    size = min(200, max(5, int(body.get("pageSize") or 50)))
    sort_col = str(body.get("sortCol") or "").strip()
    sort_dir = "DESC" if str(body.get("sortDir") or "").upper() == "DESC" else "ASC"
    try:
        where = _sanitize_where(body.get("where"))
    except ValueError as exc:
        return {"error": str(exc)}
    if sort_col:
        cols = [c.get("name") for c in bridge.columns(table, schema=schema)]
        if sort_col not in cols:
            return {"error": f"排序列不存在：{sort_col}"}
    T = _qi(dbtype, table)
    sql = f"SELECT * FROM {T}"
    if where:
        sql += f" WHERE {where}"
    if sort_col:
        sql += f" ORDER BY {_qi(dbtype, sort_col)} {sort_dir}"
    elif dbtype == "sqlserver":
        sql += " ORDER BY (SELECT NULL)"
    page_clause = _page_clause(dbtype, page, size)
    if page_clause is None:
        return {"error": "Hive 只支持浏览第一页（LIMIT），不支持翻页", "hiveLimit": True}
    rows_sql = sql + page_clause
    count_sql = f"SELECT COUNT(*) AS CNT FROM {T}" + (f" WHERE {where}" if where else "")
    try:
        cresp = bridge.query(count_sql, 1)
        total = int(cresp["rows"][0][0]) if cresp.get("rows") else None
        rresp = bridge.query(rows_sql, size)
    except jdbc.BridgeError as exc:
        return {"error": str(exc), "sql": rows_sql}
    return {"ok": True, "table": table, "schema": schema, "page": page, "pageSize": size,
            "total": total, "columns": rresp.get("columns", []), "rows": rresp.get("rows", []),
            "rowCount": len(rresp.get("rows", [])), "elapsedMs": rresp.get("elapsedMs"), "sql": rows_sql}


def _validate_write(body):
    sql = str(body.get("sql") or "").strip()
    kind = _write_kind(sql)
    if not kind:
        raise ValueError("不是写语句（只支持 INSERT / UPDATE / DELETE / MERGE）")
    if kind not in ("insert", "update", "delete", "merge"):
        raise ValueError(f"{kind.upper()} 属于 DDL/危险操作，本工具不执行")
    _require_where(sql, kind)
    return sql, kind


def api_execute_preview(body):
    bridge, entry, err = _entry_bridge(body)
    if err:
        return err
    try:
        sql, kind = _validate_write(body)
    except ValueError as exc:
        return {"error": str(exc)}
    if entry["type"] == "hive2":
        return {"ok": True, "preview": False, "updateCount": None, "note": "Hive 无事务，无法预览影响行数"}
    try:
        with EXEC_LOCK:
            bridge.begin()
            try:
                resp = bridge.query(sql, 1)
                cnt = resp.get("updateCount")
            finally:
                bridge.rollback()
        return {"ok": True, "preview": True, "updateCount": cnt, "kind": kind}
    except (jdbc.BridgeError, Exception) as exc:  # noqa: BLE001
        try: bridge.rollback()
        except Exception: pass
        return {"error": str(exc)}


def api_execute_confirm(body):
    bridge, entry, err = _entry_bridge(body)
    if err:
        return err
    try:
        sql, kind = _validate_write(body)
    except ValueError as exc:
        return {"error": str(exc)}
    try:
        if entry["type"] == "hive2":
            resp = bridge.query(sql, 1)
        else:
            with EXEC_LOCK:
                bridge.begin()
                try:
                    resp = bridge.query(sql, 1)
                    bridge.commit()
                except Exception:
                    try: bridge.rollback()
                    except Exception: pass
                    raise
        return {"ok": True, "updateCount": resp.get("updateCount"), "kind": kind, "elapsedMs": resp.get("elapsedMs")}
    except (jdbc.BridgeError, Exception) as exc:  # noqa: BLE001
        return {"error": str(exc)}


def _load_list(path):
    try:
        return json.loads(path.read_text("utf-8"))
    except Exception:  # noqa: BLE001
        return []


def _save_list(path, lst):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(lst, ensure_ascii=False)[:1 << 22], "utf-8")


def api_history(body=None):
    body = body or {}
    lst = _load_list(HIST_FILE)
    op = body.get("op") or "list"
    if op == "add":
        sql = str(body.get("sql") or "").strip()
        if sql:
            lst = [x for x in lst if x.get("sql") != sql]
            lst.insert(0, {"ts": int(time.time()), "id": body.get("id") or "",
                           "label": body.get("label") or "", "sql": sql})
            _save_list(HIST_FILE, lst[:200])
    elif op == "delete":
        idx = int(body.get("index", -1))
        if 0 <= idx < len(lst):
            lst.pop(idx)
            _save_list(HIST_FILE, lst)
    elif op == "clear":
        lst = []
        _save_list(HIST_FILE, lst)
    return {"items": lst[:100]}


def api_favorites(body=None):
    body = body or {}
    lst = _load_list(FAV_FILE)
    op = body.get("op") or "list"
    if op == "toggle":
        sql = str(body.get("sql") or "").strip()
        if sql:
            hit = next((x for x in lst if x.get("sql") == sql), None)
            if hit:
                lst = [x for x in lst if x.get("sql") != sql]
            else:
                lst.insert(0, {"ts": int(time.time()), "id": body.get("id") or "",
                               "label": str(body.get("label") or "").strip() or sql[:40], "sql": sql})
            _save_list(FAV_FILE, lst[:100])
    elif op == "delete":
        idx = int(body.get("index", -1))
        if 0 <= idx < len(lst):
            lst.pop(idx)
            _save_list(FAV_FILE, lst)
    return {"items": lst[:100]}


# ---- 网格编辑：主键 + 由单元格值构造类型安全的写语句 ----
NUMERIC_TYPES = {2, 3, 4, 5, 6, 7, 8, -5, -6, -7, 16}  # NUMERIC,DECIMAL,INTEGER,SMALLINT,REAL,FLOAT,DOUBLE,BIGINT,TINYINT,BIT,BOOLEAN


def api_pkeys(body):
    bridge, entry, err = _entry_bridge(body)
    if err:
        return err
    try:
        cols = bridge.primaryKeys(body.get("table"), schema=body.get("schema") or entry.get("schema"))
    except jdbc.BridgeError as exc:
        return {"error": str(exc)}
    return {"ok": True, "columns": cols}


def _literal(dbtype, data_type, value):
    v = str(value)
    if v == "NULL":
        return "NULL"
    try:
        data_type = int(data_type)  # 桥的迷你 JSON 可能把 int 序列化成字符串
    except (TypeError, ValueError):
        data_type = None
    if data_type in NUMERIC_TYPES:
        if not v.strip():
            return "NULL"
        try:
            float(v)
        except ValueError:
            raise ValueError(f"数字列的值必须是数字或 NULL，收到：{v}")
        return v.strip()
    return "'" + v.replace("'", "''") + "'"


def api_buildwrite(body):
    bridge, entry, err = _entry_bridge(body)
    if err:
        return err
    dbtype = entry["type"]
    schema = body.get("schema") or entry.get("schema")
    table = str(body.get("table") or "").strip()
    op = body.get("op")
    try:
        cols = {c["name"]: c for c in bridge.columns(table, schema=schema)}
    except jdbc.BridgeError as exc:
        return {"error": str(exc)}

    def lit(col, val):
        c = cols.get(col)
        if c is None:
            raise ValueError(f"列不存在：{col}")
        return _literal(dbtype, c.get("dataType"), val)

    try:
        if op == "update":
            col = str(body.get("column") or "")
            pks = body.get("pk") or {}
            if col not in cols:
                return {"error": f"列不存在：{col}"}
            if not pks:
                return {"error": "该表没有主键，不支持网格编辑（请在 SQL 页签操作）"}
            T = _qi(dbtype, table)
            setpart = f"{_qi(dbtype, col)} = {lit(col, body.get('value'))}"
            wherepart = " AND ".join(f"{_qi(dbtype, k)} = {lit(k, v)}" for k, v in pks.items())
            sql = f"UPDATE {T} SET {setpart} WHERE {wherepart}"
        elif op == "delete":
            pks = body.get("pk") or {}
            if not pks:
                return {"error": "该表没有主键，不支持行删除（请在 SQL 页签操作）"}
            T = _qi(dbtype, table)
            wherepart = " AND ".join(f"{_qi(dbtype, k)} = {lit(k, v)}" for k, v in pks.items())
            sql = f"DELETE FROM {T} WHERE {wherepart}"
        elif op == "insert":
            vals = body.get("values") or {}
            items = []
            for k, v in vals.items():
                if k not in cols:
                    return {"error": f"列不存在：{k}"}
                if v == "NULL":
                    items.append((k, "NULL"))
                elif v != "":
                    items.append((k, lit(k, v)))
                # 空串 = 不提供该列，走表默认值
            if not items:
                return {"error": "没有填写任何值（空串表示用表默认值）"}
            T = _qi(dbtype, table)
            sql = (f"INSERT INTO {T} (" + ", ".join(_qi(dbtype, k) for k, _ in items)
                   + ") VALUES (" + ", ".join(v for _, v in items) + ")")
        else:
            return {"error": "未知 op"}
    except ValueError as exc:
        return {"error": str(exc)}
    except jdbc.BridgeError as exc:
        return {"error": str(exc)}
    return {"ok": True, "sql": sql, "op": op}


HIST_FILE = ROOT / "data" / "history.json"
FAV_FILE = ROOT / "data" / "favorites.json"

ROUTES = {"/api/catalog": api_catalog, "/api/connect": api_connect,
          "/api/schemas": api_schemas, "/api/tables": api_tables, "/api/columns": api_columns,
          "/api/query": api_query, "/api/sql": api_sql,
          "/api/rows": api_rows, "/api/execute/preview": api_execute_preview,
          "/api/execute/confirm": api_execute_confirm,
          "/api/history": api_history, "/api/favorites": api_favorites,
          "/api/pkeys": api_pkeys, "/api/buildwrite": api_buildwrite}


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
                if path == "/api/catalog":
                    qs = parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}
                    self._json(api_catalog(refresh=bool(qs.get("r"))))
                else:
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
