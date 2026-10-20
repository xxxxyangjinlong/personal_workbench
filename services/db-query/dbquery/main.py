"""命令行入口：罗列数据库目录、选择数据源、用自然语言查询。"""
import argparse
import json
import sys
from pathlib import Path

from . import catalog, config, jdbc, llm

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "catalog.json"

SQL_HINT = ("select", "with", "show", "desc", "describe", "explain", "insert",
            "update", "delete", "call", "use")


# ---------------------------------------------------------------- cache
def load_catalog(cfg, refresh=False):
    root = cfg["projects_root"]
    if not refresh and CACHE.exists():
        try:
            data = json.loads(CACHE.read_text(encoding="utf-8"))
            if data.get("projects_root") == root and data.get("entries"):
                return data["entries"]
        except Exception:  # noqa: BLE001
            pass
    entries = catalog.scan(root, cfg.get("exclude_dirs", ()))
    payload = {"projects_root": root, "scanned_at": None, "entries": entries}
    try:
        CACHE.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    return entries


# ---------------------------------------------------------------- printing
def print_table(columns, rows, max_width=40):
    def cell(v):
        s = "" if v is None else str(v)
        return s if len(s) <= max_width else s[: max_width - 1] + "…"

    cols = [cell(c) for c in columns]
    body = [[cell(c) for c in r] for r in rows]
    widths = [len(c) for c in cols]
    for r in body:
        for i, c in enumerate(r):
            widths[i] = max(widths[i], len(c))
    line = "+".join("-" * (w + 2) for w in widths)
    print("+" + line + "+")
    print("| " + " | ".join(c.ljust(widths[i]) for i, c in enumerate(cols)) + " |")
    print("+" + line + "+")
    for r in body:
        print("| " + " | ".join(c.ljust(widths[i]) for i, c in enumerate(r)) + " |")
    print("+" + line + "+")


def print_catalog(entries, show_pwd=False):
    grouped = catalog.group_by_project(entries)
    for project, items in grouped.items():
        print(f"\n■ {project}  ({len(items)} 个数据源)")
        profiles = {}
        for e in items:
            profiles.setdefault(e["profile"], []).append(e)
        for profile, plist in profiles.items():
            env = plist[0]["env"]
            print(f"  ├─ [{env}] {profile}   ({len(plist)})")
            for e in plist:
                db = e["database"] or e.get("schema") or "-"
                cred = e["username"] or "-"
                flag = "  ⚠含未解析占位符" if e.get("placeholder") else ""
                print(f"  │    #{e['id']}  {e['typeLabel']:<10} {e['host']}:{e['port']}/{db}"
                      f"   user={cred}   ({e['module']}){flag}")


# ---------------------------------------------------------------- select
def filter_entries(entries, args):
    out = entries
    if args.project:
        kw = args.project.lower()
        out = [e for e in out if kw in e["project"].lower()]
    if args.profile:
        kw = args.profile.lower()
        out = [e for e in out if kw in e["profile"].lower() or kw in e["env"]]
    if args.type:
        out = [e for e in out if e["type"] == args.type.lower()]
    if args.id:
        out = [e for e in out if e["id"] == args.id]
    return out


def _ask_int(prompt, n):
    while True:
        raw = input(prompt).strip()
        if raw in ("q", "quit", "exit", ":q"):
            raise SystemExit(0)
        if raw.isdigit() and 1 <= int(raw) <= n:
            return int(raw) - 1
        print(f"  请输入 1-{n} 之间的编号（或 q 退出）")


def interactive_select(entries, cfg):
    projects = sorted({e["project"] for e in entries})
    print("\n请选择项目：")
    for i, p in enumerate(projects, 1):
        cnt = sum(1 for e in entries if e["project"] == p)
        print(f"  {i:>2}. {p}  ({cnt})")
    pi = _ask_int("项目编号> ", len(projects))
    project = projects[pi]

    subset = [e for e in entries if e["project"] == project]
    profiles = sorted({(e["profile"], e["env"]) for e in subset})
    print(f"\n项目 [{project}] 的配置文件/环境：")
    for i, (prof, env) in enumerate(profiles, 1):
        cnt = sum(1 for e in subset if e["profile"] == prof)
        print(f"  {i:>2}. [{env}] {prof}  ({cnt})")
    si = _ask_int("配置编号> ", len(profiles))
    profile = profiles[si][0]

    subset = [e for e in subset if e["profile"] == profile]
    print(f"\n配置文件 [{profile}] 中的数据源：")
    for i, e in enumerate(subset, 1):
        db = e["database"] or e.get("schema") or "-"
        print(f"  {i:>2}. #{e['id']}  {e['typeLabel']:<10} {e['host']}:{e['port']}/{db}"
              f"   user={e['username'] or '-'}  ({e['module']})")
    ei = _ask_int("数据源编号> ", len(subset))
    return subset[ei]


