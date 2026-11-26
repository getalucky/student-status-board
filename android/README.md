# 学生状态管理 · Android 壳

单 Activity + WebView 的原生壳，业务全在服务端。首次启动先显示原生设置页填服务器地址（预填默认值），保存后直接进站点；之后启动直接进。

- 包名：`com.studentboard.app`
- 版本：1.0.0（versionCode 1）
- minSdk 26 / targetSdk 35 / compileSdk 35
- 只申请 `INTERNET` 权限；不开存储、定位、通知
- `usesCleartextTraffic=false` + `networkSecurityConfig` 只信任系统 CA
- `onReceivedSslError` 一律 `cancel()`，自签/过期直接拒绝
- 白名单只放行服务器地址的 host 及其子域，其他链接交系统浏览器
- 返回键：`canGoBack()` 先回退，到根页再退出
- 主文档加载失败显示内置重试页（HTML），不白屏；重试页带「重试」和「修改服务器地址」两个按钮
- JS 桥 `NativeBridge` 只暴露 `copyText(String)`，内部走系统 `ClipboardManager`

## 首次启动 / 修改服务器地址

首次启动不会直接进网页，而是显示原生设置页：
- 说明「手机需先连接 Tailscale；只支持 https:// 地址」
- 一个地址输入框（会预填默认地址）
- 「保存并连接」按钮

保存后地址写入本机 `SharedPreferences`（文件 `shell_settings`，key `server_url`），之后每次启动直接进这个地址。
之后要改：在加载失败页点「修改服务器地址」回到设置页，改完保存会重新加载。也可以在系统设置里清除应用数据，回到首次启动状态。

**默认地址优先级（从高到低）：**

1. `SharedPreferences` 里保存过的值（用户填过就以它为准）
2. `BuildConfig.SERVER_URL`：构建时 `-PserverUrl=https://xxx.ts.net`，或 `android/local.properties` 里写 `serverUrl=https://xxx.ts.net`（本机私有，不进仓库）
3. `app/src/main/res/values/strings.xml` 的 `server_url`（仓库里是占位符 `https://your-machine.your-tailnet.ts.net`）

输入校验：不写 scheme 会自动补 `https://`；只接受 https；host 不能为空；http 或非法地址会在输入框下方报错并且不保存。
壳内域名白名单在保存时从地址解析，只放行该 host 及其子域，换地址不用改 Java 代码。

```xml
<string name="server_url" translatable="false">https://your-machine.your-tailnet.ts.net</string>
```

## 目录结构

```
android/
├─ settings.gradle              # 仓库配置（阿里云镜像优先，google/mavenCentral 兜底）
├─ build.gradle                 # 根脚本，只声明 AGP 8.7.3
├─ gradle.properties            # JVM 参数 + HTTP 超时
├─ gradlew / gradlew.bat        # Gradle Wrapper 8.9（镜像源，见下）
├─ local.properties             # 本机 SDK 路径（不进仓库）
├─ keystore.properties          # 签名口令（不进仓库）
├─ keystore/student-board.jks   # 签名私钥（不进仓库）
├─ tools/make_icons.py          # 图标生成脚本（Pillow）
└─ app/
   ├─ build.gradle              # 模块配置 + release 签名 + 复制 APK 到 ../release
   └─ src/main/
      ├─ AndroidManifest.xml
      ├─ java/com/studentboard/app/MainActivity.java
      └─ res/
         ├─ values/strings.xml          # server_url / app_name / 重试页文案
         ├─ values/themes.xml
         ├─ values/ic_launcher_background.xml
         ├─ xml/network_security_config.xml
         └─ mipmap-*/ic_launcher.png    # 自绘图标
```

## 生成 keystore

本仓库已经生成过一份，位置 `android/keystore/student-board.jks`，口令在同目录的 `keystore.properties`。
要重新生成（例如换机器、口令丢了）：

```powershell
$jdk = "C:\Program Files\Eclipse Adoptium\jdk-17.0.21.10002-hotspot"
& "$jdk\bin\keytool.exe" -genkeypair -v -storetype JKS `
  -keystore android\keystore\student-board.jks `
  -alias student-board -keyalg RSA -keysize 2048 -validity 10000 `
  -storepass "你的库口令" -keypass "你的key口令" `
  -dname "CN=Student Status Board, OU=Home, O=StudentBoard, L=Local, ST=Local, C=CN"
```

然后创建 `keystore.properties`（内容如下）：

