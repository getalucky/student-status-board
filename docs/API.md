# API 契约（后端实现版）

全部接口前缀 `/api`。除 `POST /api/auth/login`、`GET /api/auth/status`、`GET /api/healthz` 外，均要求会话 Cookie（`ssb_sid`，HttpOnly + Secure + SameSite=Lax，30 天滑动）。未登录统一 `401 {"error":"UNAUTHORIZED","message":"未登录或会话已过期"}`。

错误体统一为 `{"error":"<CODE>","message":"<人话>", ...}`；`VALIDATION_ERROR` 会带 `details:[{path,message}]`。

## 认证

| 方法 | 路径 | 请求 | 成功响应 |
|---|---|---|---|
| POST | `/api/auth/login` | `{password}` | `{ok:true, expiresAt}` + Set-Cookie |
| POST | `/api/auth/logout` | 无 | `{ok:true}`，清 Cookie |
| GET | `/api/me` | — | `{authenticated:true, expiresAt}` |
| GET | `/api/auth/status` | — | `{initialized, sessionTtlDays, loginRateMax, loginRateWindowMs}` |
| GET | `/api/healthz` | — | `{ok:true, db:true, uptime}` |

登录限流：默认 5 次/分钟/IP，超限 `429 RATE_LIMITED`。账号未初始化：`503 NOT_INITIALIZED`。密码错：`401 INVALID_PASSWORD`。

## 学生

| 方法 | 路径 | 请求 | 成功响应 |
|---|---|---|---|
| GET | `/api/students` | 可选 `?weekday=1..7` | `Student[]`（按 weekday,sort,id 升序） |
| GET | `/api/students/:id` | — | `Student` |
| POST | `/api/students` | `{name, school?, weekday}` | `201 Student` |
| PATCH | `/api/students/:id` | `{name?, school?, weekday?, sort?}` | `Student` |
| DELETE | `/api/students/:id` | `{confirm:true}` | `{ok:true, deleted:{student,feedbacks,generations}}` |

`Student = {id, name, school:string|null, weekday:1-7, sort:number, tags:string[], tags_at:number|null, created_at, updated_at}`。

- `weekday` 变更且未带 `sort`：自动追加到目标栏末尾（`max(sort)+1`）。
- 拖动换栏：`PATCH {weekday, sort}`，`sort` 取目标位置前后两项中点。
- 删除必须 `confirm:true`（否则 400 `VALIDATION_ERROR`），事务内级联删除该生反馈与生成历史。

## 反馈与标签

| 方法 | 路径 | 请求 | 成功响应 |
|---|---|---|---|
| GET | `/api/students/:id/feedbacks` | — | `Feedback[]`（happened_at 倒序） |
| POST | `/api/students/:id/feedbacks` | `{content, happened_at?, base_url?, api_key?, model?}`（凭据可全省略） | `201 {feedback, tags, tags_updated, tags_at?, reason?, message?}` |
| DELETE | `/api/students/:id/feedbacks/:feedbackId` | `{confirm:true}` | `{ok:true, deleted, remaining, tags_cleared, tags, tags_at}` |
| POST | `/api/students/:id/tags/refresh` | `{base_url?, api_key?, model?}`（可省略，用服务器配置） | `{tags, tags_updated, tags_at?, reason?}` |

- 凭据字段全部可省略：缺省时用服务器已保存的配置（`GET /api/llm/config` 那份）补齐；也可以放 `llm:{}` 或请求头。

- `happened_at`：epoch 毫秒 / 秒级时间戳 / ISO 字符串，缺省为服务器当前时间。
- 保存反馈后取该生**最近 10 条** + 20 词固定词表请求模型，输出 `{"tags":[...]}`。
- 校验：词表外丢弃、去重、最多 3 个；全部无效 ⇒ 保留旧标签且 `tags_updated:false`。
- **标签失败不影响反馈保存**：模型不可用时仍返回 201，`tags_updated:false` + `reason`（`LLM_NOT_CONFIGURED` / `LLM_UPSTREAM` / `INVALID_TAGS` / `NO_FEEDBACKS`）。
- `/tags/refresh` 是手动重算：上游失败会返回 `502 LLM_UPSTREAM`（不像保存反馈那样降级）。
- 删除反馈必须 `confirm:true`，否则 `400 CONFIRM_REQUIRED`；记录不存在或不属于该学生返回 `404 NOT_FOUND`。删完该生最后一条反馈时标签一并清空（`tags_cleared:true`、`tags:[]`、`tags_at:null`）。

