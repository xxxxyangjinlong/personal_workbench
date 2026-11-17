# AGENTS.md

## 项目结构

- `workbench/server/`：Express 网关、Codex app-server 客户端、模块宿主。
- `workbench/web/`：React 前端（构建产物在 `web/dist`）。
- `workbench/modules/`：可插拔模块，每个模块一个目录。
- `services/`：数据查询、发布/终端等独立服务。
- `workbench-app/`：Capacitor 安卓壳。

## 自定义模块

开发或修改模块前，先读 `workbench/modules/README.md`。

- 模块目录固定为 `workbench/modules/<目录名>/`。
- 新模块优先用 `module.toml`（stdio MCP），宿主负责拉起和工具聚合。
- 已有独立 HTTP 服务用 `module.json`（transport: http），宿主只代理页面和 API。
- 可参考：`echo-example/`（最小工具）、`calendar/`（页面+SQLite+任务）、`xhs/`（HTTP 服务）。
- 启用中的 stdio 模块工具会通过 `/mcp` 暴露给 Codex，命名为 `mcp__<模块id>__<工具名>`。
- 改完清单调用 `POST /api/modules/rescan`，再按需启用模块。
