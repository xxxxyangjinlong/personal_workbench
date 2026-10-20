# 一句话发布 / 运维工具

把「构建 → 上传 → 重启 → 健康检查」合成一条命令；配合 Codex 技能，
直接说「帮我把 indexSystem 发布到 207 环境」即可完成。

## 命令
```bash
./deploy list                             # 列出已登记项目
./deploy envs <项目>                      # 列出项目的环境
./deploy add  <项目|目录>                  # 自动探测并生成配置骨架
./deploy <项目> [环境] [选项]              # 发布
./deploy upload <本地文件> <服务器[:路径]>  # 传文件
./deploy run <服务器> "<命令>"             # 远程执行命令
```
选项：`--no-build` / `--no-restart` / `--dry-run`

## 三个配置
- `hosts.conf`      全局服务器登记：`host / user / pass_env`
- `conf/<项目>.conf` 项目构建方式 + `[env:<服务器>]`（path/profile/port/java）
- `.env`            密码：`PASS_<别名>=xxx`（已被 git 忽略）

## 项目类型（kind）
- `jar`    Spring Boot 可执行 jar → 上传 + 按 `start_cmd` 启动 + 端口/日志探测
- `war`    上传 war → `restart_cmd` 重启容器
- `static` 前端：构建 → 打包 → 上传解包 →（可选 `reload_cmd`）
- `docker` 构建镜像 → 服务器执行 `deploy_cmd`

## 已登记
| 项目 | 环境 | 路径 | 启动 |
| --- | --- | --- | --- |
| indexSystem | 207 | /usr/local/src/tmp | `java -Dspring.profiles.active=54dm -jar …` |
| indexChat | 208 | /usr/local/src/indexChat | corretto-21 启动 |
| data-intelligence-agent | 208 | /usr/local/src/data-intelligence-agent | corretto-21 启动 |

服务器：207=10.1.192.207、208=10.1.192.208、53/54/55=10.1.192.53/54/55

## 新增项目
```bash
./deploy add <项目>        # 自动探测构建类型/产物，生成 conf/<项目>.conf
vim conf/<项目>.conf       # 核对 TODO、补 [env:xxx]
./deploy <项目> <环境>
```

## 配置示例
```ini
[project]
kind = jar
dir = ~/IdeaProjects/indexSystem
build_java_home = ~/Library/Java/JavaVirtualMachines/corretto-1.8.0_472/Contents/Home
mvn = ~/maven/apache-maven-3.6.2/bin/mvn
build = {mvn} -f pom.xml clean package -DskipTests
artifact = index-service/target/index-service-0.0.1-SNAPSHOT.jar
start_cmd = nohup {java} -Dspring.profiles.active={profile} -jar {jar}
default_env = 207

[env:207]
host = 207
path = /usr/local/src/tmp
profile = 54dm
port = 8085
java = java
```

## 运维面板（本地网页，两个页面）
```bash
./start.sh        # 启动，默认 http://127.0.0.1:8778
```
- 发布面板   `http://127.0.0.1:8778/`      选项目环境，一键发布（可选 跳过构建/只上传/演练），实时日志
- 服务器命令 `http://127.0.0.1:8778/shell`  选服务器，开一个**真实终端**（xterm.js）
  - 直接贴终端里输入即可；后端是真实 pty，字节原样透传——所以 `vim` / `top` / `htop` / **`codex`** 等全屏 TUI、彩色输出都正常
  - 列表第一项是「🖥 本机」，可直接跑本地（这台 Mac）命令；其余为远端服务器（多标签、会话状态保留）
  - `中断 ^C` = 发送 Ctrl-C；`清屏` = 清当前屏
  - 选中服务器后，会按 `logs.conf` 自动出现该服务器上各项目的**日志快捷按钮**，点一下即执行 `tail -f <日志>`
  - **已适配手机端**：窄屏时服务器列表收成抽屉（左上角 `☰` 展开、`✕`/点遮罩收起），终端占满整屏且自动避开刘海/底部安全区，标签与快捷命令横向滑动，底部另有一排移动按键 `Esc / Tab / ↑ / ↓ / ← / →`；横竖屏切换、键盘弹出都会自动重置终端尺寸

终端用的 xterm.js 资源已随仓库放在 `web/vendor/`（离线可用），无需联网。

## 日志快捷（logs.conf）
服务器 → { 标签 = 日志文件 }，供命令页面使用：
```ini
[207]
indexSystem = /usr/local/src/tmp/www/api.indexSystem.com/logs/indexSystem-web.log
indexSystem-控制台 = /usr/local/src/tmp/app.log

[208]
indexChat = /usr/local/src/indexChat/logs/app.log
data-intelligence-agent = /usr/local/src/data-intelligence-agent/logs/data-intelligence-agent.log
data-intelligence-agent-sql = /usr/local/src/data-intelligence-agent/logs/sql.log
```

## 服务器登记（hosts.conf）
207=10.1.192.207、208=10.1.192.208、53/54/55=10.1.192.53/54/55、
181=10.1.94.181(yh)、240=10.1.62.240、134=10.1.192.134、123=10.1.192.123、
95=10.1.64.95、139=10.1.192.139

## 网页面板（可选，非主用法）
```bash
./start.sh        # http://127.0.0.1:8778
```
