"""MotionPro VPN 模块单元测试：不访问真实网络，也不操作真实 VPN。"""
from __future__ import annotations

import json
import subprocess

import pytest

from motionpro_vpn import (
    CONNECTED_STATES,
    ConfigurationError,
    CredentialsMissing,
    MotionProConfig,
    MotionProError,
    MotionProVpn,
    VpnState,
    VpnStatus,
    parse_status,
    store_keychain_password,
)


def completed(stdout: str = "", stderr: str = "", returncode: int = 0):
    return subprocess.CompletedProcess(
        args=[], returncode=returncode, stdout=stdout, stderr=stderr
    )


def make_vpn(runner, **kwargs) -> MotionProVpn:
    config = kwargs.pop(
        "config",
        MotionProConfig(host="vpn.example.com", username="tester"),
    )
    kwargs.setdefault("password_reader", lambda: "secret")
    return MotionProVpn(config, runner=runner, **kwargs)


# ---------------------------------------------------------------- status
def test_parse_status_connected():
    assert parse_status("VPN status:2\n(0:idle;1:connecting;...)") == (
        VpnState.CONNECTED, 2,
    )


@pytest.mark.parametrize(
    ("code", "state"),
    [
        (0, VpnState.IDLE),
        (1, VpnState.CONNECTING),
        (2, VpnState.CONNECTED),
        (3, VpnState.DISCONNECTING),
        (4, VpnState.RECONNECTING),
        (5, VpnState.DISCONNECTED),
        (6, VpnState.BOTH_CONNECTED),
        (7, VpnState.DISCONNECTED),
    ],
)
def test_parse_status_codes(code, state):
    assert parse_status(f"VPN status:{code}") == (state, code)


def test_parse_status_unknown():
    assert parse_status("boom") == (VpnState.UNKNOWN, None)


def test_status_uses_getstatus_and_sets_dyld_path():
    calls = []

    def runner(cmd, env, timeout):
        calls.append((list(cmd), dict(env), timeout))
        return completed("VPN status:2")

    vpn = make_vpn(runner)
    status = vpn.status()
    assert status.state is VpnState.CONNECTED
    assert status.code == 2
    assert calls[0][0][-1] == "getstatus"
    assert "/usr/local/motionpro" in calls[0][1]["DYLD_LIBRARY_PATH"]


def test_status_reports_command_error():
    vpn = make_vpn(lambda cmd, env, timeout: completed("not found", returncode=1))
    status = vpn.status()
    assert status.state is VpnState.UNKNOWN
    assert status.error == "not found"


def test_status_missing_binary():
    def runner(cmd, env, timeout):
        raise FileNotFoundError

    status = make_vpn(runner).status()
    assert status.state is VpnState.UNKNOWN
    assert "未找到 MotionPro" in status.error


def test_connected_states_include_both_connected():
    assert VpnState.CONNECTED in CONNECTED_STATES
    assert VpnState.BOTH_CONNECTED in CONNECTED_STATES
    assert VpnState.DISCONNECTED not in CONNECTED_STATES


# -------------------------------------------------------------- password
def test_password_prefers_config():
    called = []
    vpn = make_vpn(
        runner=None,
        config=MotionProConfig(password="from-env", host="h", username="u"),
        password_reader=lambda: called.append(True) or "from-keychain",
    )
    assert vpn.resolve_password() == "from-env"
    assert called == []


def test_password_falls_back_to_keychain_reader():
    vpn = make_vpn(
        runner=None,
        config=MotionProConfig(host="h", username="u"),
        password_reader=lambda: "from-keychain",
    )
    assert vpn.resolve_password() == "from-keychain"


def test_password_missing_raises():
    vpn = make_vpn(
        runner=None,
        config=MotionProConfig(host="h", username="u"),
        password_reader=lambda: None,
    )
    with pytest.raises(CredentialsMissing):
        vpn.resolve_password()


def test_password_not_in_config_repr():
    assert "super-secret" not in repr(MotionProConfig(password="super-secret"))


