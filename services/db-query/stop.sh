#!/usr/bin/env bash
# 停止后台服务
cd "$(dirname "$0")"
PID=""
[ -f server.pid ] && PID="$(cat server.pid)"
[ -z "$PID" ] && PID="$(lsof -nP -iTCP:8777 -sTCP:LISTEN -t 2>/dev/null)"
if [ -z "$PID" ]; then
  echo "未发现正在运行的服务"
  exit 0
fi
kill "$PID" && echo "已停止 PID=$PID"
rm -f server.pid
