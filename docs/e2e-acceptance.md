# 端到端验收报告

> 注：本报告是 2026-11-25 验收时点的快照。2026-11-26 增量：反馈单条删除（二次确认/最后一条清标签）、导入冲突预览与逐条覆盖/新建、导入前自动快照、安装器默认桌面快捷方式（服务可选、手动启动）——以上由 `npm.cmd test`（115 项）覆盖，未重跑浏览器验收。之后新增了「服务器端 LLM 配置同步」，Key 改为 AES-256-GCM 加密存服务器 `app_settings`、登录设备自动同步（见 README §15）；下方 4.2 条记录的是改动前的浏览器本地存储行为。

- 日期：2026-11-25
- 验收人：QA（独立子会话）
- 验收对象：学生状态管理系统（`D:\student-status-board`）
- 环境：Windows 10 / Node v24.22.1 / Edge Headless（Playwright）
- 测试实例：临时数据目录 `.tmp-e2e\data`，端口 `3100`（未触碰真实 `data\`）
- 大模型：本地 HTTPS mock（OpenAI 兼容，`https://127.0.0.1:4011/v1`），后端以 `LLM_ALLOW_INSECURE=1` 放行本地回环，`NODE_TLS_REJECT_UNAUTHORIZED=0` 仅用于信任本次自签证书

## 结论

**通过。** 除「跨网访问」未做真实外网测试（本机无第二网络，部署配置已就绪）外，需求文档逐条都有实现与实测证据；未发现阻断性缺陷。

| 项目 | 结果 |
| --- | --- |
| `npm.cmd test` | 65 / 65 通过 |
| `npm.cmd run build` | 成功，产物 `web/dist`（index.html + assets） |
| Playwright UI/HTTP 用例 | 31 / 31 通过 |
| 需求条目 | 31 项中 30 项通过，1 项未实网测试（跨网访问，部署已就绪） |
| 浏览器控制台错误 | 仅 2 个预期 401（错误密码/未登录探针）与 1 个预期 409（无记录），无脚本异常 |

## 需求逐条核对

### 1. 学生卡片

| # | 需求 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1.1 | 卡片可搜索 | 通过 | 看板搜索「实验」→ 汇总显示「筛选出 2 名」，列表只剩张小明、王小雨；清空恢复 4 名（`desktop-search.png`） |
| 1.2 | 可编辑姓名、学校（除姓名外可空） | 通过 | 新建「待删除」不填学校，卡片显示「未填写学校」；编辑张小明学校「实验小学 → 实验小学东校区」成功后卡片/详情即时更新 |
| 1.3 | 数据存自建服务端，仅账号本人可见 | 通过 | 未登录 `GET /api/students` → 401；数据落在本机 SQLite `data\app.db`（WAL），无第三方请求 |
| 1.4 | 根据反馈总结学生状态，以表现标签展现 | 通过 | 保存反馈后 mock 模型返回词表标签，详情与卡片同时显示「进步明显 / 专注度高 / 作业认真」 |
| 1.5 | 记录用户反馈，用于生成家长反馈 | 通过 | 新增反馈落库并在时间线显示；生成时按区间读取该反馈（生成内容 198 字） |
| 1.6 | 反馈记录结构记录用户反馈时间 | 通过 | `feedbacks.happened_at` 落库；时间线显示「2026-11-25 20:54」 |
| 1.7 | 学生状态存本地，新输入反馈才更新 | 通过 | 标签仅在 `POST /students/:id/feedbacks` 后由 `computeTags` 更新（`server/routes/feedbacks.js:33-41`），无轮询/定时任务；刷新页面不重算 |
| 1.8 | 固定词表 20 个，分三类（正向 8 / 需关注 8 / 状态类 4） | 通过 | `shared/vocabulary.json`：`positive` 8 个、`attention` 8 个、`status` 4 个，共 20 个；前端 `web/src/lib/tags.ts` 直接从该 JSON 构建 |
| 1.9 | 每次状态更新从词表选，最多 3 个 | 通过 | 本次生成 3 个标签，DB `students.tags_json` 为 `["进步明显","专注度高","作业认真"]`；`maxPerStudent=3` |
| 1.10 | 大模型生成可直接复制的家长反馈 | 通过 | 桌面与手机均点「复制」后读剪贴板，内容与生成文本逐字一致（198/198 字符） |
| 1.11 | 按近期反馈生成、老师视角 | 通过 | `server/lib/prompts.js` 系统提示词为一线老师口吻、面向家长、只依据区间反馈；生成结果符合该结构 |
| 1.12 | 参考时间范围按周选择，1~20 任意选 | 通过 | 周数下拉 20 个选项「近 1 周 … 近 20 周」；越界 400 由单测覆盖 |
| 1.13 | 按周（周一~周日）切分找反馈 | 通过 | `weekRange` 单测（周一为起点、跨时区）全绿；API 实测：三周前反馈在 `weeks=1` 时 409、`weeks=4` 时生成成功且 `feedbacks:1` |
| 1.14 | 本周无记录提示并推荐调整范围 | 通过 | 无反馈学生生成 → UI 显示「本周无记录，建议调整参考时间范围」；API 返回 409 `NO_RECORDS` + hint |
| 1.15 | 生成文案存历史，最多最近 5 条 | 通过 | 连续生成 6 次后「最近生成」正好 5 条（`最多保留 5 条`），DB `generations` = 5 |

