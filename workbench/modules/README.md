# 自定义模块开发指南

模块统一放在 `workbench/modules/<目录名>/`。宿主启动时扫描目录，支持两种清单：

| 清单 | 类型 | 谁负责运行 | 适合场景 |
| --- | --- | --- | --- |
| `module.toml` | stdio MCP | 工作台宿主拉起子进程 | 新模块、Python/Node 小工具、需要暴露给 Codex |
| `module.json` | HTTP | 你自己常驻运行 | 已有独立服务、需要自定义页面/API |

`workbench/modules/` 目录名不要求等于清单 `id`，但重复 `id` 的模块都不会加载。新模块默认停用。

## 快速开始

复制最小模板：

```bash
cd workbench/modules
cp -R echo-example my-module
```

改 `my-module/module.toml`，然后：

```bash
curl -X POST -H "Authorization: Bearer $WORKBENCH_TOKEN" http://127.0.0.1:8080/api/modules/rescan
curl -X POST -H "Authorization: Bearer $WORKBENCH_TOKEN" \
  -H 'Content-Type: application/json' -d '{"enabled":true}' \
  http://127.0.0.1:8080/api/modules/my-module/toggle
```

也可以在首页「功能」列表里直接启用。

## stdio 模块（推荐）

清单示例：

```toml
manifest_version = 1
id = "my-module"
name = "我的模块"
version = "0.1.0"
description = "一句话说明"
config_schema = "config.schema.json"   # 可选

[mcp]
transport = "stdio"
command = "python3"
args = ["server.py"]
call_timeout_secs = 120

[[pages]]
id = "main"
title = "我的页面"
open_tool = "show_page"

[[jobs]]
id = "daily-check"
tool = "check"
cron = "0 9 * * *"
timezone = "Asia/Shanghai"
enabled_by_default = false
```

宿主行为：

- `spawn(command, args)`，工作目录是模块目录。
- 环境变量只注入白名单：`PATH`、`HOME`、`LANG`，加上清单里的 `env` / `env_from`。
- 同时注入 `FIREFLY_MODULE_DATA_DIR` / `WORKBENCH_MODULE_DATA_DIR`，指向 `workbench/data/modules/<目录名>/`。
- 模块数据、SQLite、日志都应放在这个数据目录，不要写回代码目录。
- 页面通过 `pages[].open_tool` 指向一个 MCP 工具，工具定义里用 `_meta.ui.resourceUri` 返回 `ui://` 页面资源。
- 工具会聚合到 `POST /mcp`，Codex 里的名字是 `mcp__<模块id>__<工具名>`。

参考实现：

- `echo-example/`：最小工具模板。
- `calendar/`：页面 + SQLite + 工具 + 每日任务。

## HTTP 模块

清单示例：

```json
{
  "id": "my-http-module",
  "name": "我的 HTTP 模块",
  "version": "0.1.0",
  "icon": "🧩",
  "description": "独立服务，宿主只做代理",
  "transport": "http",
  "baseUrl": "http://127.0.0.1:8791",
  "pages": [{ "id": "main", "title": "我的页面", "path": "/page" }],
  "jobs": [{ "id": "scan", "cron": "*/20 8-11 * * *", "tz": "Asia/Shanghai", "path": "/jobs/scan" }],
  "indicator": { "path": "/indicator", "refresh": 300 }
}
```

宿主行为：

- 不拉起进程，必须自己用 launchd / systemd / docker 常驻。
- 页面和接口经 `/m/<模块id>/<子路径>` 原样代理到 `baseUrl`。
- job 到期时宿主向 `baseUrl + path` 发 `POST {}`，返回 JSON。
- indicator 每 `refresh` 秒 `GET baseUrl + path`。
- 代理只处理 JSON body，文件上传等 multipart 请求需要模块自己暴露端口或走独立地址。

参考实现：`xhs/`（独立 Node 服务，端口 8790）。

## 调试接口

```bash
GET  /api/modules                  # 模块列表、启用状态、在线状态
POST /api/modules/rescan           # 重新扫描目录
POST /api/modules/:id/toggle       # 启用/停用，body: {"enabled":true}
GET  /api/modules/:id/jobs         # 定时任务执行记录
GET  /m/:id/tools                  # stdio 模块工具列表
POST /m/:id/tools/:tool            # 直接调用 stdio 工具
POST /mcp                          # 聚合 MCP 端点（Bearer 鉴权）
```

宿主每 20 秒 tick 一次 jobs；任务不重叠，错过只补一次，每个模块保留最近 100 条记录。

## 约束

- 模块代码以当前用户权限运行，只加载可信代码。
- `streamable_http` 型 MCP v1 不支持。
- `FIREFLY_MODULE_CONFIG` 目前注入 `{}`，还没有模块配置编辑 UI。
- 修改清单后调用 rescan；修改 stdio 命令/参数/环境或版本会自动重启子进程。
