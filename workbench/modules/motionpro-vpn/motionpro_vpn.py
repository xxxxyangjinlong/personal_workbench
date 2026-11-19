"""MotionPro VPN 控制核心（macOS，工作台自定义模块）。

MotionPro 自带命令行客户端 ``/usr/local/bin/MotionPro``（指向
``/usr/local/motionpro/vpn_cmdline``），本模块在它的基础上提供：

- ``status()``：无副作用地查询连接状态；
- ``connect()`` / ``disconnect()``：非交互连接、断开；
- ``ensure_connected()``：调用时已连接则跳过，否则连接。

密码读取顺序：``MOTIONPRO_PASSWORD`` 环境变量 > macOS 钥匙串。密码不会写入日志。
"""
from __future__ import annotations

import json
import logging
import os
import re
import signal
import subprocess
import time
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Callable, Mapping, Sequence

logger = logging.getLogger(__name__)

MODULE_ROOT = Path(__file__).resolve().parent


def module_data_dir() -> Path:
    """模块数据目录；宿主运行与命令行运行共用同一份配置和日志。"""
    configured = os.getenv("FIREFLY_MODULE_DATA_DIR") or os.getenv("WORKBENCH_MODULE_DATA_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    return (MODULE_ROOT.parents[1] / "data" / "modules" / MODULE_ROOT.name).resolve()


def default_log_dir() -> Path:
    return module_data_dir() / "logs"


class VpnState(str, Enum):
    """MotionPro 上报的连接状态。"""

    IDLE = "idle"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    DISCONNECTING = "disconnecting"
    RECONNECTING = "reconnecting"
    DISCONNECTED = "disconnected"
    BOTH_CONNECTED = "both_connected"
    UNKNOWN = "unknown"


_STATE_BY_CODE: dict[int, VpnState] = {
    0: VpnState.IDLE,
    1: VpnState.CONNECTING,
    2: VpnState.CONNECTED,
    3: VpnState.DISCONNECTING,
    4: VpnState.RECONNECTING,
    5: VpnState.DISCONNECTED,
    6: VpnState.BOTH_CONNECTED,
    7: VpnState.DISCONNECTED,
}

CONNECTED_STATES = frozenset({VpnState.CONNECTED, VpnState.BOTH_CONNECTED})
TRANSITION_STATES = frozenset({VpnState.CONNECTING, VpnState.RECONNECTING, VpnState.DISCONNECTING})

_STATUS_RE = re.compile(r"VPN status:\s*(-?\d+)")


class MotionProError(RuntimeError):
    """MotionPro 操作失败。"""


class ConfigurationError(MotionProError):
    """host/username 等必要配置缺失。"""


class CredentialsMissing(MotionProError):
    """钥匙串和环境变量里都没有密码。"""


class MotionProTimeout(MotionProError):
    """等待连接/断开超时。"""


@dataclass(frozen=True)
class VpnStatus:
    state: VpnState
    code: int | None = None
    raw: str = ""
    error: str | None = None

    @property
    def connected(self) -> bool:
        return self.state in CONNECTED_STATES

    def to_dict(self) -> dict[str, object]:
        return {
            "state": self.state.value,
            "code": self.code,
            "connected": self.connected,
            "error": self.error,
        }


def parse_status(output: str) -> tuple[VpnState, int | None]:
    """从 ``MotionPro getstatus`` 输出中解析状态码。"""
    match = _STATUS_RE.search(output or "")
    if not match:
        return VpnState.UNKNOWN, None
    code = int(match.group(1))
    return _STATE_BY_CODE.get(code, VpnState.UNKNOWN), code


def read_keychain_password(service: str, account: str) -> str | None:
    """从 macOS 钥匙串读取密码；不存在时返回 None。"""
    try:
        proc = subprocess.run(
            ["security", "find-generic-password", "-a", account, "-s", service, "-w"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    value = proc.stdout.rstrip("\r\n")
    return value or None


def store_keychain_password(service: str, account: str, password: str) -> None:
    """把密码写入 macOS 钥匙串，并读回校验；密码只通过 stdin 传递。"""
    if not service or not account:
        raise ConfigurationError("保存密码前需要先配置 VPN 用户名和钥匙串服务名")
    if not password:
        raise ValueError("密码不能为空")
    if "\n" in password or "\r" in password:
        raise ValueError("密码不能包含换行")
    try:
        proc = subprocess.run(
            ["security", "add-generic-password", "-U", "-a", account, "-s", service, "-w"],
            input=f"{password}\n{password}\n",
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise MotionProError("无法执行 macOS security 命令") from exc
    if proc.returncode != 0:
        raise MotionProError("写入 macOS 钥匙串失败（可能已取消）")
    stored = read_keychain_password(service, account)
    if stored != password:
        raise MotionProError("写入钥匙串后校验失败，请重试")


def _load_env_file(path: Path) -> None:
    """极简 .env 加载：只补充尚未存在的环境变量。"""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


@dataclass(frozen=True)
class MotionProConfig:
    binary: str = "/usr/local/bin/MotionPro"
    lib_dir: str = "/usr/local/motionpro"
    host: str = ""
    username: str = ""
    password: str | None = field(default=None, repr=False)
    keychain_service: str = "motionpro-vpn"
    connect_timeout: float = 90.0
    poll_interval: float = 2.0
    status_timeout: float = 10.0

    @classmethod
    def load(cls, env_file: Path | None = None) -> "MotionProConfig":
        data_dir = module_data_dir()
        config_file = data_dir / "config.json"
        file_config: dict[str, object] = {}
        try:
            value = json.loads(config_file.read_text(encoding="utf-8"))
            if isinstance(value, dict):
                file_config = value
        except (OSError, json.JSONDecodeError):
            file_config = {}
        if env_file:
            _load_env_file(env_file)

        def value(key: str, env_key: str, default: object) -> object:
            env_value = os.getenv(env_key)
            if env_value not in (None, ""):
                return env_value
            if key in file_config and file_config[key] not in (None, ""):
                return file_config[key]
            return default

        return cls(
            binary=str(value("binary", "MOTIONPRO_BIN", "/usr/local/bin/MotionPro")),
            lib_dir=str(value("libDir", "MOTIONPRO_LIB_DIR", "/usr/local/motionpro")),
            host=str(value("host", "MOTIONPRO_HOST", "")).strip(),
            username=str(value("username", "MOTIONPRO_USER", "")).strip(),
            password=str(os.getenv("MOTIONPRO_PASSWORD") or file_config.get("password") or "") or None,
            keychain_service=str(value("keychainService", "MOTIONPRO_KEYCHAIN_SERVICE", "motionpro-vpn")),
            connect_timeout=float(value("connectTimeout", "MOTIONPRO_CONNECT_TIMEOUT", 90)),
            poll_interval=float(value("pollInterval", "MOTIONPRO_POLL_INTERVAL", 2)),
            status_timeout=float(value("statusTimeout", "MOTIONPRO_STATUS_TIMEOUT", 10)),
        )

    def validate_credentials(self) -> None:
        missing = []
        if not self.host:
            missing.append("MOTIONPRO_HOST")
        if not self.username:
            missing.append("MOTIONPRO_USER")
        if missing:
            raise ConfigurationError(f"缺少配置：{', '.join(missing)}（模块页面或 data/modules/motionpro-vpn/config.json）")


Runner = Callable[[Sequence[str], Mapping[str, str], float], subprocess.CompletedProcess[str]]


class MotionProVpn:
    """MotionPro VPN 控制器。"""

    def __init__(
        self,
        config: MotionProConfig,
        *,
        runner: Runner | None = None,
        password_reader: Callable[[], str | None] | None = None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        log_dir: Path | None = None,
    ) -> None:
        self.config = config
        self._runner = runner or self._run
        self._password_reader = password_reader
        self._sleep = sleep
        self._clock = clock
        self._log_dir = log_dir or default_log_dir()

    # ---------------------------------------------------------------- status
    def status(self) -> VpnStatus:
        try:
            proc = self._runner(
                [self.config.binary, "getstatus"],
                self._env(),
                self.config.status_timeout,
            )
        except FileNotFoundError:
            return VpnStatus(VpnState.UNKNOWN, error=f"未找到 MotionPro：{self.config.binary}")
        except subprocess.TimeoutExpired:
            return VpnStatus(VpnState.UNKNOWN, error="查询 MotionPro 状态超时")
        except OSError as exc:
            return VpnStatus(VpnState.UNKNOWN, error=f"无法执行 MotionPro：{exc}")

        raw = f"{proc.stdout or ''}{proc.stderr or ''}".strip()
        state, code = parse_status(raw)
        error = None
        if state is VpnState.UNKNOWN and proc.returncode != 0:
            error = raw or f"getstatus 退出码 {proc.returncode}"
        return VpnStatus(state, code=code, raw=raw, error=error)

    def is_connected(self) -> bool:
        return self.status().connected

    # --------------------------------------------------------------- connect
    def ensure_connected(self) -> VpnStatus:
        """已连接则直接返回，否则等待连接完成。"""
        current = self.status()
        if current.connected:
            return current
        return self.connect(wait=True)

    def connect(self, wait: bool = True) -> VpnStatus:
        current = self.status()
        if current.state in CONNECTED_STATES:
            return current
        if current.state in TRANSITION_STATES:
            if wait:
                return self._wait_for_connected(self.config.connect_timeout, None)
            return current

        password = self.resolve_password()
        try:
            proc = self._spawn_connect(password)
        except OSError as exc:
            raise MotionProError(f"启动 MotionPro 失败：{exc}") from exc
        if not wait:
            return self.status()

        try:
            status = self._wait_for_connected(self.config.connect_timeout, proc)
        except MotionProError:
            self._stop_process(proc)
            raise

        if proc.poll() is None:
            self._write_pid(proc.pid)
        else:
            self._pid_path.unlink(missing_ok=True)
        return status

    def build_connect_command(self, password: str) -> list[str]:
        self.config.validate_credentials()
        return [
            self.config.binary,
            "-h", self.config.host,
            "-u", self.config.username,
            "-p", password,
        ]

    def resolve_password(self) -> str:
        if self.config.password:
            return self.config.password
        if self._password_reader is not None:
            value = self._password_reader()
        else:
            value = read_keychain_password(self.config.keychain_service, self.config.username)
        if not value:
            raise CredentialsMissing(
                "未找到 MotionPro 密码。请先运行："
                "python3 scripts/vpnctl.py login"
            )
        return value

    # ------------------------------------------------------------ disconnect
    def disconnect(self, keep_session: bool = False) -> VpnStatus:
        """断开 VPN；``keep_session=True`` 对应 MotionPro 的 ``-b``。"""
        self._terminate_tracked_process()
        flag = "-b" if keep_session else "-s"
        try:
            self._runner([self.config.binary, flag], self._env(), 30.0)
        except (OSError, subprocess.SubprocessError) as exc:
            raise MotionProError(f"断开 MotionPro 失败：{exc}") from exc
        try:
            return self._wait_for_state({VpnState.IDLE, VpnState.DISCONNECTED}, 20.0)
        except MotionProTimeout:
            return self.status()

    # -------------------------------------------------------------- internal
    def _env(self) -> dict[str, str]:
        env = os.environ.copy()
        if self.config.lib_dir:
            old = env.get("DYLD_LIBRARY_PATH")
            env["DYLD_LIBRARY_PATH"] = (
                f"{self.config.lib_dir}:{old}" if old else self.config.lib_dir
            )
        return env

    def _run(
        self, cmd: Sequence[str], env: Mapping[str, str], timeout: float
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=dict(env))

    def _spawn_connect(self, password: str) -> subprocess.Popen[bytes]:
        self._log_dir.mkdir(parents=True, exist_ok=True)
        log_path = self._log_dir / "motionpro-vpn.log"
        with log_path.open("ab") as log:
            header = f"\n===== {datetime.now():%Y-%m-%d %H:%M:%S} 自动连接 =====\n"
            log.write(header.encode("utf-8"))
            log.flush()
            proc = subprocess.Popen(
                self.build_connect_command(password),
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                env=self._env(),
                start_new_session=True,
            )
        logger.info("已启动 MotionPro 连接进程（pid=%s，日志 %s）", proc.pid, log_path)
        return proc

    def _wait_for_connected(
        self, timeout: float, proc: subprocess.Popen[bytes] | None
    ) -> VpnStatus:
        deadline = self._clock() + timeout
        while True:
            status = self.status()
            if status.connected:
                logger.info("MotionPro VPN 已连接")
                return status
            if proc is not None and proc.poll() is not None and status.state not in TRANSITION_STATES:
                raise MotionProError(
                    f"连接进程已退出（code={proc.returncode}），当前状态 {status.state.value}；"
                    f"详见 {self._log_dir / 'motionpro-vpn.log'}"
                )
            if self._clock() >= deadline:
                raise MotionProTimeout(
                    f"等待 MotionPro 连接超时（{timeout:.0f}s，当前状态 {status.state.value}）"
                )
            self._sleep(self.config.poll_interval)

    def _wait_for_state(self, targets: set[VpnState], timeout: float) -> VpnStatus:
        deadline = self._clock() + timeout
        while True:
            status = self.status()
            if status.state in targets:
                return status
            if self._clock() >= deadline:
                raise MotionProTimeout(f"等待 VPN 状态变化超时（当前 {status.state.value}）")
            self._sleep(self.config.poll_interval)

    @property
    def _pid_path(self) -> Path:
        return self._log_dir / "motionpro-vpn.pid"

    def _write_pid(self, pid: int) -> None:
        self._log_dir.mkdir(parents=True, exist_ok=True)
        self._pid_path.write_text(str(pid), encoding="utf-8")

    def _read_pid(self) -> int | None:
        try:
            return int(self._pid_path.read_text(encoding="utf-8").strip())
        except (OSError, ValueError):
            return None

    def _terminate_tracked_process(self) -> None:
        pid = self._read_pid()
        if pid and self._is_motionpro_process(pid):
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        self._pid_path.unlink(missing_ok=True)

    @staticmethod
    def _is_motionpro_process(pid: int) -> bool:
        """避免 PID 复用时误杀其他进程。"""
        try:
            proc = subprocess.run(
                ["ps", "-p", str(pid), "-o", "comm="],
                capture_output=True,
                text=True,
                timeout=3,
            )
        except (OSError, subprocess.SubprocessError):
            return False
        command = proc.stdout.strip()
        return "MotionPro" in command or "vpn_cmdline" in command

    @staticmethod
    def _stop_process(proc: subprocess.Popen[bytes]) -> None:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()

