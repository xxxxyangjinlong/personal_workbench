# workbench-app · 安卓原生壳（Capacitor）

「移动工作台」的安卓 App 壳：WebView 加载远端工作台网页，桌面图标 + 全屏无地址栏。
不打包界面，界面永远跟随服务器最新版。

## 结构

```
capacitor.config.json   # appId com.yangjinlong.workbench，cleartext 允许 http
www/index.html          # 加载器：探测服务器连通性 → 跳转工作台；连不上显示地址设置
assets/                 # 图标源（icon-foreground/background/icon-only + splash）
android/                # Capacitor 生成的安卓工程（gradle 构建）
```

## 加载器逻辑（www/index.html）

1. 读取服务器地址（localStorage `server_url`，默认 `http://100.103.226.87:8080` = Tailscale IP）
2. `no-cors` fetch 探测 `/api/health`（5 秒超时，失败 2.5 秒后再试一次）
3. 通了就 `location.replace` 进工作台；不通显示地址设置页（手输新地址，如 frp 域名上线后）

## 构建

```bash
export ANDROID_HOME=$HOME/Library/Android/sdk
export JAVA_HOME=$(/usr/libexec/java_home)
cd android && ./gradlew assembleDebug
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

国内网络需在 `android/build.gradle` 的 buildscript/allprojects 仓库里保留阿里云镜像
（google/central/gradle-plugin 已配，别删）。

## 安装

- 手机连 USB 开 USB 调试：`adb install -r android/app/build/outputs/apk/debug/app-debug.apk`
- 或手机浏览器打开工作台 → 首页「📲 安装桌面 App」直接下载 APK
  （网关路由 `/apk/app-debug.apk`，需登录令牌）；安装时允许「未知来源」

## 注意

- Tailscale 需在手机上处于连接状态（App 的 WebView 走系统网络，VPN 全局生效）
- 前端改版无需重打 APK：界面是服务器实时下发的，APK 只是壳
- 改 App 图标/名称/内置默认地址才需要重新构建（改 assets/ 后跑
  `npx capacitor-assets generate --android`，改 capacitor.config.json 后跑 `npx cap sync android`）