# ---------------------------------------------------------------- connect
def do_connect(entry, cfg):
    if entry.get("placeholder"):
        print("⚠ 该配置的 URL 含未解析占位符（如 ${...}），可能无法直接连接。")
    print(f"→ 连接 {entry['typeLabel']} {entry['host']}:{entry['port']} "
          f"({entry['database'] or entry.get('schema') or '-'}) ...")
    try:
        bridge = jdbc.Bridge(entry["type"], cfg.get("extra_classpath", []))
        info = bridge.connect(entry["url"], entry["username"], entry["password"], entry["driver"])
    except jdbc.BridgeError as exc:
        print(f"✗ 连接失败：{exc}")
        return None
    print(f"✓ 已连接：{info.get('product')} {info.get('version')}  "
          f"(catalog={info.get('catalog')}, schema={info.get('schema')}, {info.get('elapsedMs')}ms)")
    return bridge


def build_meta(entry, bridge, limit_tables=120):
    meta = {
        "type": entry["type"], "typeLabel": entry["typeLabel"],
        "database": entry["database"], "schema": entry.get("schema"), "tables": {},
    }
    schema = entry.get("schema")
    try:
        tables = bridge.tables(schema=schema)
    except Exception as exc:  # noqa: BLE001
        print(f"[warn] 获取表列表失败：{exc}")
        return meta
    if not tables and schema:
        try:
            schemas = bridge.schemas()
            if schema in schemas:
                tables = bridge.tables(schema=schema)
        except Exception:  # noqa: BLE001
            pass
    for name in tables[:limit_tables]:
        try:
            cols = bridge.columns(name, schema=schema)
            meta["tables"][name] = [c["name"] for c in cols]
        except Exception:  # noqa: BLE001
            meta["tables"][name] = []
    return meta


# ---------------------------------------------------------------- run query
def run_nl(cfg, entry, bridge, meta, question, history, max_rows, explain):
    print("… 正在把自然语言转成 SQL")
    try:
        result = llm.generate_sql(cfg, question, meta, history)
    except llm.LLMError as exc:
        print(f"✗ {exc}")
        return history
    sql = result["sql"]
    print(f"\n[SQL] {sql}")
    if result.get("explanation"):
        print(f"[说明] {result['explanation']}")
    try:
        resp = bridge.query(sql, max_rows)
    except jdbc.BridgeError as exc:
        print(f"✗ 执行失败：{exc}")
        return history
    cols, rows = resp.get("columns", []), resp.get("rows", [])
    if cols:
        print_table(cols, rows)
        print(f"({len(rows)} 行, {resp.get('elapsedMs')}ms)")
        if explain and rows:
            try:
                print("\n[结论] " + llm.summarize(cfg, question, cols, rows))
            except llm.LLMError as exc:
                print(f"[warn] 总结失败：{exc}")
    else:
        print(f"执行成功，影响行数：{resp.get('updateCount')}")
    history.append({"role": "user", "content": f"数据库结构：{json.dumps(meta['tables'], ensure_ascii=False)}\n用户需求：{question}"})
    history.append({"role": "assistant", "content": json.dumps(result, ensure_ascii=False)})
    return history


def run_sql(bridge, sql, max_rows):
    try:
        resp = bridge.query(sql, max_rows)
    except jdbc.BridgeError as exc:
        print(f"✗ 执行失败：{exc}")
        return
    cols, rows = resp.get("columns", []), resp.get("rows", [])
    if cols:
        print_table(cols, rows)
        print(f"({len(rows)} 行, {resp.get('elapsedMs')}ms)")
    else:
        print(f"执行成功，影响行数：{resp.get('updateCount')}")


