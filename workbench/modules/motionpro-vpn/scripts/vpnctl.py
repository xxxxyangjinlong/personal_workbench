#!/usr/bin/env python3
"""MotionPro VPN 命令行：状态、连接、断开与钥匙串管理。"""
from __future__ import annotations

import argparse
import getpass
import json
import logging
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from motionpro_vpn import (  # noqa: E402
    CredentialsMissing,
    MotionProConfig,
    MotionProError,
    MotionProVpn,
    VpnStatus,
    store_keychain_password,
)


def _vpn() -> MotionProVpn:
    return MotionProVpn(MotionProConfig.load())


def _print_status(status: VpnStatus, as_json: bool) -> None:
    if as_json:
        print(json.dumps(status.to_dict(), ensure_ascii=False, indent=2))
        return
    detail = f"（code={status.code}）" if status.code is not None else ""
    print(f"{status.state.value}{detail}")
    if status.error:
        print(f"错误：{status.error}", file=sys.stderr)


def cmd_status(args: argparse.Namespace) -> int:
    status = _vpn().status()
    _print_status(status, args.json)
    return 0 if status.connected else 1


def cmd_connect(args: argparse.Namespace) -> int:
    vpn = _vpn()
    status = vpn.connect(wait=not args.no_wait)
    _print_status(status, args.json)
    if args.no_wait:
        return 0 if status.state.value in {"connecting", "reconnecting", "connected", "both_connected"} else 1
    return 0 if status.connected else 1


def cmd_disconnect(args: argparse.Namespace) -> int:
    status = _vpn().disconnect(keep_session=args.keep_session)
    _print_status(status, args.json)
    return 0 if status.state.value in {"idle", "disconnected"} else 1


def cmd_login(args: argparse.Namespace) -> int:
    config = MotionProConfig.load()
    config.validate_credentials()
    print(f"把 MotionPro 密码写入 macOS 钥匙串（账号 {config.username}，服务 {config.keychain_service}）")
    password = getpass.getpass("MotionPro 密码: ")
    repeated = getpass.getpass("再次输入: ")
    if password != repeated:
        print("两次输入不一致", file=sys.stderr)
        return 2
    store_keychain_password(config.keychain_service, config.username, password)
    print("密码已保存。")
    return 0


def cmd_logout(args: argparse.Namespace) -> int:
    config = MotionProConfig.load()
    config.validate_credentials()
    proc = subprocess.run(
        [
            "security", "delete-generic-password",
            "-a", config.username,
            "-s", config.keychain_service,
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode == 0:
        print("已从钥匙串删除 MotionPro 密码。")
    else:
        print("钥匙串中没有找到 MotionPro 密码。")
    return 0


def cmd_doctor(args: argparse.Namespace) -> int:
    config = MotionProConfig.load()
    vpn = MotionProVpn(config)
    ok = True

    binary = Path(config.binary)
    lib_dir = Path(config.lib_dir)
    checks = [
        ("MotionPro 可执行文件", binary.exists(), str(binary)),
        ("MotionPro 动态库目录", lib_dir.is_dir(), str(lib_dir)),
        ("VPN 地址", bool(config.host), config.host or "未配置 MOTIONPRO_HOST"),
        ("VPN 用户名", bool(config.username), config.username or "未配置 MOTIONPRO_USER"),
    ]
    for name, passed, detail in checks:
        print(f"[{'OK' if passed else '!!'}] {name}: {detail}")
        ok = ok and passed

    try:
        vpn.resolve_password()
        print("[OK] 登录密码: 已配置（环境变量或钥匙串）")
    except CredentialsMissing:
        print("[!!] 登录密码: 未配置，运行 `python3 scripts/vpnctl.py login` 写入钥匙串")
        ok = False

    status = vpn.status()
    print(f"[{'OK' if status.state.value != 'unknown' else '!!'}] 连接状态: {status.state.value}")
    if status.error:
        print(f"     错误: {status.error}")
    ok = ok and status.state.value != "unknown"

    return 0 if ok else 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="MotionPro VPN 控制工具",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("status", help="查询连接状态")
    p.add_argument("--json", action="store_true", help="以 JSON 输出")
    p.set_defaults(func=cmd_status)

    p = sub.add_parser("connect", help="连接 VPN（需要先 login）")
    p.add_argument("--no-wait", action="store_true", help="只发起连接，不等待成功")
    p.add_argument("--json", action="store_true", help="以 JSON 输出")
    p.set_defaults(func=cmd_connect)

    p = sub.add_parser("disconnect", help="断开 VPN")
    p.add_argument("--keep-session", action="store_true", help="只断开，不注销会话（-b）")
    p.add_argument("--json", action="store_true", help="以 JSON 输出")
    p.set_defaults(func=cmd_disconnect)

    p = sub.add_parser("login", help="把密码写入 macOS 钥匙串")
    p.set_defaults(func=cmd_login)

    p = sub.add_parser("logout", help="删除钥匙串中的密码")
    p.set_defaults(func=cmd_logout)

    p = sub.add_parser("doctor", help="检查安装、配置与连接状态")
    p.set_defaults(func=cmd_doctor)

    return parser


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except MotionProError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\n已停止。")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
