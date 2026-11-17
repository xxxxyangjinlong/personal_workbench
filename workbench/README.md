# 随身办公（原 Codex Mobile）

用手机浏览器远程操作**本机 Codex**（同一批会话/任务），并可选代理本机其它服务（终端、数据查询页等）。

## 原理

不另起孤立的 `codex exec`，而是接入本机 **app-server**（Codex 的本地守护进程），
通过 **JSON-RPC** 长连接调用：`thread/list`、`thread/start`、`turn/start`、`turn/interrupt`…
并用 SSE 把执行过程（`item/agentMessage/delta`、`turn/completed` 等通知）实时推给手机端。
因此手机上看到的任务，和电脑上是**同一批**。

- **新会话权限与电脑端一致**：`thread/start` 不传 sandbox/approvalPolicy 时由 app-server
  按 `~/.codex/config.toml` 的默认值建会话；网关默认不传（`DEFAULT_SANDBOX`/`DEFAULT_APPROVAL`
  留空即可强制指定）。
- **项目管理**：`/api/projects` 支持新建/改名/换目录/删除分组（走 app-server
  `project/create|update|delete`），与电脑端客户端的项目列表双向同步；删除项目只解除分组，不删会话。
- **今日一屏**：首页与桌面概览顶部各一张「今日」卡片（数据来自 `/api/today`）：
  今天活跃会话与运行数、token 当日累计（由 `thread/tokenUsage/updated` 通知按天落盘到
  `data/today-usage.json`，自功能上线起累计）、小红书今日发布时段状态/下一次发布/题库余量
  （余量 ≤3 标红提醒补货）、雷达榜 top3、磁盘/内存/负载。
- **会话权限选择器（对标电脑端三档）**：会话页模型选择旁多了权限下拉——跟随客户端 /
  询问批准 / 自动批准 / 完全访问，对后续回合生效（走 app-server `thread/settings/update`）；
  电脑端改了权限，网页选择器会实时同步（监听 `thread/settings/updated`）。选「询问批准/
  自动批准」后，审批请求会以黄色横条出现在输入框上方，点批准/拒绝即可放行
  （回执形状是标准 JSON-RPC `{id, result:{decision}}`，不要带 method 标签）。

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
| `APP_SERVER_WS` | 空 | 设为 `ws://127.0.0.1:8123` 时，网关**连接长活 app-server**（而非自起 stdio 子进程）；这样网关重启/热重载都不会中断正在跑的任务。留空则回退为自起子进程 |
| `ACCESS_TOKEN` | codex-mobile | 登录令牌（**务必改**） |
| `CODEX_BIN` | 自动探测 | codex 可执行文件路径 |
| `DEFAULT_CWD` | `$HOME` | 新任务默认工作目录 |
| `DEFAULT_SANDBOX` | 空 = 跟随 `~/.codex/config.toml`（与电脑端客户端同权限） | 显式设置可强制覆盖：read-only / workspace-write / danger-full-access |
| `DEFAULT_APPROVAL` | 空 = 跟随 `~/.codex/config.toml` | 显式设置可强制覆盖：untrusted / on-request / never |
| `DEFAULT_MODEL` | 空 | 默认模型 |

## 模块宿主（firefly 式）

小红书自动化等功能已拆为**独立模块包**（`modules/<ID>/` + 清单），支持两种清单格式：

1. **module.json（原生）**：`transport: "http"`（REST 型，安装者独立运行，宿主只代理）或 `"stdio"`；
2. **module.toml（Firefly 格式）**：`mcp.transport = "stdio"` 即插即用，字段与 42tr/firefly 的清单
   一致（mcp.command/args、pages[].open_tool、jobs[]、indicator、allowed_tools、call_timeout_secs；
   `streamable_http` 型 v1 暂不支持）。目录名不必等于清单 id，重复 id 的模块均不加载。

宿主提供：

- **扫描/启用**：启动时扫描 `modules/*/`；`POST /api/modules/rescan` 重新扫描；
  `POST /api/modules/:id/toggle` 启用/停用（状态存 `data/modules.json`）。新模块默认停用。
- **HTTP 型页面代理**：启用模块的页面经 `/m/<ID>/<子路径>` 原样转发到模块的 baseUrl（仅回环可达），
  前端首页「功能」列表与桌面侧栏动态渲染启用模块的入口；模块挂了显示「模块离线」，宿主不受影响。
- **stdio MCP 型**：宿主 spawn 子进程，MCP over stdin/stdout（initialize 握手 → tools/list →
  tools/call/resources/read），单模块串行、超时（`call_timeout_secs`，默认 120s）、启动失败冷却 15s。
  环境变量白名单注入（PATH/HOME/LANG + `env_from` + `env`），并注入
  `FIREFLY_MODULE_DATA_DIR/CONFIG/TIMEZONE` 与同款 `WORKBENCH_MODULE_*`；模块数据目录
  `data/modules/<ID>/`，stderr 落 `stderr.log`。工具经 `GET /m/<ID>/tools`、
  `POST /m/<ID>/tools/<name>`、`POST /m/<ID>/rpc`（tools/call / resources/read / ping）暴露。
  页面走 MCP Apps 语义：`GET /m/<ID>/page` 是桥包装页（iframe），宿主收页面 `initialized` 后调
  `open_tool` 并推送 `tool-input`/`tool-result`，页面 `tools/call` 经桥转发；模块 HTML 由
  `open_tool` 的 `_meta.ui.resourceUri` 经 `resources/read` 取回。宿主退出时杀全部子进程。
