# Personal Workbench · 个人工作台

用**手机或桌面浏览器**远程操作本机的 Codex（发布任务 / 看会话），并内嵌本机其它服务
（数据查询、服务器发布终端等）。同一套 Web 应用按屏幕宽度自适应：
窄屏为「移动工作台」，宽屏（≥ 900px）为「桌面工作台」。

## 组成与端口

| 服务 | 目录 | 端口 | 说明 |
| --- | --- | --- | --- |
| 网关 + 前端 | `workbench/` | **8080** | Node(Express) 网关 + React(Vite)，对外只暴露这一个端口 |
| Codex app-server | 常驻进程（launchd 托管） | 8123 | `codex app-server --listen ws://127.0.0.1:8123`，**长活**；网关用 WS 连它，网关重启不影响正在跑的任务 |
| 数据查询 | `services/db-query/` | 8777 | Python，跨项目数据库自然语言查询 |
| 发布 / 服务器终端 | `services/deploy-tools/` | 8778 | Python，一句话发布 + Web 终端 |

网关会把 8777/8778 以 **同端口代理**（18777 / 18778）内嵌进页面，保持路径不变。

## 目录结构

```
personal-workbench/
├── workbench/            # 网关 + 前端（端口 8080）
│   ├── server/           # Express 网关：codex app-server 转发、SSE、代理
│   └── web/              # React 前端（构建产物在 web/dist）
├── services/
│   ├── db-query/         # 数据查询（8777）
│   └── deploy-tools/     # 发布 / 终端（8778）
├── scripts/              # 一键启停脚本
└── README.md
```

## 环境要求

- Node.js ≥ 20（网关）
- Python ≥ 3.10（两个 Python 服务）
- JDK ≥ 8（数据查询的 JDBC 桥）
- `ttyd`、`tmux`（网关内嵌终端，`brew install ttyd tmux`）

首次安装网关依赖并构建前端：

```bash
cd workbench
npm install
npm run build        # 产出 web/dist（网关直接托管）
```

## 一键启停

```bash
./scripts/start.sh     # 启动全部（网关 8080 + 数据查询 8777 + 发布/终端 8778）
./scripts/status.sh    # 查看状态、本机 IP、手机访问地址
./scripts/restart.sh   # 只重启网关（不会中断正在跑的任务）
./scripts/stop.sh      # 停止全部
```

`start.sh` 对网关优先走 launchd（`~/Library/LaunchAgents/com.yangjinlong.codex-mobile.plist`），
其余服务各自守护启动；重复执行不会重复拉起。

## 手机访问

1. 手机与 Mac 连**同一 Wi-Fi / 局域网**。
2. 浏览器打开（IP 用 `./scripts/status.sh` 查到的本机局域网地址）：

   ```
   http://10.2.100.31:8080
   ```

3. 登录令牌（默认）：`codex-mobile`
   - 支持三种带法：页面登录框输入 / URL 加 `?token=codex-mobile` / Cookie(`cm_token`)。
   - 想改令牌：网关环境变量 `ACCESS_TOKEN=你的令牌`。

> 手机端首页：罗列功能入口（Codex 会话 / 项目发布 / 数据查询 / 服务器终端…）。
> 点「Codex」后**按项目分组**展示会话；「项目发布」是独立的高频入口。

## 各服务手动运行

```bash
# 网关（开发热更新：npm run dev）
cd workbench && npm start                      # 8080

# 数据查询（守护）
cd services/db-query && ./start.sh -d 8777     # 8777；./stop.sh 停止

# 发布 / 终端
cd services/deploy-tools && ./start.sh 8778    # 8778
```

## 开机 / 常驻自启（launchd）

两个常驻任务由 `~/Library/LaunchAgents/` 下的 plist 托管，日志都在 `workbench/logs/`：
（仓库内 `launchd/` 目录保存了这两个 plist 的副本，便于备份/复现。）

| label | 作用 |
| --- | --- |
| `com.yangjinlong.codex-appserver` | 长活 Codex app-server（8123，KeepAlive） |
| `com.yangjinlong.codex-mobile` | 网关（8080，`node --watch`） |

改动后重载（网关可直接用 `./scripts/restart.sh`）：

