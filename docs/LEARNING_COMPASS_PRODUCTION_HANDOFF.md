# 学习指南针生产后端交接文档（回交）

> 日期：2026-08-25
>
> 撰写：NKUStudy 生产后端负责人（nkustudy.top）
>
> 对应需求交接：`learning-compass-backend-handoff-20260825` 中的 `LEARNING_COMPASS_BACKEND_API_HANDOFF.md` 与 `LEARNING_COMPASS_BACKEND_IMPLEMENTATION_HANDOFF.md`
>
> 状态：A 批（普通指南）与 B 批（AI 问答）已在生产实现并部署；AI 真实调用待在管理页配置 DashScope API Key 后即生效。本文面向小程序端与其他协作者，说明生产实现、接口契约、配置方式与验收证据。

## 一、结论速览

| 事项 | 状态 |
| --- | --- |
| 五分类指南列表 / 详情 / 学院变体 / search-index | 已上线，线上验证通过 |
| 35 份官方原件 R2 公网直链 | 已上传，逐个可访问（PDF/DOC/DOCX Content-Type 正确） |
| 旧 `steps/source_title/source_url` | 已按产品决定直接移除（未公测，无兼容窗口） |
| AI 问答 `POST /api/v1/guide-assistant/answers` | 已上线；未配置 Key 时稳定 503，普通指南不受影响 |
| AI 配置管理（API 与模型） | 已上线网页管理后台「AI 问答」标签，保存即生效 |
| 真实模型 30 题评测 | 待配置 Key 后执行（验收清单要求） |

## 二、架构选择：方案 A（同进程集成）

按实施任务书在阶段 0 完成盘点后选择**方案 A**：直接在现有 Node 生产服务内实现，不拆独立 AI 进程。理由：

- 单一维护者，改动最小、部署/回滚沿用现有 systemd + release 目录流程；
- 直接复用现有微信登录态（`mp_users`/`mp_auth_tokens`）、SQLite 持久限流、原子 JSON 存储与 R2 helper，零新增基础设施；
- 小程序端调用统一入口 `https://nkustudy.top/api/v1/guide-assistant/answers`，与需求文档一致。

未引入 PostgreSQL / Redis / 向量库 / 第二套用户体系。

## 三、数据 owner（对照实施任务书第四节）

| 数据 | 生产 owner | 位置 |
| --- | --- | --- |
| 18 篇指南、章节、205 逐字块、29 学院变体、35 原件映射 | 版本化内容快照（随 git 发布） | `server/data/learning-compass-snapshot.json` |
| 构建输入（小程序侧交付的已验证生成数据） | 内容事实来源 | `content/learning-compass.generated.json` |
| 快照构建脚本（含计数校验与内容 hash） | 可重复构建 | `scripts/build-learning-compass-snapshot.mjs` |
| 用户、Token、黑名单、限流 | 现有 SQLite | `/var/lib/nkustudy/miniprogram.sqlite` |
| 官方原文件 | R2 `guide-sources/` 前缀 | `https://resources.nkustudy.top/guide-sources/<文件名>` |
| AI API Key、模型、限流参数 | 管理页配置落盘（0600） | `/var/lib/nkustudy/json/ai-provider-settings.json` |
| AI 运行检索用逐字块与冲突主题 | 快照私有字段，不进任何公共 DTO | 同快照 |

快照当前版本：`c3w1IAmwrjRrhxvwjzMYjyr5`（18 published / 29 variants / 205 公开块 / 35 原件 / 1 项私有冲突）。

## 四、公共接口契约（正式）

