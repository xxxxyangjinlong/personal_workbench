#!/usr/bin/env bash
# 一键启动个人工作台全部服务：长活 app-server + 网关(8080) + 数据查询(8777) + 发布/终端(8778)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
U="$(id -u)"
AGENT="$HOME/Library/LaunchAgents"

port_up() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
loaded()  { launchctl print "gui/$U/$1" >/dev/null 2>&1; }
boot()    { # label
  loaded "$1" && { echo "    已在运行"; return; }
  local i; for i in 1 2 3 4 5; do
    launchctl bootstrap "gui/$U" "$AGENT/$1.plist" 2>/dev/null && break
    sleep 1
  done
}

echo "==> Codex app-server (8123)"
boot com.yangjinlong.codex-appserver

echo "==> 数据查询 (8777)"
if port_up 8777; then echo "    已在运行"; else ( cd "$ROOT/services/db-query" && ./start.sh -d 8777 ); sleep 1; fi

echo "==> 发布/终端 (8778)"
if port_up 8778; then echo "    已在运行"; else ( cd "$ROOT/services/deploy-tools" && nohup ./start.sh 8778 >>server.out.log 2>&1 & ); sleep 1; fi

echo "==> 网关 (8080)"
if port_up 8080; then
  echo "    已在运行"
elif [ -f "$AGENT/com.yangjinlong.codex-mobile.plist" ]; then
  boot com.yangjinlong.codex-mobile
  sleep 3
else
  echo "    直接启动（无 launchd 托管）"
  ( cd "$ROOT/workbench" && nohup node server/index.mjs >>logs/server.out.log 2>&1 & )
  sleep 2
fi

echo
"$ROOT/scripts/status.sh"
