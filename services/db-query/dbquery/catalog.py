"""扫描项目目录下的配置文件，抽取所有 JDBC 数据源，形成可选择的目录。"""
import hashlib
import json
import re
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    yaml = None

CONFIG_GLOBS = ("application*.yml", "application*.yaml", "application*.properties",
                "bootstrap*.yml", "bootstrap*.yaml", "bootstrap*.properties")
JDBC_RE = re.compile(r"jdbc:([a-zA-Z0-9]+):", re.I)
# Spring: ${VAR:default} / ${VAR}；Docker: ${VAR:-default}
PLACEHOLDER_RE = re.compile(r"\$\{([^}:]+)(?::(-?[^}]*))?\}")


def resolve_placeholders(value):
    """把 ${VAR:default} 解成 default；没有默认值的记录为未解析。返回 (值, [未解析变量名])。"""
    unresolved = []

    def repl(m):
        if m.group(2) is not None and m.group(2) != "":
            d = m.group(2)
            return d[1:] if d.startswith("-") else d
        unresolved.append(m.group(1))
        return ""

    return PLACEHOLDER_RE.sub(repl, value), unresolved

TYPE_LABELS = {
    "mysql": "MySQL",
    "dm": "达梦 DM",
    "oracle": "Oracle",
    "postgresql": "PostgreSQL",
    "hive2": "Hive",
    "sqlserver": "SQLServer",
    "h2": "H2",
}

DRIVER_HINTS = {
    "mysql": "com.mysql.cj.jdbc.Driver",
    "dm": "dm.jdbc.driver.DmDriver",
    "oracle": "oracle.jdbc.OracleDriver",
    "postgresql": "org.postgresql.Driver",
    "hive2": "org.apache.hive.jdbc.HiveDriver",
    "sqlserver": "com.microsoft.sqlserver.jdbc.SQLServerDriver",
    "h2": "org.h2.Driver",
}


# ---------------------------------------------------------------- flatten
def _flatten(prefix, node, out):
    if isinstance(node, dict):
        for k, v in node.items():
            key = f"{prefix}.{k}" if prefix else str(k)
            _flatten(key, v, out)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            _flatten(f"{prefix}.{i}", v, out)
    elif node is not None:
        out[prefix] = node


def parse_file(path):
    """返回 (扁平字典, {key: [未解析变量名]})。"""
    text = path.read_text(encoding="utf-8", errors="ignore")
    flat = {}
    if path.suffix in (".yml", ".yaml"):
        if yaml is None:
            return flat, {}
        try:
            data = yaml.safe_load(text) or {}
        except Exception:  # noqa: BLE001
            return flat, {}
        _flatten("", data, flat)
    else:
        for raw in text.splitlines():
            line = raw.strip()
            if not line or line[0] in "#!":
                continue
            if "=" not in line:
                continue
            k, v = line.split("=", 1)
            flat[k.strip()] = v.strip()
    unresolved_map = {}
    for k, v in list(flat.items()):
        if isinstance(v, str) and "${" in v:
            nv, uns = resolve_placeholders(v)
            flat[k] = nv.strip()
            if uns:
                unresolved_map[k] = uns
    return flat, unresolved_map


# ---------------------------------------------------------------- jdbc url
def parse_jdbc(url):
    m = JDBC_RE.match(url.strip())
    if not m:
        return None
    dbtype = m.group(1).lower()
    rest = url.strip()[m.end():]
    info = {"type": dbtype, "host": None, "port": None, "database": None,
            "schema": None, "params": {}, "raw": url.strip()}
    params = {}
    if dbtype in ("mysql", "postgresql", "hive2", "sqlserver"):
        body = rest[2:] if rest.startswith("//") else rest
        if "?" in body:
            body, qs = body.split("?", 1)
            params = dict(p.split("=", 1) for p in qs.split("&") if "=" in p)
        if "/" in body:
            hostport, db = body.split("/", 1)
            info["database"] = db or None
        else:
            hostport = body
        if ":" in hostport:
            info["host"], port = hostport.split(":", 1)
            info["port"] = int(re.sub(r"\D", "", port) or 0) or None
        else:
            info["host"] = hostport or None
    elif dbtype == "dm":
        body = rest[2:] if rest.startswith("//") else rest
        if "?" in body:
            body, qs = body.split("?", 1)
            params = dict(p.split("=", 1) for p in qs.split("&") if "=" in p)
        body = body.strip("/")
        if ":" in body:
            info["host"], port = body.split(":", 1)
            info["port"] = int(re.sub(r"\D", "", port) or 0) or None
        else:
            info["host"] = body or None
    elif dbtype == "oracle":
        # jdbc:oracle:thin:@host:port:SID  或  @//host:port/SERVICE
        body = rest
        if body.lower().startswith("thin:"):
            body = body[5:]
        body = body.lstrip("@")
        if body.startswith("//"):
            body = body[2:]
            if "/" in body:
                hp, svc = body.split("/", 1)
                info["database"] = svc or None
            else:
                hp = body
            if ":" in hp:
                info["host"], port = hp.split(":", 1)
                info["port"] = int(re.sub(r"\D", "", port) or 0) or None
            else:
                info["host"] = hp or None
        elif ":" in body:
            parts = body.split(":")
            info["host"] = parts[0]
            if len(parts) > 1:
                info["port"] = int(re.sub(r"\D", "", parts[1]) or 0) or None
            if len(parts) > 2:
                info["database"] = parts[2]
        else:
            info["host"] = body or None
    info["params"] = params
    info["schema"] = params.get("schema") or params.get("currentSchema")
    if info["port"] is None:
        info["port"] = {"mysql": 3306, "postgresql": 5432, "dm": 5236,
                        "oracle": 1521, "hive2": 10000, "sqlserver": 1433}.get(dbtype)
    return info