```bash
U=$(id -u)
for L in com.yangjinlong.codex-appserver com.yangjinlong.codex-mobile; do
  launchctl bootout gui/$U/$L 2>/dev/null
  launchctl bootstrap gui/$U ~/Library/LaunchAgents/$L.plist
done
```

> `bootstrap` 有时首报 `5: Input/output error` 但其实已启动；若 8080 未就绪，重跑一次即可。

> plist 里写死了本仓库路径；**移动/重命名本仓库目录后，务必同步修改 plist 里的路径**，否则网关起不来。

## 功能入口

- **Codex 会话**：按项目分组，可新建 / 继续 / 中断 / fork / 删除；手机上发的是**同一批**本机会话。
- **项目发布**：独立入口，配合 `services/deploy-tools` 完成「构建→上传→重启→健康检查」。
- **数据查询**：内嵌 8777 页面，自然语言转 SQL。
- **服务器终端**：内嵌 8778 的 Web 终端（tmux 承载，断线不丢会话）。
- **小红书热门**：每天自动抓 22 个品类的「最多点赞」笔记，按**热度 / 收藏率 / 转发率**排榜；
  并按榜单第 1 名自动发帖：时段 **10:00 / 19:30**（`XHS_AUTOPOST_SLOTS` 可改）。
  - 内容类型在「提问帖 / 代码日常（/ 热点人物观点）」之间**按天轮转**（默认 `question,devlog`），避免老把同一类型固定在同一时段
    （`XHS_AUTOPOST_ROTATION` 可改；也可用 `XHS_AUTOPOST_PLAN` 显式指定「时段=类型」覆盖）。
  - 发布内容会**按时段匹配**：上午不发「下班/熬夜」类，晚上不发「刚上班」类。
  - 提问帖主题取榜第 1 名，且**同品类隔天不重复**（避让最近 `XHS_ROTATE_DAYS` 天，默认 2）。
  - 配图统一用**本地文字卡**（`workbench/tools/textcard.mjs`），不靠 AI 生图、不用假照片。
  - **代码日常**：每天从本机各 git 仓库的近期提交里取材（`DEVLOG_ROOTS`，默认扫 `~/workProjects ~/IdeaProjects` 等），
    写成「我最近写了点啥」的日常帖，并**强制匿名化**（不出现公司/项目/内部信息）。
  - 另可发**热点人物观点**（手动/偶尔）：在 `~/workProjects/xhs-hotspot/figure-topics.txt` 按
    `名字 :: 观点 :: 图片URL(可空)` 逐行添加；有真实照片就用照片，没有就文字卡。界面「试发」按钮均可先发「仅自己可见」验收。
  - 页面顶部有**自定义发帖框**：手填主题 + 可选上传图片（≤9 张，前端自动压到 1600px），
    顺手发一条自己的内容；没上传图片就自动用文字卡。提示词与其余帖子同一套规则（反 AI 味、大白话、不引导）。
  - 数据按天归档在 `workbench/data/xhs-radar/`（配合本机 `~/workProjects/xiaohongshu-mcp` 的小红书 MCP）。

## 隐私与安全

- `services/deploy-tools/.env`（各服务器密码）**已被 .gitignore 排除**，切勿提交。
- 登录令牌、电话/推送 key 等均通过环境变量注入，勿写进代码。
- 局域网即可用；要公网访问，把 **8080** 通过 **frp** 暴露到 VPS，再挂 nginx + HTTPS 域名即可，前端无需改动。

## 常见问题

- **改代码 / 重启网关会不会中断正在跑的任务**：不会。任务在**长活 app-server** 进程里执行（launchd 托管 `com.yangjinlong.codex-appserver`，端口 8123），网关只是它的客户端；重启网关仅断开并重连 WS，任务照常跑完。重启网关用 `./scripts/restart.sh`。
- **手机端与电脑端会话「不同步 / 正在电脑端使用中」**：Codex 会话在某个 app-server 里会驻留内存副本并持有独占写锁。
  网关启动 app-server 时默认带 `-c thread_unload_delay_secs=30`，会话空闲 30 秒后自动卸载、释放锁。
  诊断：`GET /api/loaded`（当前加载的会话 id）。
- **手机发消息提示 thread not found**：多为该会话被电脑端 app-server 独占，等其空闲释放（30s）或刷新重试。
- **网关起不来**：先查 `workbench/logs/server.err.log`，并确认 plist 里的路径指向当前仓库位置。