### 2. 学生增删

| # | 需求 | 结果 | 证据 |
| --- | --- | --- | --- |
| 2.1 | 用户可自行创建、添加、删除学生卡片 | 通过 | UI 新建 4 名学生（周一/周三/周五/周二），均即時出现在对应栏；删除成功 |
| 2.2 | 删除需要二次确认 | 通过 | 弹窗文案「删除后，该学生的全部反馈记录与生成历史将一并删除，且无法恢复。确定删除「待删除」吗？」；点「取消」保留，点「确认删除」才删除 |
| 2.3 | 反馈记录和生成历史连带删除 | 通过 | 删除前给该生写入反馈；删除后 SQLite 检查：`orphan feedbacks=0`、`orphan generations=0`（外键级联 + 事务） |

### 3. 按星期分栏

| # | 需求 | 结果 | 证据 |
| --- | --- | --- | --- |
| 3.1 | 周一~周日七栏，学生按上课星期落位 | 通过 | 桌面 `1440x900`：7 个 `.board-column`，列标题依次为 周一/周二/周三/周四/周五/周六/周日；新建时点击栏位则默认落到该栏 |
| 3.2 | 改星期时卡片自动挪位置 | 通过 | 编辑王小雨 周五→周六，保存后 API `weekday=6`，周六栏立即出现该卡片 |
| 3.3 | 鼠标拖动移动学生上课星期 | 通过 | Playwright 真实鼠标拖拽张小明 周一→周二，DB `weekday=2`；DOM 证据：`column-list` 挂载 SortableJS 实例（属性键 `Sortable1795611280971`） |

### 4. 大模型 API 设置

| # | 需求 | 结果 | 证据 |
| --- | --- | --- | --- |
| 4.1 | 支持 OpenAI 兼容接口 | 通过 | mock 的 `/v1/models`、`/v1/chat/completions` 均被正常调用；标签（非流式）与生成（SSE 流式）都工作 |
| 4.2 | Key 存用户本地、加密 | 通过 | `localStorage["ssb.llm.settings"]` 无明文 key，`secret={v:1,iv,data}`；IndexedDB `CryptoKey`：`type=secret`、`extractable=false`、`AES-GCM`、256 位 |
| 4.3 | 用户自填 base_url | 通过 | 设置页「接口地址 base_url」保存为 `https://127.0.0.1:4011/v1`；前端强制 https，后端二次校验（生产拒绝内网） |
| 4.4 | 模型自动探测、测试是否可用、由用户选择 | 通过 | 「探测模型」→「探测成功，发现 2 个模型」，自动选中 `mock-gpt-4o`；`POST /api/llm/test` → `{ok:true, content:"pong"}` |
| 4.5 | 探测失败可手动填模型名兜底 | 通过 | 用不可达地址探测 → 提示「探测失败：大模型接口请求失败」，自动切换手动输入框，可填写 `manual-model-x`（`desktop-settings-manual-fallback.png`） |
| 4.6 | 支持异步和同步接口 | 通过 | 生成走 `stream:true` SSE（逐段 198 字）；标签走 `stream:false` 非流式；单测「上游忽略 stream 直接回 JSON：仍能生成」通过 |