### A 批

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/guides` | 稳定五分类 + facets + 分页 |
| GET | `/api/v1/guides/:guideId` | sections/sources/variants 详情 |
| GET | `/api/v1/guides/:guideId/variants/:variantId` | 学院变体按需加载 |
| GET | `/api/v1/search-index` | 恰 18 个顶层指南项，转专业仅一次 |

- 分类稳定值：`course-study` / `exam-grade` / `student-status-graduation` / `academic-development` / `rules-rights`（响应附 `category_label`）。
- 列表项（GuideSummary）：`id,title,summary,category,category_label,applicable_scope,updated_at,time_status,content_type,read_minutes,source_count,aliases,tags`。
- 详情新增 `sections[{id,title,body_format,body,source_ids}]`、`sources[{id,title,document_no,publisher,published_at,file_type,file_name,file_url,official_page_url,location_label}]`、`variants[{id,title,order,source_count}]`。
- 转专业概览只含校级章节 + 29 个轻量变体；学院正文走 variants 接口，学院之间内容不串用。
- `file_url` 为 R2 公网 HTTPS 直链；小程序需将 `resources.nkustudy.top` 配置为 downloadFile 合法域名。
- **旧字段 `steps/source_title/source_url` 已移除**，旧客户端（体验版）会解析不到内容——小程序端需切到新契约后再发版。

### B 批：`POST /api/v1/guide-assistant/answers`

请求（全部字段校验在模型调用前完成）：

```json
{
  "question": "课程成绩有异议，如何申请复核？",
  "history": [{ "role": "user", "content": "…" }, { "role": "assistant", "content": "…" }],
  "profile": { "admission_year": 2025, "major": "计算机科学与技术" }
}
```

- 必须携带 `Authorization: Bearer <小程序登录Token>`（30 天有效期），未登录/过期/拉黑均 401。
- `question` 1–1000 字；`history` ≤9 轮且 role 只允许 `user/assistant`（历史回答不作为事实来源，每问重新检索）；`profile` 可选；未知字段 400 `INVALID_AI_QUESTION`。
- 服务端顺序：Token 校验 → 限流 → 输入校验 → 检索 published 逐字块 → 冲突/无依据业务拒答 → 调用千问 → 返回。
- 拒答是 `200` 业务结果：`data.refused=true`，`reason ∈ INSUFFICIENT_EVIDENCE | SOURCE_CONFLICT`（自修冲突主题直接拒答），不调用模型、不编造。
- 成功响应 `data`：`answer`、`refused:false`、`reason:null`、`applicable_scope`、`freshness_notice`、`citations[]`（整份原文件级，含 R2 直链）。
- 传输错误：`400 INVALID_AI_QUESTION` / `401 AUTH_REQUIRED` / `429 RATE_LIMITED` / `503 AI_UNAVAILABLE`（30 秒总预算、provider 失败最多自动重试 1 次；未配置 Key 同样 503）。公共响应不含提示词、检索分数、内部路径或 provider 原始错误。

## 五、AI 配置管理（网页管理后台）

管理后台新增「AI 问答」标签（权限点 `ai.manage`，标签名「AI 问答」；现有持有 `services.manage` 的账号已自动迁移获得该权限）。可配置：

- 服务状态：启用 / 停用（停用=问答稳定 503，普通指南不受影响）
- DashScope API Key（密码框，留空保持不变，可一键清除；落盘 0600，界面只回显尾 4 位掩码）
- Base URL（强制阿里云 HTTPS 域名，非法值回退默认 `https://dashscope.aliyuncs.com/compatible-mode/v1`）
- 模型名（默认 `qwen-plus`）与 `max_tokens`（64–8192）
- 限流三档：每用户每日（默认 20）/ 每用户每分钟（默认 3）/ 全局每日（默认 2000），SQLite 持久化窗口

**保存即生效，无需重启**。面板内「测试连接」会用当前（或输入框中待保存的）配置真实调用一次模型并显示延迟与回复预览。环境变量 `DASHSCOPE_API_KEY` 仅作为首次种子，管理页保存后以落盘配置为准。

管理接口（`ai.manage`）：`GET /admin-api/ai-settings`（掩码读取）、`POST /admin-api/ai-settings`（保存）、`POST /admin-api/ai-settings/test`（连通测试），均有审计记录。

## 六、验收证据（生产）

- 服务器测试套件 **164 通过 / 0 失败**（新增 `learning-compass.test.mjs` 6 项、`guide-assistant.test.mjs` 7 项、`ai-provider-store.test.mjs` 5 项），`npm run check:api-docs` 95 对路由全部登记。
- 线上实测：
  - `GET /api/v1/guides` 返回 18 篇，facets 3/3/4/5/3；
  - 材料学院变体与化学学院变体内容互不相同，未知变体 404 `GUIDE_VARIANT_NOT_FOUND`；
  - R2 直链实测 DOCX（200，正确 MIME）、12MB 学生手册 PDF（200，完整大小）；
  - 问答接口无 Token 稳定 401 `AUTH_REQUIRED`；未配置 Key 稳定 503 `AI_UNAVAILABLE`。
- 部署记录：release `20260825-lca-5702780`（A 批）→ `20260825-lcb-28d6b5a`（B 批），systemd 正常，回滚按既有 release 目录切换流程。

## 七、内容更新流程（给后续维护者）

1. 小程序侧更新 `Documents/学习指南针内容草稿/` 并重新生成 `learning-compass.generated.json`；
2. 用新文件替换生产仓库 `content/learning-compass.generated.json`；
3. 运行 `node scripts/build-learning-compass-snapshot.mjs`（自动校验 5/18/29/205/35 计数，生成新快照与版本 hash）；
4. 若有新增原件：把原件按 `original_file` 相对路径放到一个目录，在生产服务器执行 `node scripts/upload-guide-sources.mjs <该目录>`（幂等，SHA-256 校验，自动设置 Content-Type）；
5. 走正常发布流程（测试 → release → systemd 切换）。

## 八、待办与边界

- [ ] 产品负责人在管理页「AI 问答」配置 DashScope API Key →「测试连接」通过后，执行 30 题真实评测，再开放小程序端入口（验收清单要求）；
- [ ] 小程序端按新契约适配（参考其仓库内 reference adapter：中文分类→稳定值、variant 按需加载、`downloadFile → openDocument`）；
- [ ] 历史会话第一阶段存小程序本机（30 天），后端不保存问答内容；
- [ ] 引用首期为整份原文件级；页码/高亮/chunk 定位按需求文档后置；
- [ ] 教通字〔2026〕18 号原件获得后，按第七节流程补入并重建快照。

## 九、安全声明

- 代码、文档、Git 中不含任何 DashScope Key、微信 AppSecret、R2 密钥、Token、OpenID 或管理员凭据；
- AI Key 只存在于服务器管理页落盘文件（0600）或服务器环境变量；Base URL 强制阿里云 HTTPS 域名；
- 公共响应经字段白名单投影：私有检索块、冲突证据、内部路径、chunk ID、提示词、检索分数零泄露（有专项测试断言）；
- 本文档未包含任何生产运维敏感信息（服务器地址、凭据、内网路径）。
