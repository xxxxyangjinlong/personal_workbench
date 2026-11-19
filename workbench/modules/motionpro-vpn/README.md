# MotionPro VPN 模块

把 MotionPro 自带命令行客户端封装成工作台自定义模块，提供：

- 页面与 MCP 工具：查询状态、连接、断开、保存配置；
- `vpn_doctor`：检查安装、配置、钥匙串密码和连接状态；
- 不会在后台自动重连：断开后保持断开，只有手动点击连接才会恢复。

## 配置

实际配置放在工作台运行时数据目录，不进入 git：

`workbench/data/modules/motionpro-vpn/config.json`

可以从 `config.example.json` 复制后修改 `host`、`username`，也可以直接在模块页面修改。
密码不会写入该文件，可随时在页面「新密码」中更新，或执行：

```bash
cd workbench/modules/motionpro-vpn
python3 scripts/vpnctl.py login       # 写入 macOS 钥匙串
python3 scripts/vpnctl.py doctor
python3 scripts/vpnctl.py status
python3 scripts/vpnctl.py connect
python3 scripts/vpnctl.py disconnect
```

## 连接行为

模块只做状态查询和手动连接/断开，不安装 launchd 守护，也不会在检测到断线后自动连接。
