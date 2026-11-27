# 服务器加密配置 / 多设备同步 · 回归报告

- 日期：2026-11-25
- 范围：服务器端 LLM 配置同步（`app_settings`）、电脑/手机两个独立会话、无凭据兜底、局域网 HTTP 提示
- 环境：Windows 10 / Node v24.22.1 / Edge Headless（Playwright）
- 实例：临时 `DATA_DIR=.tmp-reg\data`、`PORT=3101`、`HOST=0.0.0.0`（走局域网 IP `192.168.1.5:3101`）；未触碰 3210 的真实数据
- 模型：本地 HTTPS mock（`https://127.0.0.1:4012/v1`）；`LLM_ALLOW_INSECURE=1` + 自签证书仅用于本次测试
- 结论：**15 / 15 通过，0 失败**

## 测试设计

| 端 | 上下文 | 说明 |
| --- | --- | --- |
| 电脑 | 1440x900，Chrome/Edge 默认 UA | 负责写入配置 |
| 手机 | 390x844，iPhone Safari UA，`isMobile/hasTouch` | 独立 Context、独立 Cookie，登录同一账号 |

两个 Context 完全独立（不共享 Cookie / localStorage / IndexedDB），手机端从不输入 Key。

## 结果清单

| # | 检查项 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 桌面登录 | 通过 | `http://192.168.1.5:3101/` |
| 2 | 局域网 HTTP 下设置页出现明文传输警告 | 通过 | 警告标题「当前是 HTTP」，描述「提交 Key 会以明文经过局域网，正式使用请走 Tailscale HTTPS。」（`server-config-desktop.png`） |
| 3 | 桌面保存 base_url / Key / 模型 | 通过 | toast「设置已保存并同步到服务器」；状态徽标「已加密同步到服务器」；保存后 Key 输入框清空，placeholder 变为「已保存在服务器，留空不修改」 |
| 4 | `GET /api/llm/config` 不含 `api_key` | 通过 | `{"configured":true,"base_url":"https://127.0.0.1:4012/v1","model":"mock-gpt-4o","has_key":true,"updated_at":...}`；响应字符串不含明文 Key |
| 5 | SQLite `app_settings` 原值不含明文 Key | 通过 | `value` 为密文 JSON，字段 `v/iv/tag/data`，原文长度 202；不含明文 Key |
| 6 | 数据库文件层面也无明文 Key | 通过 | `app.db`、`app.db-wal` 字节中均未命中 Key |
| 7 | 桌面创建同步测试学生 | 通过 | id=1，周三 |
| 8 | 手机独立 Context 登录同一账号 | 通过 | 手机 UA + 独立 Cookie 登录成功 |
| 9 | 手机设置页自动带出同一 base_url / model，Key 留空，状态已同步 | 通过 | base_url=`https://127.0.0.1:4012/v1`、model=`mock-gpt-4o`、Key 输入为空、状态「已加密同步到服务器」、HTTP 警告存在（`server-config-mobile.png`） |
| 10 | 手机不填 Key 点「测试连接」成功 | 通过 | 结果区「连接成功」，内容 `pong` |
| 11 | HTTP 空 body 调 `/api/llm/test` 也走服务器配置 | 通过 | `{"ok":true,"model":"mock-gpt-4o","content":"pong","message":"pong"}` |
| 12 | 手机录反馈后标签按 mock 模型更新 | 通过 | 标签「进步明显 / 专注度高 / 作业认真」（`server-config-mobile-feedback.png`） |
| 13 | 手机生成 SSE 成功并落历史 | 通过 | 输出 120 字，历史出现；`server-config-mobile-generate.png` |
| 14 | 手机不传任何凭据调 `/students/:id/generate` 成功 | 通过 | `status=200`，`event: start`、`event: delta`、`event: done` 均出现，无 `event: error` |
| 15 | 手机本地存储不含明文 Key | 通过 | `localStorage['ssb.llm.settings']` 不存在（服务器配置模式不再写本地 Key） |

## 关键证据

`GET /api/llm/config` 返回（桌面 Context，带会话 Cookie）：

```json
{"configured":true,"base_url":"https://127.0.0.1:4012/v1","model":"mock-gpt-4o","has_key":true,"updated_at":1795618886723}
```

`app_settings` 原值结构（密文，已脱敏展示字段名）：

```json
{"v":1,"iv":"...","tag":"...","data":"..."}
```

手机端无凭据生成（请求体只有 `{"weeks":1}`）：

```
status=200
event: start  data: {"weeks":1,"from":...,"to":...,"feedbacks":1}
event: delta  data: {"text":"孩子这段时间..."}
event: done   data: {"id":...,"content":"...","weeks":1,...}
```

## 截图

| 文件 | 内容 |
| --- | --- |
| [server-config-desktop.png](screenshots/server-config-desktop.png) | 桌面设置页：HTTP 警告、已加密同步徽标、base_url/model、Key 留空 |
| [server-config-mobile.png](screenshots/server-config-mobile.png) | 手机设置页：独立 Context 自动同步同一配置，Key 为空 |
| [server-config-mobile-feedback.png](screenshots/server-config-mobile-feedback.png) | 手机详情：反馈已保存、标签已更新 |
| [server-config-mobile-generate.png](screenshots/server-config-mobile-generate.png) | 手机详情：生成结果 |

## 说明与遗留

1. **HTTP 警告只在非 loopback 地址出现**：前端判断 `location.hostname` 不是 `localhost/127.0.0.1` 时才提示。测试从 `127.0.0.1` 改为局域网地址 `192.168.1.5:3101` 后才命中该提示；这是设计预期，不是 bug。
2. **手机为模拟环境**：iPhone UA + 390x844 + touch，不是真机；局域网防火墙放行（菜单 `5` 放行防火墙）未在本轮重复验证。
3. **模型为本地 mock**：验证的是配置同步、加密落库、凭据兜底与 SSE 链路，不评估真实厂商模型质量/限额。
4. 测试实例已停止（3101/4012 无监听），临时目录 `.tmp-reg` 与自签证书已清理；3210 上的真实服务与数据未触碰。