# ---------------------------------------------------------------- helpers
def _sibling(flat, url_key):
    """给定 *.url 的 key，找出同一前缀下的用户名/密码。"""
    m = re.search(r"url$", url_key)
    if not m:
        return None, None
    prefix = url_key[: m.start()]
    sep = prefix[-1] if prefix and prefix[-1] in "._-" else "."
    user = pwd = None
    for uk in (prefix + "username", prefix + "user", prefix + "userName"):
        if uk in flat:
            user = flat[uk]
            break
    for pk in (prefix + "password", prefix + "pass", prefix + "pwd"):
        if pk in flat:
            pwd = flat[pk]
            break
    return user, pwd


def _profile_from_name(path):
    name = path.name
    stem = name.rsplit(".", 1)[0]
    if "-" in stem:
        return stem.split("-", 1)[1]
    return "default"


ENV_HINTS = {
    "fat": "联调环境", "pro": "生产环境", "prod": "生产环境", "pre": "预发环境",
    "dev": "开发环境", "local": "本地", "test": "测试环境", "53": "53环境",
    "skxc": "数科现场", "skxcpre": "数科现场预发", "dameng": "达梦", "dm": "达梦",
    "aliyun": "阿里云", "sk": "数科", "jxrs": "江西人社", "wlmq": "乌鲁木齐",
    "nb": "宁波", "jump": "跳板", "sh": "上海", "jsybj": "江苏医保局",
}


def _env_label(profile):
    return ENV_HINTS.get(profile.lower(), profile)


# ---------------------------------------------------------------- scan
def _iter_config_files(root, exclude_dirs):
    excl = set(exclude_dirs)
    for glob in CONFIG_GLOBS:
        for path in root.rglob(glob):
            if any(part in excl for part in path.parts):
                continue
            if path.suffix not in (".yml", ".yaml", ".properties"):
                continue
            yield path


def scan(root, exclude_dirs=("target", "node_modules", ".git")):
    root = Path(root).expanduser()
    entries = []
    seen = set()
    for path in _iter_config_files(root, exclude_dirs):
        flat, unresolved_map = parse_file(path)
        if not flat:
            continue
        rel = path.relative_to(root)
        parts = rel.parts
        project = parts[0]
        module = str(Path(*parts[1:-2])) if len(parts) > 3 else project
        profile = _profile_from_name(path)
        for key, value in flat.items():
            if not isinstance(value, str) or not value.startswith("jdbc:"):
                continue
            info = parse_jdbc(value)
            if not info or not info.get("host"):
                continue
            user, pwd = _sibling(flat, key)
            name = key.split(".")[-2] if "." in key else key
            rec = {
                "project": project,
                "module": module,
                "profile": profile,
                "env": _env_label(profile),
                "file": str(rel),
                "name": name,
                "type": info["type"],
                "typeLabel": TYPE_LABELS.get(info["type"], info["type"]),
                "host": info["host"],
                "port": info["port"],
                "database": info["database"],
                "schema": info["schema"],
                "username": user or "",
                "password": pwd or "",
                "url": info["raw"],
                "driver": DRIVER_HINTS.get(info["type"], ""),
                "placeholder": bool(unresolved_map.get(key)) or "${" in info["raw"],
            }
            dedup = (rec["project"], rec["module"], rec["profile"], rec["url"], rec["username"])
            if dedup in seen:
                continue
            seen.add(dedup)
            rec["id"] = hashlib.sha1(
                "|".join(map(str, dedup)).encode()).hexdigest()[:8]
            entries.append(rec)
    entries.sort(key=lambda r: (r["project"], r["module"], r["profile"], r["type"], r["database"] or ""))
    return entries


def group_by_project(entries):
    grouped = {}
    for e in entries:
        grouped.setdefault(e["project"], []).append(e)
    return grouped


def projects_without_db(root, entries):
    """列出根目录下没有解析到任何数据源的项目目录名。"""
    root = Path(root).expanduser()
    have = {e["project"] for e in entries}
    out = []
    try:
        for d in sorted(root.iterdir()):
            if d.is_dir() and not d.name.startswith(".") and d.name not in have:
                out.append(d.name)
    except FileNotFoundError:
        pass
    return out
