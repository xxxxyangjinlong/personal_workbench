#!/usr/bin/env bash
# 一键启动个人工作台全部服务：网关(8080) + 数据查询(8777) + 发布/终端(8778)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LBL="com.yangjinlong.codex-mobile"
PLIST="$HOME/Library/LaunchAgents/$LBL.plist"
UID_NUM="$(id -u)"

port_up() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

echo "==> 数据查询 (8777)"
if port_up 8777; then echo "    已在运行"; else ( cd "$ROOT/services/db-query" && ./start.sh -d 8777 ); sleep 1; fi

echo "==> 发布/终端 (8778)"
if port_up 8778; then echo "    已在运行"; else ( cd "$ROOT/services/deploy-tools" && nohup ./start.sh 8778 >>server.out.log 2>&1 & ); sleep 1; fi

echo "==> 网关 (8080)"
if port_up 8080; then
  echo "    已在运行"
elif [ -f "$PLIST" ]; then
  echo "    通过 launchd 启动"
  launchctl bootstrap "gui/$UID_NUM" "$PLIST" >/dev/null 2>&1 \
    || launchctl kickstart -k "gui/$UID_NUM/$LBL" >/dev/null 2>&1 || true
  sleep 3
else
  echo "    直接启动（无 launchd 托管）"
  ( cd "$ROOT/workbench" && nohup node server/index.mjs >>logs/server.out.log 2>&1 & )
  sleep 2
fi

echo
"$ROOT/scripts/status.sh"
