"""驱动类路径解析 + 与 Java JDBC 桥通讯的客户端。"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLASSES = ROOT / "bridge" / "classes"
M2 = Path.home() / ".m2" / "repository"

# 每个类型：single = 取最新版本的一个 jar；multi = 每个模式各取最新
DRIVER_JARS = {
    "mysql": {
        "single": [
            "mysql/mysql-connector-java/*/mysql-connector-java-*.jar",
            "com/mysql/mysql-connector-j/*/mysql-connector-j-*.jar",
        ],
    },
    "dm": {
        "single": [
            "com/dameng/*/*/DmJdbcDriver*.jar",
        ],
    },
    "oracle": {
        "single": [
            "com/oracle/database/jdbc/ojdbc8/*/ojdbc8-*.jar",
            "com/oracle/database/jdbc/ojdbc11/*/ojdbc11-*.jar",
            "com/oracle/ojdbc/*/*.jar",
            "com/oracle/database/jdbc/ojdbc6/*/ojdbc6-*.jar",
        ],
    },
    "postgresql": {
        "single": ["org/postgresql/postgresql/*/postgresql-*.jar"],
    },
    "sqlserver": {
        "single": ["com/microsoft/sqlserver/mssql-jdbc/*/mssql-jdbc-*.jar"],
    },
    "h2": {
        "single": ["com/h2database/h2/*/h2-*.jar"],
    },
    "hive2": {
        "multi": [
            "org/apache/hive/hive-jdbc/*/hive-jdbc-*.jar",
            "org/apache/hive/hive-service/*/hive-service-*.jar",
            "org/apache/hive/hive-common/*/hive-common-*.jar",
            "org/apache/hive/hive-shims/*/hive-shims-*.jar",
            "org/apache/hadoop/hadoop-common/*/hadoop-common-*.jar",
            "org/apache/hadoop/hadoop-auth/*/hadoop-auth-*.jar",
            "org/apache/thrift/libthrift/*/libthrift-*.jar",
        ],
    },
}


def _version_key(path: Path):
    nums = re.findall(r"\d+", path.parent.name)
    return [int(n) for n in nums] or [0]


def _pick(patterns, root=M2):
    jars = []
    for pat in patterns:
        matches = [p for p in root.glob(pat)
                   if "sources" not in p.name and "javadoc" not in p.name]
        if matches:
            matches.sort(key=_version_key)
            jars.append(matches[-1])
    return jars


def resolve_classpath(dbtype, extra=()):
    jars = []
    cfg = DRIVER_JARS.get(dbtype, {})
    if "single" in cfg:
        jars.extend(_pick(cfg["single"]))
    if "multi" in cfg:
        jars.extend(_pick(cfg["multi"]))
    result = [str(CLASSES)]
    result += [str(j) for j in jars]
    result += [str(Path(p).expanduser()) for p in extra]
    return ":".join(result)


def missing_driver(dbtype):
    cfg = DRIVER_JARS.get(dbtype, {})
    if not cfg:
        return True
    if "single" in cfg and not _pick(cfg["single"]):
        return True
    return False


class BridgeError(Exception):
    pass


class Bridge:
    """常驻 Java 进程，保持一个数据库连接，可执行多条查询。"""

    def __init__(self, dbtype, extra_classpath=()):
        if missing_driver(dbtype):
            raise BridgeError(f"未在 ~/.m2 找到 {dbtype} 的 JDBC 驱动，请在 config.json 里配置 extra_classpath")
        classpath = resolve_classpath(dbtype, extra_classpath)
        self.proc = subprocess.Popen(
            ["java", "-cp", classpath, "JdbcBridge"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self.ping()

    def _send(self, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.proc.stdin.write(str(len(data)).encode("ascii") + b"\n")
        self.proc.stdin.write(data)
        self.proc.stdin.flush()

    def _recv(self):
        line = self.proc.stdout.readline()
        if not line:
            err = self.proc.stderr.read().decode("utf-8", "ignore")
            raise BridgeError(f"Java 桥异常退出: {err[:500]}")
        length = int(line.strip())
        buf = self.proc.stdout.read(length)
        return json.loads(buf.decode("utf-8"))

    def call(self, **kwargs):
        self._send(kwargs)
        resp = self._recv()
        if not resp.get("ok"):
            raise BridgeError(resp.get("error", "未知错误"))
        return resp

    def ping(self):
        return self.call(action="ping")

    def connect(self, url, user=None, password=None, driver=None):
        return self.call(action="connect", url=url, user=user, password=password, driver=driver)

    def query(self, sql, max_rows=200):
        return self.call(action="query", sql=sql, maxRows=max_rows)

    def info(self):
        return self.call(action="info")

    def schemas(self):
        return self.call(action="schemas").get("schemas", [])

    def tables(self, schema=None):
        return self.call(action="tables", schema=schema).get("tables", [])

    def columns(self, table, schema=None):
        return self.call(action="columns", table=table, schema=schema).get("columns", [])

    def close(self):
        try:
            self._send({"action": "close"})
            self._recv()
        except Exception:  # noqa: BLE001
            pass
        finally:
            try:
                self.proc.stdin.close()
            except Exception:  # noqa: BLE001
                pass
            self.proc.terminate()
