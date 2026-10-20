#!/usr/bin/env bash
# 启动发布面板（默认端口 8778，可用 ./start.sh 9000 指定）
cd "$(dirname "$0")"
PORT="${1:-8778}"
exec python3 server.py "$PORT"
