"""MotionPro VPN 工作台模块：MCP 工具 + 状态页面。"""
from __future__ import annotations

import datetime
import json
import os
import subprocess
import sys
from pathlib import Path

from motionpro_vpn import (
    CredentialsMissing,
    MotionProConfig,
    MotionProError,
    MotionProVpn,
    store_keychain_password,
)

ROOT = Path(__file__).resolve().parent
DATA = Path(
    os.environ.get("FIREFLY_MODULE_DATA_DIR")
    or os.environ.get("WORKBENCH_MODULE_DATA_DIR")
    or ROOT.parents[1] / "data" / "modules" / ROOT.name
).expanduser().resolve()
CONFIG_FILE = DATA / "config.json"
UI = "ui://motionpro-vpn/status"


def schema(properties=None, required=None):
    return {
        "type": "object",
        "properties": properties or {},
        "required": required or [],
        "additionalProperties": False,
    }


TOOLS = [
    {
        "name": "vpn_status",
        "description": "查询 MotionPro VPN 当前连接状态",
        "inputSchema": schema(),
        "annotations": {"readOnlyHint": True},
        "_meta": {"ui": {"resourceUri": UI}},
    },
    {
        "name": "vpn_connect",
        "description": "连接 MotionPro VPN；wait=false 时只发起连接，不等待成功",
        "inputSchema": schema({"wait": {"type": "boolean", "default": True}}),
        "annotations": {"idempotentHint": True},
    },
    {
        "name": "vpn_disconnect",
        "description": "断开 MotionPro VPN，断开后保持断开",
        "inputSchema": schema({
            "keepSession": {
                "type": "boolean",
                "default": False,
                "description": "只断开连接但保留会话（MotionPro -b）",
            }
        }),
        "annotations": {"destructiveHint": True},
    },
    {
        "name": "vpn_doctor",
        "description": "检查 MotionPro 安装、配置、密码和连接状态",
        "inputSchema": schema(),
        "annotations": {"readOnlyHint": True},
    },
    {
        "name": "vpn_save_config",
        "description": "保存 MotionPro VPN 地址与用户名（密码仍从 macOS 钥匙串或环境变量读取）",
        "inputSchema": schema({
            "host": {"type": "string", "minLength": 1, "maxLength": 255},
            "username": {"type": "string", "minLength": 1, "maxLength": 255},
            "keychainService": {"type": "string", "minLength": 1, "maxLength": 255},
        }, ["host", "username"]),
        "annotations": {"idempotentHint": True},
    },
    {
        "name": "vpn_set_password",
        "description": "把 MotionPro 密码写入 macOS 钥匙串，之后连接会使用新密码",
        "inputSchema": schema({
            "password": {
                "type": "string",
                "minLength": 1,
                "maxLength": 512,
                "format": "password",
                "writeOnly": True,
            },
            "keychainService": {"type": "string", "minLength": 1, "maxLength": 255},
        }, ["password"]),
        "annotations": {"idempotentHint": True},
    },
]


def now_text() -> str:
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def read_config_file() -> dict:
    try:
        value = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def config_view(config: MotionProConfig) -> dict:
    return {
        "host": config.host,
        "username": config.username,
        "keychainService": config.keychain_service,
        "binary": config.binary,
        "libDir": config.lib_dir,
        "connectTimeout": config.connect_timeout,
        "configured": bool(config.host and config.username),
    }

def status_payload(vpn: MotionProVpn | None = None, config: MotionProConfig | None = None) -> dict:
    config = config or MotionProConfig.load()
    vpn = vpn or MotionProVpn(config)
    status = vpn.status()
    return {
        "status": status.to_dict(),
        "config": config_view(config),
        "checkedAt": now_text(),
    }