# ---------------------------------------------------------------- repl
def repl(cfg, entry, bridge):
    meta = build_meta(entry, bridge)
    print(f"\n已就绪：{len(meta['tables'])} 张表可用。直接输入自然语言即可查询。")
    print("命令：:tables 列所有表 | :schema <表> 看字段 | :sql <SQL> 执行原始SQL | "
          ":meta 重新加载结构 | :switch 换数据源 | :exit 退出\n")
    history = []
    max_rows = cfg.get("max_rows", 200)
    while True:
        try:
            raw = input("db> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not raw:
            continue
        if raw in (":exit", ":q", "exit", "quit"):
            break
        if raw == ":tables":
            t = bridge.tables()
            print(f"共 {len(t)} 张表：")
            for i in range(0, len(t), 4):
                print("  " + "  ".join(x.ljust(28) for x in t[i:i + 4]))
            continue
        if raw.startswith(":schema"):
            table = raw.split(maxsplit=1)[1] if len(raw.split()) > 1 else ""
            if table:
                for c in bridge.columns(table):
                    print(f"  {c['name']:<30} {c['type']}({c['size']})  {'NULL' if c['nullable'] else 'NOT NULL'}")
            continue
        if raw.startswith(":sql"):
            run_sql(bridge, raw[4:].strip(), max_rows)
            continue
        if raw == ":meta":
            meta = build_meta(entry, bridge)
            print(f"结构已刷新，共 {len(meta['tables'])} 张表。")
            continue
        if raw == ":switch":
            return "switch"
        if raw.lower().startswith(SQL_HINT) and " " in raw:
            run_sql(bridge, raw, max_rows)
            continue
        history = run_nl(cfg, entry, bridge, meta, raw, history, max_rows, cfg.get("explain", False))
    return "exit"


# ---------------------------------------------------------------- commands
def cmd_list(args, cfg):
    entries = filter_entries(load_catalog(cfg, args.refresh), args)
    if not entries:
        print("没有匹配的数据源。")
        return
    all_entries = load_catalog(cfg, args.refresh)
    print(f"共 {len(entries)} 个数据源（root={cfg['projects_root']}）")
    print_catalog(entries)
    if not (args.project or args.profile or args.type or args.id):
        nodb = catalog.projects_without_db(cfg["projects_root"], all_entries)
        if nodb:
            print(f"\n■ 未发现数据库配置的项目（{len(nodb)} 个）")
            print("  " + "、".join(nodb))


def cmd_catalog(args, cfg):
    entries = filter_entries(load_catalog(cfg, args.refresh), args)
    print(json.dumps(entries, ensure_ascii=False, indent=2))


def _resolve_one(args, cfg):
    entries = load_catalog(cfg, args.refresh)
    if args.id:
        cand = [e for e in entries if e["id"] == args.id]
        if cand:
            return cand[0]
    filtered = filter_entries(entries, args)
    if len(filtered) == 1:
        return filtered[0]
    if not args.project and not args.profile and not args.type and not args.id:
        return interactive_select(entries, cfg)
    if not filtered:
        print("没有匹配的数据源。")
        return None
    return interactive_select(filtered, cfg)


def cmd_query(args, cfg):
    entry = _resolve_one(args, cfg)
    if not entry:
        return
    bridge = do_connect(entry, cfg)
    if not bridge:
        return
    try:
        meta = build_meta(entry, bridge)
        run_nl(cfg, entry, bridge, meta, args.question, [], args.max_rows, args.explain)
    finally:
        bridge.close()


def cmd_sql(args, cfg):
    entry = _resolve_one(args, cfg)
    if not entry:
        return
    bridge = do_connect(entry, cfg)
    if not bridge:
        return
    try:
        run_sql(bridge, args.sql, args.max_rows)
    finally:
        bridge.close()


def cmd_interactive(args, cfg):
    entries = load_catalog(cfg, args.refresh)
    while True:
        entry = interactive_select(entries, cfg)
        bridge = do_connect(entry, cfg)
        if not bridge:
            continue
        try:
            action = repl(cfg, entry, bridge)
            if action != "switch":
                return
        finally:
            bridge.close()


def build_parser():
    p = argparse.ArgumentParser(prog="dbquery", description="跨项目数据库自然语言查询工具")
    sub = p.add_subparsers(dest="cmd")

    def common(sp):
        sp.add_argument("--project", help="按项目名过滤")
        sp.add_argument("--profile", help="按配置/profile 过滤")
        sp.add_argument("--type", help="按数据库类型过滤 (mysql/dm/oracle/postgresql/hive2)")
        sp.add_argument("--id", help="直接指定数据源 id")
        sp.add_argument("--refresh", action="store_true", help="重新扫描项目")

    sp = sub.add_parser("list", help="罗列所有数据源")
    common(sp)

    sp = sub.add_parser("catalog", help="输出 JSON 目录")
    common(sp)

    sp = sub.add_parser("query", help="用自然语言查询")
    sp.add_argument("question")
    sp.add_argument("--max-rows", type=int, default=200)
    sp.add_argument("--explain", action="store_true", help="让模型总结结果")
    common(sp)

    sp = sub.add_parser("sql", help="执行原始 SQL")
    sp.add_argument("sql")
    sp.add_argument("--max-rows", type=int, default=200)
    common(sp)

    sp = sub.add_parser("interactive", help="进入交互模式（默认）")
    common(sp)
    return p


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    cfg = config.load()
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.cmd == "list":
        cmd_list(args, cfg)
    elif args.cmd == "catalog":
        cmd_catalog(args, cfg)
    elif args.cmd == "query":
        cmd_query(args, cfg)
    elif args.cmd == "sql":
        cmd_sql(args, cfg)
    else:
        cmd_interactive(args, cfg)


if __name__ == "__main__":
    main()