### 5. 平台

| # | 需求 | 结果 | 证据 |
| --- | --- | --- | --- |
| 5.1 | 电脑网页端用于维护（增删改、星期调整、反馈录入与历史） | 通过 | `1440x900` 下完成：新建/编辑/删除、改星期、拖拽、反馈录入、标签刷新、生成与历史查看 |
| 5.2 | 手机端用于查看状态与标签、生成并复制反馈 | 通过 | `390x844` 下打开张小明详情，查看标签与反馈，切换到「生成家长反馈」生成 198 字并复制成功（剪贴板一致，`mobile-generate.png`） |
| 5.3 | 手机屏幕窄，星期用标签切换，不做分栏 | 通过 | 390 宽下 `.desktop-board` 不存在，显示 7 个 `.weekday-tab`；点击「周三」active 切换，列表随标签变化 |
| 5.4 | 跨网使用：账号登录 + HTTPS，自建服务端同步 | 未实网测试（配置就绪） | 登录/会话已实测；生产默认 `COOKIE_SECURE=true`，部署文档提供 `tailscale serve --bg http://127.0.0.1:3210`（自动签发 `*.ts.net` 证书）。本机无第二网络环境，未做真实外网访问验证 |

## 非功能与部署核对

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 单元/集成测试 | 通过 | `npm.cmd test`：65 通过 / 0 失败（含周切分、SSRF、限流、级联删除、备份脚本） |
| 生产构建 | 通过 | `npm.cmd run build` 成功；`web/dist/index.html` + assets；构建前需把 TEMP/TMP 指到 `.tmp-build`（本机 esbuild 临时文件权限问题，已写 README 11.11） |
| 静态托管 / SPA | 通过 | `GET /` 200 返回构建首页；`GET /board` 200（history 路由 fallback）；`/api/healthz` = `{"ok":true,"db":true}` |
| 备份脚本 | 通过 | 连续 3 次 `--keep 2` 只留 2 个 `.db`，无 `-wal/-shm` 残留；`integrity_check=ok` |
| 数据库 | 通过 | `journal_mode=wal`；删除学生后无孤儿反馈/生成记录 |
| 安全边界 | 通过 | 未登录 401；删除缺 `confirm:true` → 400；登录错误提示不泄露账号信息 |

## M5 验收记录（2026-11-26）

> 结果：M5-1 备份 8/8 通过；M5-2 发布包/部署 2 项通过 + 1 项 DryRun 通过（真实服务注册/卸载/换机未实跑）；M5-3 APK 静态检查 5/5 通过（无 Android 设备，未做真机运行）；M5-4 更新自测 6/6 通过。

### M5-1 备份导出 / 导入

| # | 检查项 | 期望 | 结果 | 证据 |
| --- | --- | --- | --- | --- |
| B1 | 导出全部 | 下载 `student-status-board-YYYY-MM-DD.json`，含 `schema=student-status-board/backup`、`version=1`、`exported_at`、全部学生 | 通过 | `docs/m5-backup-api-report.json`（10/10）；schema/version/students=2；`docs/screenshots/m5-backup-desktop.png` |
| B2 | 单学生导出 | 只含该生信息、反馈（时间正序）、最近 5 条生成历史 | 通过 | `GET /api/backup/export?studentId=1` → students=1、generations=5；`m5-backup-api-report.json` |
| B3 | 不导出敏感设置 | JSON 不含 `api_key` / `app_settings` / 模型设置 | 通过 | 全文无 `api_key` / `app_settings` / `base_url`；配置 fake Key 后再导出仍不含 |
| B4 | 导入 · 新建 | 同名同校也新建，原数据不清空，`sort` 追加目标栏末尾 | 通过 | `created=2`，students 2→4；`m5-backup-api-report.json` |
| B5 | 导入 · 覆盖 | 同名同校覆盖信息并替换反馈/生成历史；未带 `confirm_overwrite:true` 返回 `400 CONFIRM_REQUIRED` | 通过 | 缺确认 400 `CONFIRM_REQUIRED`；带确认 `overwritten=2`、反馈替换为「覆盖后的反馈」 |
| B6 | 文件校验 | 非 JSON / schema 或 version 不对 → 400 `INVALID_BACKUP`；UI 显示格式/版本错误 | 通过 | API 400 `INVALID_BACKUP`；UI「备份文件版本不支持」「文件不是合法 JSON」；`m5-backup-error.png` |
| B7 | 事务回滚 | 第二条学生非法时，第一条也不入库（整批回滚） | 通过 | 学生数保持 4，「回滚甲」未入库；`m5-backup-api-report.json` |
| B8 | UI 流程 | 设置页「备份与恢复」显示摘要、冲突选择、覆盖二次确认；手机端提示去电脑操作 | 通过 | 桌面卡片/导出全部/摘要/覆盖确认；手机提示；详情「导出该学生」；`m5-backup-desktop.png` / `m5-backup-mobile.png` / `m5-backup-detail.png` / `m5-backup-import-confirm.png` |

