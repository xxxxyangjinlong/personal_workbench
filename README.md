# Personal Workbench · 个人工作台

用手机/桌面浏览器远程操作本机 Codex、查询数据库、发布服务的统一工作台。
同一套 Web 应用按屏幕宽度自适应：窄屏为「移动工作台」，宽屏（≥900px）为「桌面工作台」。

## 结构

```
personal-workbench/
├── workbench/                 # Node(Express) 网关 + React(Vite) 前端（端口 8080）
├── services/
│   ├── db-query/              # Python 数据查询服务（端口 8777）
│   └── deploy-tools/          # Python 发布 / 服务器终端服务（端口 8778）
├── README.md
└── .gitignore
```

## 组件

- **workbench**：核心网关。对外暴露 `http://<本机IP>:8080`，内置登录令牌；通过 `codex app-server` 转发任务发布、会话管理、SSE 事件推送；并把 8777/8778 以同端口代理（18777/18778）内嵌到页面。
- **services/db-query**：本地数据查询 Web 界面（`server.py`，守护启动 `daemon.py`）。
- **services/deploy-tools**：发布面板 + 服务器 Web 终端（`server.py`）。

## 快速开始

```bash
# 1) 网关（前端已构建于 workbench/web/dist）
cd workbench && npm install && npm run build && npm start   # 8080

# 2) 数据查询
cd services/db-query && ./start.sh -d                        # 8777（守护）

# 3) 发布 / 终端
cd services/deploy-tools && ./start.sh                       # 8778
```

网关常驻由 `~/Library/LaunchAgents/com.yangjinlong.codex-mobile.plist` 托管（`launchctl bootstrap` / `bootout`）。

## 隐私

`services/deploy-tools/.env` 保存各服务器密码，**已被 .gitignore 排除**，请勿提交。
