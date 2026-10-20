# 随身办公（原 Codex Mobile）

用手机浏览器远程操作**本机 Codex**（同一批会话/任务），并可选代理本机其它服务（终端、数据查询页等）。

## 原理

不另起孤立的 `codex exec`，而是接入本机 **app-server**（Codex 的本地守护进程），
通过 **JSON-RPC** 长连接调用：`thread/list`、`thread/start`、`turn/start`、`turn/interrupt`…
并用 SSE 把执行过程（`item/agentMessage/delta`、`turn/completed` 等通知）实时推给手机端。
因此手机上看到的任务，和电脑上是**同一批**。

```
手机浏览器 → Node 网关(登录) → SSE/WS → codex app-server(JSON-RPC) → 本机 Thread/终端/FS
```

## 运行

```bash
npm install
npm run build          # 构建前端到 web/dist
npm start              # 启动网关 + 静态站点，默认 0.0.0.0:8080
```

开发模式（前后端热更新，Vite 代理 /api 到 8080）：

```bash
npm run dev
```

## 访问

- 本机：http://localhost:8080
- 局域网（手机同 Wi-Fi）：http://<你的Mac局域网IP>:8080  （如 http://192.168.0.112:8080）
- 登录令牌默认 `codex-mobile`，用环境变量改：`ACCESS_TOKEN=xxx npm start`

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 8080 | 监听端口 |
| `ACCESS_TOKEN` | codex-mobile | 登录令牌（**务必改**） |
| `CODEX_BIN` | 自动探测 | codex 可执行文件路径 |
| `DEFAULT_CWD` | `$HOME` | 新任务默认工作目录 |
| `DEFAULT_SANDBOX` | workspace-write | read-only / workspace-write / danger-full-access |
| `DEFAULT_APPROVAL` | never | untrusted / on-request / never |
| `DEFAULT_MODEL` | 空 | 默认模型 |

## 后续（frp 公网）

网关只监听一个端口、前端全用相对路径，切公网只需把 8080 通过 frp 暴露出去，
再在 VPS 上用 nginx 挂 HTTPS 域名即可，前端代码无需改动。

## API

- `POST /api/login` {token}
- `GET  /api/threads`  `POST /api/threads`
- `GET  /api/threads/:id`  `GET /api/threads/:id/turns`
- `POST /api/threads/:id/turns` {text, model?}
- `POST /api/threads/:id/interrupt`
- `GET  /api/models`
- `GET  /api/events`（SSE 实时通知）
- `POST /api/respond`（回应审批等 server→client 请求）

## 终端嵌入

网关会把 `/term/*` 反向代理到本机 `ttyd`（含 WebSocket），并用与登录相同的令牌鉴权
（HTTP 用 `Authorization`/`?token=`/`cm_token` cookie，WebSocket 用 `?token=`/cookie）。

- Node 启动时会自动拉起：`ttyd -i 127.0.0.1 -p 7681 -b /term -W tmux new -A -s main`
- 用 `tmux` 承载会话：手机断线/刷新后，`tmux` 里的进程（比如开发服务器）**不会中断**，重连即可。
- 手机端首页点「终端」即打开；也可直接访问 `/term/`。
- 关掉终端：`TERMINAL=off npm start`；改端口/会话名：`TTYD_PORT`、`TMUX_SESSION`。
- 依赖：`brew install ttyd tmux`。

## 环境变量（新增）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TERMINAL` | on | `off` 关闭终端嵌入 |
| `TTYD_PORT` | 7681 | ttyd 监听端口（仅本机回环） |
| `TTYD_BASE` | /term | 反代基础路径 |
| `TMUX_SESSION` | main | tmux 会话名 |

## 会话写锁与「不同步」

Codex 的会话正文存在本机共享库（`~/.codex/state_5.sqlite` + `thread_history_1.sqlite`），
但**一个会话一旦被某个 app-server 加载/写过，就会在那个进程里驻留一份内存副本并持有独占写锁**
（`~/.codex/thread-writer-locks/<threadId>.lock`）。多个 app-server 同时存在时，谁加载了会话，
另一方就读不到最新 / 写不进去 —— 表现为「不同步 / 会话正在电脑端使用中」。

网关启动 app-server 时默认带上 `-c thread_unload_delay_secs=30`，
让会话空闲 30 秒后**自动卸载、释放写锁**，避免长期独占。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `THREAD_UNLOAD_DELAY_SECS` | 30 | 会话空闲多少秒后自动卸载（设 0 关闭） |

诊断接口：`GET /api/loaded`（当前被本网关 app-server 加载的会话 id）。