```properties
storeFile=keystore/student-board.jks
storePassword=你的库口令
keyAlias=student-board
keyPassword=你的key口令
```

`keystore.properties` 和 `keystore/` 都在 `android/.gitignore` 里，**不会进仓库**。
换签名后旧 APK 不能覆盖安装，要先卸载旧版。

## 构建

前置：JDK 17、Android SDK（platform-tools、platforms;android-35、build-tools;35.0.0）。

```powershell
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-17.0.21.10002-hotspot"
$env:ANDROID_HOME = "D:\android-sdk"
$env:ANDROID_SDK_ROOT = "D:\android-sdk"
cd D:\student-status-board\android
.\gradlew.bat assembleRelease
```

`assembleRelease` 结束后会自动把签名包复制到：

```
release/StudentStatusBoard-1.0.0.apk
```

（Gradle 任务 `copyReleaseApk`，也可以单独跑 `.\gradlew.bat copyReleaseApk`。）

本机环境说明：Gradle 官方源在国内超时，`gradle-wrapper.properties` 指向腾讯镜像
`https://mirrors.cloud.tencent.com/gradle/gradle-8.9-bin.zip`；能直连官方的话换回
`https://services.gradle.org/distributions/gradle-8.9-bin.zip` 即可。
Maven 依赖优先走阿里云镜像。

本机首次搭环境（2026-11-26 已装好，换机器时照抄）：

```powershell
winget install --id EclipseAdoptium.Temurin.17.JDK -e --accept-source-agreements --accept-package-agreements
# Android commandline-tools 11076708 解压到 D:\android-sdk\cmdline-tools\latest
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-17.0.21.10002-hotspot"
& "D:\android-sdk\cmdline-tools\latest\bin\sdkmanager.bat" --sdk_root=D:\android-sdk `
    "platform-tools" "platforms;android-35" "build-tools;35.0.0"
```

## 签名与验证

```powershell
$bt = "D:\android-sdk\build-tools\35.0.0"
& "$bt\apksigner.bat" verify --verbose --print-certs release\StudentStatusBoard-1.0.0.apk
& "$bt\aapt.exe" dump badging release\StudentStatusBoard-1.0.0.apk
```

当前产物（2026-11-26 构建）：

| 项 | 值 |
|---|---|
| 路径 | `release/StudentStatusBoard-1.0.0.apk` |
| 大小 | 49,111 字节（约 48.0 KB） |
| SHA-256 | `EE0D5699B277ECD3E2928154ED3F2C1C9BE3FD63034712A3815CCD196A008A46` |
| 签名方案 | v2 + v3（minSdk 26 下 AGP 默认不生成 v1，Android 8.0+ 用 v2 即可） |
| 证书 DN | `CN=Student Status Board, OU=Home, O=StudentBoard, L=Local, ST=Local, C=CN` |
| 证书 SHA-256 | `FF:FA:B6:C7:84:D4:13:63:3C:51:00:1C:00:32:C3:A8:67:7F:F5:44:50:FD:37:FC:A7:57:4B:20:2A:59:0A:7A` |
| 公钥 SHA-256 | `91:2A:46:91:4A:97:AF:53:B4:6F:AC:A4:08:9A:82:07:A7:40:03:F0:C6:84:68:04:91:0F:80:26:9D:C9:A5:EF` |
| 包名 / 版本 | `com.studentboard.app` / 1.0.0 (1) |
| minSdk / targetSdk | 26 / 35 |

安装（手机开 USB 调试后）：

```powershell
D:\android-sdk\platform-tools\adb.exe install -r release\StudentStatusBoard-1.0.0.apk
```

## 剪贴板说明

网页现有复制逻辑是 `navigator.clipboard.writeText` → `execCommand('copy')` 兜底
（见 `web/src/components/StudentDetailPanel.vue` 的 `copyText`），还没有调用
`window.NativeBridge`。壳在页面加载完成后注入一段垫片，把 `navigator.clipboard.writeText`
转发到 `NativeBridge.copyText` → 系统 `ClipboardManager`，所以网页不用改也能用系统剪贴板。

以后前端如果直接写 `window.NativeBridge.copyText(text)`，同样可用；桥里只有这一个方法。

## 已知限制

- 本机没有连接 adb 设备，**未做真机/模拟器安装验证**；只做了静态验证（apksigner、aapt）。
- 壳只做 Android，未做 iOS。