def test_config_loads_module_json_and_env_overrides(tmp_path, monkeypatch):
    (tmp_path / "config.json").write_text(
        json.dumps({"host": "file.example.com", "username": "file-user"}),
        encoding="utf-8",
    )
    monkeypatch.setenv("FIREFLY_MODULE_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("MOTIONPRO_HOST", raising=False)
    monkeypatch.delenv("MOTIONPRO_USER", raising=False)
    config = MotionProConfig.load()
    assert (config.host, config.username) == ("file.example.com", "file-user")

    monkeypatch.setenv("MOTIONPRO_HOST", "env.example.com")
    assert MotionProConfig.load().host == "env.example.com"


def test_store_keychain_password_uses_stdin_and_verifies(monkeypatch):
    calls = {}

    def fake_run(cmd, **kwargs):
        calls["cmd"] = list(cmd)
        calls["kwargs"] = kwargs
        return completed()

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr("motionpro_vpn.read_keychain_password", lambda service, account: "new-secret")
    store_keychain_password("vpn-service", "tester", "new-secret")
    assert calls["cmd"] == [
        "security", "add-generic-password", "-U",
        "-a", "tester", "-s", "vpn-service", "-w",
    ]
    assert calls["kwargs"]["input"] == "new-secret\nnew-secret\n"
    assert "new-secret" not in calls["cmd"]


def test_store_keychain_password_rejects_unverified_value(monkeypatch):
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda cmd, **kwargs: completed(),
    )
    monkeypatch.setattr("motionpro_vpn.read_keychain_password", lambda service, account: "other")
    with pytest.raises(MotionProError):
        store_keychain_password("vpn-service", "tester", "new-secret")


# --------------------------------------------------------------- connect
def test_build_connect_command():
    vpn = make_vpn(None)
    assert vpn.build_connect_command("pw with space") == [
        "/usr/local/bin/MotionPro",
        "-h", "vpn.example.com",
        "-u", "tester",
        "-p", "pw with space",
    ]


def test_connect_requires_host_and_user():
    vpn = make_vpn(None, config=MotionProConfig())
    with pytest.raises(ConfigurationError):
        vpn.build_connect_command("pw")


def test_ensure_connected_skips_when_connected():
    class Stub(MotionProVpn):
        connect_calls = 0

        def status(self):
            return VpnStatus(VpnState.CONNECTED, code=2)

        def connect(self, wait=True):
            self.connect_calls += 1
            return self.status()

    vpn = Stub(MotionProConfig(host="h", username="u"))
    assert vpn.ensure_connected().connected
    assert vpn.connect_calls == 0


class FakeClock:
    def __init__(self):
        self.value = 0.0

    def __call__(self):
        return self.value

    def sleep(self, seconds):
        self.value += seconds


class FakeProc:
    pid = 4321
    returncode = None

    def poll(self):
        return None

    def terminate(self):
        pass

    def kill(self):
        pass

    def wait(self, timeout=None):
        return 0


def test_connect_waits_until_connected(tmp_path):
    clock = FakeClock()
    states = iter([VpnStatus(VpnState.DISCONNECTED, code=7), VpnStatus(VpnState.CONNECTED, code=2)])
    spawned = {}

    vpn = make_vpn(
        lambda cmd, env, timeout: completed("VPN status:2"),
        config=MotionProConfig(host="h", username="u", connect_timeout=10, poll_interval=1),
        clock=clock,
        sleep=clock.sleep,
        log_dir=tmp_path,
    )
    vpn.status = lambda: next(states)  # type: ignore[method-assign]

    def fake_spawn(password):
        spawned["password"] = password
        return FakeProc()

    vpn._spawn_connect = fake_spawn  # type: ignore[method-assign]
    status = vpn.connect(wait=True)
    assert status.connected
    assert spawned["password"] == "secret"
    assert (tmp_path / "motionpro-vpn.pid").read_text() == "4321"