def save_config(arguments: dict) -> dict:
    DATA.mkdir(parents=True, exist_ok=True)
    current = read_config_file()
    current.update({
        "host": str(arguments["host"]).strip(),
        "username": str(arguments["username"]).strip(),
    })
    service = str(arguments.get("keychainService") or "").strip()
    if service:
        current["keychainService"] = service
    CONFIG_FILE.write_text(json.dumps(current, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(CONFIG_FILE, 0o600)
    return status_payload()


def doctor_payload() -> dict:
    DATA.mkdir(parents=True, exist_ok=True)
    config = MotionProConfig.load()
    vpn = MotionProVpn(config)
    checks = []

    def check(name: str, ok: bool, detail: str) -> None:
        checks.append({"name": name, "ok": bool(ok), "detail": detail})

    binary = Path(config.binary)
    lib_dir = Path(config.lib_dir)
    check("MotionPro 可执行文件", binary.exists(), str(binary))
    check("MotionPro 动态库目录", lib_dir.is_dir(), str(lib_dir))
    check("VPN 地址", bool(config.host), config.host or "未配置")
    check("VPN 用户名", bool(config.username), config.username or "未配置")
    try:
        vpn.resolve_password()
        check("登录密码", True, "已配置（环境变量或 macOS 钥匙串）")
    except CredentialsMissing as exc:
        check("登录密码", False, str(exc))

    status = vpn.status()
    check("连接状态", status.state.value != "unknown", status.state.value)
    return {
        "ok": all(item["ok"] for item in checks),
        "checks": checks,
        "status": status.to_dict(),
        "config": config_view(config),
        "checkedAt": now_text(),
    }


def call(name: str, arguments: dict) -> dict:
    if name == "vpn_status":
        value = status_payload()
    elif name == "vpn_connect":
        config = MotionProConfig.load()
        vpn = MotionProVpn(config)
        vpn.connect(wait=bool(arguments.get("wait", True)))
        value = status_payload(vpn=vpn, config=config)
    elif name == "vpn_disconnect":
        config = MotionProConfig.load()
        vpn = MotionProVpn(config)
        vpn.disconnect(keep_session=bool(arguments.get("keepSession", False)))
        value = status_payload(vpn=vpn, config=config)
    elif name == "vpn_doctor":
        value = doctor_payload()
    elif name == "vpn_save_config":
        value = save_config(arguments)
    elif name == "vpn_set_password":
        config = MotionProConfig.load()
        if not config.username:
            raise MotionProError("请先配置 VPN 用户名")
        service = str(arguments.get("keychainService") or config.keychain_service).strip()
        store_keychain_password(service, config.username, str(arguments.get("password") or ""))
        if service != config.keychain_service:
            DATA.mkdir(parents=True, exist_ok=True)
            current = read_config_file()
            current["keychainService"] = service
            CONFIG_FILE.write_text(json.dumps(current, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            os.chmod(CONFIG_FILE, 0o600)
            config = MotionProConfig.load()
        value = status_payload(config=config)
        value["passwordUpdated"] = True
    else:
        raise ValueError("Unknown tool")
    return {
        "content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}],
        "structuredContent": value,
    }


def handle(message: dict) -> dict:
    method, params = message.get("method"), message.get("params") or {}
    if method == "initialize":
        return {
            "protocolVersion": "2025-11-25",
            "capabilities": {"tools": {}, "resources": {}},
            "serverInfo": {"name": "motionpro-vpn", "version": "0.1.0"},
        }
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        try:
            return call(params["name"], params.get("arguments", {}))
        except (KeyError, ValueError, OSError, MotionProError, subprocess.SubprocessError) as error:
            return {"isError": True, "content": [{"type": "text", "text": str(error)}]}
    if method == "resources/list":
        return {"resources": [{"uri": UI, "name": "MotionPro VPN", "mimeType": "text/html;profile=mcp-app"}]}
    if method == "resources/read" and params.get("uri") == UI:
        return {
            "contents": [{
                "uri": UI,
                "mimeType": "text/html;profile=mcp-app",
                "text": (ROOT / "vpn.html").read_text(encoding="utf-8"),
            }]
        }
    raise ValueError("Unsupported method")


def serve() -> None:
    for line in sys.stdin:
        try:
            message = json.loads(line)
            if "id" not in message:
                continue
            try:
                response = {"jsonrpc": "2.0", "id": message["id"], "result": handle(message)}
            except Exception as error:  # noqa: BLE001 - stdout 只能输出协议消息
                print(str(error), file=sys.stderr, flush=True)
                response = {
                    "jsonrpc": "2.0",
                    "id": message["id"],
                    "error": {"code": -32603, "message": "Module request failed"},
                }
            print(json.dumps(response, ensure_ascii=False), flush=True)
        except json.JSONDecodeError:
            print("Invalid JSON request", file=sys.stderr, flush=True)


if __name__ == "__main__":
    serve()
