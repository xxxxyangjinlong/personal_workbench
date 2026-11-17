#!/usr/bin/env bash
# 手动后台启动小红书模块（正式运行由 launchd com.yangjinlong.xhs-service 托管）
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p ../../data/modules/xhs
if [ -f run.pid ] && kill -0 "$(cat run.pid)" 2>/dev/null; then echo "已在运行 (pid $(cat run.pid))"; exit 0; fi
nohup /usr/local/bin/node --watch server.mjs >> module.log 2>&1 &
echo $! > run.pid
echo "pid: $(cat run.pid)，日志 module.log，健康检查: curl http://127.0.0.1:8790/health"
