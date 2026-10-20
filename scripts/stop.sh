#!/usr/bin/env bash
# 一键停止个人工作台全部服务
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LBL="com.yangjinlong.codex-mobile"
UID_NUM="$(id -u)"

listen_pid() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1; }

echo "==> 网关 (8080)"
launchctl bootout "gui/$UID_NUM/$LBL" >/dev/null 2>&1 \
  || { p="$(listen_pid 8080)"; [ -n "$p" ] && kill "$p" 2>/dev/null; }
echo "    已停止"

echo "==> 数据查询 (8777)"
( cd "$ROOT/services/db-query" && ./stop.sh ) 2>/dev/null || { p="$(listen_pid 8777)"; [ -n "$p" ] && kill "$p" 2>/dev/null; }

echo "==> 发布/终端 (8778)"
p="$(listen_pid 8778)"; if [ -n "$p" ]; then kill "$p" 2>/dev/null && echo "    已停止 PID=$p"; else echo "    未在运行"; fi

echo
echo "全部已处理。"