## 生成（SSE）

`POST /api/students/:id/generate`，请求 `{weeks:1..20, base_url?, api_key?, model?}`；凭据可省略，缺省用服务器已保存的配置（也可放 `llm:{}` 或请求头）。

- `weeks` 非 1~20 整数 ⇒ `400 VALIDATION_ERROR`
- 区间（本周一 00:00 往前推 `weeks-1` 周 ~ 本周日 23:59:59.999，Asia/Shanghai）内无反馈 ⇒ **`409 {"error":"NO_RECORDS","message":"本周无记录，建议调整参考时间范围","range":{...}}`**（JSON，不是 SSE）
- 有反馈 ⇒ `200 text/event-stream`：

```
event: start
data: {"weeks":1,"from":1795190400000,"to":1795795199999,"feedbacks":3}

event: delta
data: {"text":"孩子这段时间"}

event: done
data: {"id":12,"content":"完整文案","weeks":1,"created_at":1795600000000}

event: error
data: {"error":"LLM_UPSTREAM","message":"..."}
```

完成后落库，并只保留该生最近 5 条（`GET /api/students/:id/generations` 返回数组，`created_at` 倒序）。

`DELETE /api/students/:id/generations/:generationId`，请求 `{confirm:true}`；缺确认 `400 CONFIRM_REQUIRED`，不属于该生 `404 NOT_FOUND`；成功 `{ok:true, deleted:1}`。

## 备份 / 恢复

| 方法 | 路径 | 请求 | 成功响应 |
|---|---|---|---|
| GET | `/api/backup/export` | 可选 `?studentId=<正整数>` | `200 application/json`，`Content-Disposition: attachment; filename="student-status-board-YYYY-MM-DD.json"`，body 见下 |
| POST | `/api/backup/preview` | `{data:<备份对象>}` | `{ok:true, summary:{students,feedbacks,generations,exported_at}, conflicts:[...]}` |
| POST | `/api/backup/import` | `{data:<备份对象>, conflict?:"new"\|"overwrite", decisions?:[{index,action}], confirm_overwrite?:true}` | `{ok:true, students:n, feedbacks:n, generations:n, overwritten:n, created:n, backup_file:"data/backups/pre-import-....db"}` |

导出 JSON 结构（单个学生与全体学生同一结构）：

```json
{
  "schema": "student-status-board/backup",
  "version": 1,
  "exported_at": 1795618886723,
  "students": [
    {
      "name": "张小明",
      "school": "实验小学",
      "weekday": 1,
      "sort": 1,
      "tags": ["进步明显", "专注度高"],
      "tags_at": 1795618886723,
      "created_at": 1795618886723,
      "updated_at": 1795618886723,
      "feedbacks": [{ "content": "作业完成认真", "happened_at": 1795618886723 }],
      "generations": [{ "content": "家长反馈正文", "weeks": 1, "created_at": 1795618886723 }]
    }
  ]
}
```