- **对话接入（Codex MCP）**：网关提供聚合 MCP 端点 `POST /mcp`（streamable HTTP + Bearer），
  把所有启用 stdio 模块的工具暴露给 Codex 对话：工具名 `mcp__<模块id>__<工具名>`（firefly 同款，
  超长时截断+sha256 后缀），description 加 `[模块名]` 前缀，inputSchema 递归补 type。Codex 侧配置
  （`codex mcp add workbench-modules --url http://127.0.0.1:8080/mcp --bearer-token-env-var WORKBENCH_TOKEN`），
  app-server 的 launchd plist 里注入了 WORKBENCH_TOKEN；新装模块 rescan + 启用后自动出现在对话里。
  Mac 终端直接跑 `codex exec` 时需自行 `export WORKBENCH_TOKEN=...`（app-server 场景不受影响）。
- **定时任务**：清单 `jobs` 声明五段 cron + 时区，宿主调度器（20 秒 tick）调用模块的 job 端点
  （http 型 POST path，stdio 型 tools/call）。语义与 firefly 一致：不重叠、离线期间不逐次补齐
  （逾期合并为一次）、执行记录每模块留 100 条（`data/module-jobs.json`，`GET /api/modules/:id/jobs` 可查）。
- **状态提示**：http 型轮询 `indicator.path`；stdio 型调 `indicator.tool`（无 indicator 则按
  进程存活判定）。供今日一屏/首页显示模块状态。

`modules/` 里的 `echo-example`、`personal-calendar` 是 firefly 官方示例模块原样拷入
（`module.toml` + `server.py` + 页面 HTML，零改动），可当模板用：echo 是最小工具模块模板，
calendar 演示页面 + SQLite 存储 + 定时任务（daily-check 默认停用）。

小红书模块（`modules/xhs/`）自管：雷达每日扫描的失败重试、周历发帖的时段状态机、题库/人物池。
数据目录：`data/modules/xhs/`（autopost-state.json、榜单快照）。配置在 `modules/xhs/xhs-config.mjs`
（env 可覆盖）。由 launchd `com.yangjinlong.xhs-service` 独立运行（node --watch，改模块代码只重启它自己）；
手动方式：`modules/xhs/start.sh` / `stop.sh`。模块 API：`GET /indicator`、`POST /jobs/radar-scan`、
`GET/POST /api/xhs-radar*`（经宿主代理时路径为 `/m/xhs/...`）。

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
- `GET/POST /api/projects`  `PATCH/DELETE /api/projects/:id`（项目列表/新建/改名换目录/删除分组）
- `GET  /api/today`（今日一屏：会话活动/token 累计/小红书发布状态与题库余量/雷达 top3/机器状态）
- `GET  /api/fs?path=`（浏览主目录下的文件夹，项目选择器用；默认 `~`，仅限 home 子树、不含隐藏目录）
- `GET  /api/events`（SSE 实时通知）
- `POST /api/respond`（回应审批等 server→client 请求）
- `GET/POST /api/modules`  `POST /api/modules/rescan`  `POST /api/modules/:id/toggle`（模块宿主）
- `GET /m/<模块ID>/<子路径>`（启用模块的页面/API 代理）
- `GET /apk/app-debug.apk`（安卓 App 安装包，带令牌）

- **安卓 App**：`workbench-app/`（Capacitor 壳，详见其 README）。构建后的 APK 可在手机浏览器
  带令牌访问 `/apk/app-debug.apk` 直接下载安装；首页「📲 安装桌面 App」入口同效。
- **终端嵌入**：网关会把 `/term/*` 反向代理到本机 `ttyd`（含 WebSocket），并用与登录相同的令牌鉴权
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

本工作台使用一个 **launchd 托管的长活 app-server**（`com.yangjinlong.codex-appserver`）：

```
codex app-server -c thread_unload_delay_secs=30 --listen ws://127.0.0.1:8123
```

网关通过 `APP_SERVER_WS=ws://127.0.0.1:8123` 以 WebSocket 连上去。好处是
**任务的执行发生在 app-server 进程里，网关重启/热重载（`node --watch`）只断一下 WS，任务照常跑完**。
`thread_unload_delay_secs=30` 让会话空闲 30 秒后**自动卸载、释放写锁**，避免长期独占导致不同步。

> 不用长活服务时（未设 `APP_SERVER_WS`），网关会自起 `codex app-server` 子进程并带上同一个 `-c`；
> 但那种模式下**网关一重启，子进程即被杀、正在跑的任务会中断**。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `THREAD_UNLOAD_DELAY_SECS` | 30 | 会话空闲多少秒后自动卸载（设 0 关闭） |

诊断接口：`GET /api/loaded`（当前被本网关 app-server 加载的会话 id）。
