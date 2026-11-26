# deploy 目录说明（M5 封装与分发）

| 文件 | 用途 |
| --- | --- |
| `install.ps1` | **一键部署**：提权 → 检测/补 Node ≥22 → 装生产依赖 → 首次设密码 → 桌面一键启动快捷方式 → 防火墙（LocalSubnet）→ `tailscale serve` → 每日 03:00 备份 → 冒烟检查。默认不装开机自启服务，`-InstallService` 才注册（手动启动）。幂等，可重复跑 |
| `uninstall.ps1` | 停服务 + 删服务/备份任务/桌面快捷方式，**数据保留**；可选删日志/运行时/Tailscale 规则 |
| `install-service.ps1` / `uninstall-service.ps1` | 老版本只装/卸服务的脚本，保留兼容；一键部署请用 `install.ps1` / `uninstall.ps1` |
| `tailscale-serve.ps1` | 单独配置 / 查看 `tailscale serve` |
| `backup-task.ps1` | 单独注册每日备份任务（install.ps1 已内置同样的任务，可不用） |
| `release.json` | 更新源配置：`repo`、`api_base`、`allow_local_updates`。发布前把 `owner/name` 改成真实 GitHub 仓库 |
| `self-test.ps1` | 发布/更新链路自测（临时目录，不碰真实 data、不注册服务） |

## 一键部署

管理员 PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\install.ps1
```

常用参数：

```powershell
-ProjectRoot <目录>      项目根（默认脚本上一级）
-Port 3210              监听端口（需求固定 3210）
-Password <密码>         首次初始化密码（不填交互输入）
-SkipNodeInstall        不自动下载 Node（只接受本机已有 ≥22）
-SkipDeps               跳过 node_modules 安装
-InstallService         额外注册 Windows 服务（手动启动，不开机自启）\n-SkipShortcut           不创建桌面快捷方式
-SkipTailscale          不配置 tailscale serve
-SkipBackupTask         不注册每日备份
-DryRun                 只打印计划，不写任何东西
```

## 更新

1. 把 `deploy\release.json` 的 `repo` 改成真实 `owner/name`。
2. 发版：`npm.cmd run package` → `release\student-status-board-<ver>.zip` + `release\version.json` 上传到 GitHub Release（两个都传）。
3. 本机双击 **`检查更新.cmd`**：比版本 → 下载 → 校验 sha256 → 停服务 → 备份程序到 `backups\app-<旧版本>\` → 替换程序 → 跑 `scripts\migrate.js`（存在才跑）→ 起服务 → 30 秒 `/api/healthz` 探活，失败自动回滚。
4. GitHub 打不开时：把 zip 和配套 `version.json` 放进安装目录的 `updates\`，再双击 `检查更新.cmd`（会自动识别）。
5. 日志：`logs\update.log`。

## 发布包

```powershell
npm.cmd run package
# 或
powershell -ExecutionPolicy Bypass -File .\scripts\package-release.ps1
```

产物：

- `release\student-status-board-<ver>\`：可直接运行的目录（含生产 `node_modules`）
- `release\student-status-board-<ver>.zip`：整包压缩
- `release\version.json`：版本、最低 Node、zip 的 sha256/大小、文件清单

发布包不含 `data\`、`logs\`、dev 依赖（vite/vue/element-plus 等），`better-sqlite3` 只保留 Windows 预编译。

## 自测

```powershell
npm.cmd run test:release
# 或
powershell -ExecutionPolicy Bypass -File .\deploy\self-test.ps1
```

覆盖：打包、zip sha256、逐文件 files_sha256、semver 比较、本地 updates 更新、保留 data、回滚、sha256 篡改拦截。全部在 `%TEMP%` 里跑，不动真实数据和服务。
