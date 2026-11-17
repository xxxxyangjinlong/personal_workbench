#!/usr/bin/env bash
cd "$(dirname "$0")"
if [ -f run.pid ]; then kill "$(cat run.pid)" 2>/dev/null && echo "已停止 PID=$(cat run.pid)" || echo "进程不在了"; rm -f run.pid; else echo "没有运行记录"; fi