### M5-2 Windows 发布 / 一键部署 / 换电脑

| # | 检查项 | 期望 | 结果 | 证据 |
| --- | --- | --- | --- | --- |
| W1 | 发布包 | `npm.cmd run package` 产出目录 + zip + `release\version.json`（含 zip sha256、files_sha256） | 通过 | 版本 1.0.0、51 个文件；zip 12,178,963B、sha256=`7faeeca68685f1edab52113ce9478ea0b854d7d08fd9eb99a9678d9fa73f9cf6`；`docs/m5-release-check.json` |
| W2 | 发布包内容 | 带 `web/dist`、生产 `node_modules`；不含 `data\`、`config.json`、日志、dev 依赖 | 通过 | 解压后 51/51 files_sha256 匹配；zip 无 data/logs；含 better-sqlite3、不含 vite；`m5-release-check.json` |
| W3 | 一键部署 | `deploy\install.ps1` 完成 Node 检测/下载、依赖、设密码、桌面快捷方式、防火墙、Tailscale、备份任务、healthz；默认不装服务 | 通过（DryRun） | `-DryRun -NoElevate -SkipTailscale -SkipBackupTask` 退出码 0，打印快捷方式/防火墙/冒烟计划；真实安装未执行 |
| W4 | 幂等 | 重复跑不重复建服务/任务，不重置已有密码和数据 | 未实测（真实安装会改本机服务） | 代码幂等逻辑已审阅，未做二次真实安装 |
| W5 | 换电脑 | 整目录拷贝后可直接起；或 JSON 导入（新机重新填 Key） | 未实测（无第二台电脑） | JSON 导出/导入已在 M5-1 实测；整目录拷贝未真机验证 |
| W6 | 卸载 | `deploy\uninstall.ps1` 保留 data，`-PurgeData` 才删 | 未实测（未执行卸载） | 脚本存在并已检查参数说明 |

### M5-3 Android APK

| # | 检查项 | 期望 | 结果 | 证据 |
| --- | --- | --- | --- | --- |
| A1 | APK 安装 | `release\StudentStatusBoard-1.0.0.apk` 可侧载安装；包名 `com.studentboard.app`、versionName `1.0.0` | 通过（静态） | APK 45,957B；aapt：package=`com.studentboard.app`、versionName=`1.0.0`、minSdk=26/targetSdk=35；`docs/m5-apk-check.txt` |
| A2 | 签名 | v2 + v3 签名（apksigner：v2 true / v3 true / v1 false）；同签名可覆盖升级 | 通过 | apksigner verify 输出；`m5-apk-check.txt` |
| A3 | WebView 行为 | 启动进 ts.net；HTTPS-only、自签拒绝；返回键回退；断网显示重试页 | 通过（静态） | `MainActivity.java` / `network_security_config.xml` / Manifest：HTTPS 白名单、SSL cancel、重试页、返回键逻辑；未真机运行 |
| A4 | 复制桥 | 生成反馈「复制」走系统剪贴板，内容一致 | 通过（静态） | `MainActivity` 的 `NativeBridge.copyText` + 页面 clipboard shim；未真机运行 |
| A5 | 权限/边界 | 只申请 INTERNET；外链交系统浏览器；页面随服务端更新无需发版 | 通过（静态） | aapt permissions 只有 INTERNET；Manifest `usesCleartextTraffic=false`、`networkSecurityConfig`；外链/白名单源码核对 |

### M5-4 检查更新

| # | 检查项 | 期望 | 结果 | 证据 |
| --- | --- | --- | --- | --- |
| U1 | 版本比较 | 不新则退出；有新版本才下载 | 通过 | `deploy/self-test.ps1 -SkipPackage` semver 用例全 PASS；`docs/m5-selftest-summary.txt` |
| U2 | 包校验 | zip sha256 + 逐文件 files_sha256 不匹配拒绝安装 | 通过 | 自测：zip sha256/大小匹配、51 文件全匹配；篡改 sha256 退出码 1 且版本未变 |
| U3 | 更新替换 | 只换程序，`data/`、`logs/`、`updates/`、`backups/`、`runtime/` 保留 | 通过 | 自测 0.9.0→1.1.0：版本变为 1.1.0，data/logs 未受影响，生成 backups\app-0.9.0 |
| U4 | 失败回滚 | 新版本起不来/healthz 30 秒不通 → 自动回滚旧程序并重起 | 通过 | 坏包 1.1.1 更新退出码 1，回滚后 1.1.0，`update.log` 有回滚记录 |
| U5 | 离线手动包 | zip + version.json 放 `updates\`，`-LocalOnly` 能识别；来路不明/缺 sha 默认拒绝 | 通过 | 自测本地包更新与 sha 篡改拦截通过；`docs/m5-selftest-summary.txt` |
| U6 | 自测 | `npm.cmd run test:release` 全 PASS | 通过 | `deploy/self-test.ps1 -SkipPackage` 退出码 0，全部 PASS |
## 截图

| 文件 | 内容 |
| --- | --- |
| [desktop-board.png](screenshots/desktop-board.png) | 桌面 1440x900 七栏看板（4 名学生，含标签） |
| [desktop-detail.png](screenshots/desktop-detail.png) | 桌面 1440x900 学生详情 / 生成家长反馈（标签 + 历史 5 条） |
| [mobile-board.png](screenshots/mobile-board.png) | 手机 390x844 星期标签看板（周二） |
| [mobile-detail.png](screenshots/mobile-detail.png) | 手机 390x844 学生详情整页（标签 + 反馈时间线） |
| [mobile-generate.png](screenshots/mobile-generate.png) | 手机生成家长反馈结果（可复制） |
| [desktop-search.png](screenshots/desktop-search.png) | 搜索「实验」筛选结果 |
| [desktop-settings.png](screenshots/desktop-settings.png) | 设置页字段 |
| [desktop-settings-manual-fallback.png](screenshots/desktop-settings-manual-fallback.png) | 探测失败后的手动填模型名兜底 |

## 遗留问题 / 风险

1. **跨网访问未实网验证**（需求 5.4）：本机只有单网络环境，Tailscale/手机外网访问按 README §6 配置，需在真实第二网络下补一次冒烟。
2. **生产包体积**：`element-plus` chunk 约 929KB（gzip 300KB），已拆分但仍偏大；不影响功能，手机首屏在慢网下会多等一会儿。
3. **构建环境坑**：本机 `npm run build` 会因 esbuild 删除 `%TEMP%` 临时文件被拒而失败，需 `TEMP/TMP=.tmp-build`（README 11.11 已写）；CI/其他机器未必复现。
4. **测试用 mock 限制**：标签/生成用本地 mock 验证协议与链路，真实厂商接口的模型质量、超时、限流未在本轮覆盖（单测已覆盖上游错误映射）。

## 复现方式

```powershell
# 测试服务（已跑完可跳过）
$env:DATA_DIR='D:\student-status-board\.tmp-e2e\data'
$env:PORT='3100'; $env:COOKIE_SECURE='false'; $env:LLM_ALLOW_INSECURE='1'
node scripts/init.js --password <临时密码>
node server/index.js
# mock：node .tmp-e2e\mock-llm.mjs（HTTPS 见 .tmp-e2e 下启动参数）
# UI：cd .tmp-e2e\pw; node e2e.mjs
```