- `studentId` 省略 = 全体导出；指定单个学生时学生不存在返回 `404 NOT_FOUND`，`studentId` 不是正整数返回 `400 VALIDATION_ERROR`。
- 导出只含业务数据，**绝不包含 `api_key`、`app_settings` 或任何模型设置**；每个学生的 `generations` 最多导出最近 5 条，`feedbacks` 按时间从早到晚。
- 导入 `conflict:"new"`：同名同校也新建一条学生（`sort` 追加到目标星期末尾）；`conflict` 不是 `new`/`overwrite` 返回 `400 VALIDATION_ERROR`。
- 导入 `conflict:"overwrite"`：按「姓名 + 学校」匹配并覆盖该学生，同时替换其反馈与生成历史；必须带 `confirm_overwrite:true`，否则 `400 CONFIRM_REQUIRED`。
- `decisions` 用于逐条选择：`index` 是备份里 `students[]` 的下标，`action` 为 `new`/`overwrite`；给了 `decisions` 的条目按它走，没给的按 `conflict`（默认 `new`）。只要有任一条最终会覆盖，就必须 `confirm_overwrite:true`。`index` 越界或重复返回 `400 VALIDATION_ERROR`。
- `POST /api/backup/preview` 不写库，返回摘要和冲突清单：`conflicts[] = {index,name,school,weekday,existing:{id,feedbacks,generations}}`。前端据此逐条渲染“新建/覆盖”。
- 导入前会自动把当前库快照到 `data/backups/pre-import-<时间戳>.db`（只保留最近 10 份），响应里的 `backup_file` 是相对路径；快照失败则整个导入中止。
- 导入前校验 `schema`、`version` 和每个字段；不合法返回 `400 INVALID_BACKUP`（文件版本/格式不对时前端提示「备份文件版本不支持」或「备份文件格式不正确」）。
- 整批导入在同一个 SQLite 事务内执行，任何一条学生/反馈/生成不合法或写库失败都整体回滚，不会留下半份数据。
- 未登录访问两个接口均 `401 UNAUTHORIZED`。

## 大模型代理

| 方法 | 路径 | 请求 | 成功响应 |
|---|---|---|---|
| GET | `/api/llm/config` | — | `{configured, base_url, model, has_key, updated_at}` |
| PUT | `/api/llm/config` | `{base_url, model, api_key?}` | 保存后的公开配置（同 GET） |
| DELETE | `/api/llm/config` | — | `{ok:true}` |
| POST | `/api/llm/models` | `{base_url, api_key}` | `{ok:true, base_url, count, models:[{id,owned_by?,created?}], allow_manual_model:true}` |
| POST | `/api/llm/test` | `{base_url, api_key, model}` | `{ok:true, model, content}` |

- `GET /api/llm/config` **永不返回 `api_key`**，只给 `has_key:boolean`；未配置时为 `{configured:false, base_url:null, model:null, has_key:false, updated_at:null}`。
- `PUT /api/llm/config` 的 `api_key` 可省略、传空字符串或 `null`：已有配置时**保留旧 Key**，只更新 base_url/model；首次配置必须带 Key，否则 `400 LLM_NOT_CONFIGURED`。
- `PUT` 会先做 https + SSRF 校验，非法 base_url 不落库；账号未初始化返回 `503 NOT_INITIALIZED`；成功返回与 GET 相同的公开结构。
- 重置登录密码后旧密文解不开，`GET /api/llm/config` 会回到 `configured:false`，需要重新 PUT 一次 Key。
- `DELETE /api/llm/config` 幂等，删除服务器保存的配置。
- 服务器配置以 AES-256-GCM 密文存放在 `app_settings(key='llm_config')`，加密密钥由 `data/config.json` 的 `passwordHash` 派生，不额外落密钥文件。
- 内置 `base_url` 必须 `https` 且不能指向内网/回环/保留地址（SSRF 防护）；测试环境可用 `LLM_ALLOW_INSECURE=1` 放开（生产禁用）。
- 凭据既可放 body（`{base_url, api_key, model}` 或 `llm:{}`），也可放请求头 `x-llm-base-url` / `x-llm-api-key` / `x-llm-model`（URL 编码）；两边都有时 body 优先。请求里缺的字段会用服务器已保存配置补齐（`/models`、`/test`、保存反馈的标签、生成都走同一套 `resolve`）。
- 探测/测试超时 10s；上游非 2xx / 超时 / 非法 JSON 统一 `502 LLM_UPSTREAM`。
- `api_key` 在请求中只用于本次转发、不写日志；保存到服务器的配置以密文落库，`GET /api/llm/config` 不回传明文。
