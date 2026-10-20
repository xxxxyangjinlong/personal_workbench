#!/usr/bin/env bash
# 启动本地 Web 界面（默认端口 8777）
#   ./start.sh          前台启动
#   ./start.sh 9000     前台启动，指定端口
#   ./start.sh -d [端口]  后台守护启动（脱离终端，日志 server.log，PID 写 server.pid）
set -e
cd "$(dirname "$0")"
PORT="8777"
BG=0
for a in "$@"; do
  case "$a" in
    -d|--daemon|bg) BG=1 ;;
    *) PORT="$a" ;;
  esac
done
if [ "$BG" = "1" ]; then
  exec python3 daemon.py "$PORT"
else
  exec python3 server.py "$PORT"
fi
