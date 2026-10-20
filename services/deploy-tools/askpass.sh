#!/bin/sh
# 交互式 SSH 会话用：把 SSHPASS 环境变量里的密码回给 ssh 的密码提示
printf '%s\n' "$SSHPASS"
