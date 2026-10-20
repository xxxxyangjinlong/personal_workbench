#!/usr/bin/env bash
# 查看个人工作台各服务状态
set -uo pipefail
LBL="com.yangjinlong.codex-mobile"
UID_NUM="$(id -u)"

row() { # 名称 端口
  local p; p="$(lsof -nP -iTCP:"$2" -sTCP:LISTEN -t 2>/dev/null | head -1)"
  if [ -n "$p" ]; then printf '  %-16s :%-6s [运行] pid=%s\n' "$1" "$2" "$p"
  else printf '  %-16s :%-6s [停止]\n' "$1" "$2"; fi
}

IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo '127.0.0.1')"
echo "个人工作台状态"
row "网关" 8080
row "数据查询" 8777
row "发布/终端" 8778
row "网关代理-数据" 18777
row "网关代理-终端" 18778
echo
echo "  本机局域网 IP : $IP"
echo "  手机访问地址  : http://$IP:8080"
echo -n "  launchd 网关  : "; launchctl print "gui/$UID_NUM/$LBL" >/dev/null 2>&1 && echo "已加载" || echo "未加载"
