#!/usr/bin/env bash
# 重启网关。正在执行的 Codex 任务不受影响——任务跑在长活 app-server 进程里，网关只是它的客户端。
set -uo pipefail
LBL="com.yangjinlong.codex-mobile"
PLIST="$HOME/Library/LaunchAgents/$LBL.plist"
U="$(id -u)"
echo "==> 重启网关 ($LBL)"
launchctl bootout "gui/$U/$LBL" 2>/dev/null || true
sleep 1
ok=0
for i in 1 2 3 4 5; do
  if launchctl bootstrap "gui/$U" "$PLIST" 2>/dev/null; then ok=1; break; fi
  sleep 1
done
sleep 3
if lsof -nP -iTCP:8080 -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "    已重启，8080 就绪"
else
  echo "    未能启动（bootstrap 有时首报 5: Input/output error，可再跑一次）；查 workbench/logs/server.err.log"
fi
