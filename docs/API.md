# NKUStudy 接口文档

本文档以当前仓库中的 `server/public-api-router.mjs`、`server/admin-server.mjs`、服务层、DTO 和网页调用代码为准，面向小程序、网站前端和后台维护人员。

- 生产站点基址：`https://nkustudy.top`
- 小程序公共 API 基址：`https://nkustudy.top/api/v1`
- 资源下载域名：`https://resources.nkustudy.top`
- 当前版本统计为 **53 个 HTTP method/path 组合**：公共 v1 11 个、网站旧公开接口 7 个、管理接口 35 个。其中 3 个旧 R2 管理接口已禁用并固定返回 `410 Gone`；该数量不是固定兼容契约。

## 接口总表

“公开”表示无需登录；“Cookie”表示必须先调用登录接口，并携带服务端签发的 `nkustudy_admin` Cookie。退出接口不要求当前 Cookie 有效。

<!-- api-route-registry:start -->
| 方法 | 路径 | 权限 | 用途 |
| --- | --- | --- | --- |
| `GET` | `/api/v1/health` | 公开 | 运行时数据健康检查 |
| `GET` | `/api/v1/home` | 公开 | 小程序首页数据 |
| `GET` | `/api/v1/search-index` | 公开 | 完整、版本化的四类搜索快照 |
| `GET` | `/api/v1/guides` | 公开 | 指南列表、分类和分页 |
| `GET` | `/api/v1/guides/:guideId` | 公开 | 指南详情、相关课程和纠错入口 |
| `GET` | `/api/v1/courses` | 公开 | 搜索、筛选和分页课程 |
| `GET` | `/api/v1/courses/:courseUid` | 公开 | 课程详情 |
| `GET` | `/api/v1/courses/:courseUid/resources` | 公开 | 课程资源与 R2 下载地址 |
| `GET` | `/api/v1/review-groups` | 公开 | 评价分组列表 |
| `GET` | `/api/v1/review-groups/:groupKey` | 公开 | 某评价分组及评价明细 |
| `POST` | `/api/v1/reviews` | 公开、限流 | 小程序提交评价 |
| `GET` | `/review-api/reviews` | 公开 | 网站读取已通过评价及规则 |
| `POST` | `/review-api/submit` | 公开、限流 | 网站提交评价 |
| `GET` | `/feedback-api/feedback` | 公开 | 网站读取公开反馈及规则 |
| `POST` | `/feedback-api/submit` | 公开、限流 | 网站提交反馈 |
| `GET` | `/visit-api/stats` | 公开 | 读取公开访问统计 |
| `POST` | `/visit-api/hit` | 公开、限流 | 记录访问 |
| `GET` | `/editor-settings` | 公开 | 读取公开编辑器工具栏配置 |
| `POST` | `/admin-api/login` | 公开、限流 | 账号+密码登录并签发 Cookie |
| `POST` | `/admin-api/logout` | 公开 | 清除管理员 Cookie |
| `POST` | `/admin-api/upload` | Cookie（需相应权限） | 上传课程文件到 R2 |
| `POST` | `/admin-api/sync-r2` | Cookie（需相应权限） | 从 R2 同步一门课程 |
| `POST` | `/admin-api/sync-r2-all` | Cookie（需相应权限） | 从 R2 重建/合并全部课程树 |
| `POST` | `/admin-api/delete-r2` | Cookie；已禁用 | 旧 R2 删除接口，固定 410 |
| `POST` | `/admin-api/delete-r2-course` | Cookie；已禁用 | 旧课程 R2 删除接口，固定 410 |
| `POST` | `/admin-api/move-r2-prefix` | Cookie；已禁用 | 旧 R2 移动接口，固定 410 |
| `POST` | `/admin-api/r2-publish` | Cookie（需相应权限） | 通过 CAS 安全发布 manifest 与 R2 变更 |
| `GET` | `/admin-api/backup` | Cookie（需相应权限） | 下载 JSON 备份 |
| `GET` | `/admin-api/backup-settings` | Cookie（需相应权限） | 读取备份设置（不返回密码） |
| `POST` | `/admin-api/backup-settings` | Cookie（需相应权限） | 更新备份设置和独立保存的密码 |
| `GET` | `/admin-api/editor-settings` | Cookie（需相应权限） | 读取编辑器设置 |
| `POST` | `/admin-api/editor-settings` | Cookie（需相应权限） | 更新编辑器设置 |
| `POST` | `/admin-api/backup-run` | Cookie（需相应权限） | 立即执行备份 |
| `POST` | `/admin-api/backup-test-webdav` | Cookie（需相应权限） | 测试 WebDAV 目标 |
| `GET` | `/admin-api/visit-stats` | Cookie（需相应权限） | 读取完整访问统计 |
| `GET` | `/admin-api/home` | Cookie（需相应权限） | 读取首页内容和 revision |
| `POST` | `/admin-api/home` | Cookie（需相应权限） | 发布首页内容 |
| `GET` | `/admin-api/footer` | Cookie（需相应权限） | 读取页脚内容和 revision |
| `POST` | `/admin-api/footer` | Cookie（需相应权限） | 发布页脚内容 |
| `GET` | `/admin-api/about` | Cookie（需相应权限） | 读取关于页内容和 revision |
| `POST` | `/admin-api/about` | Cookie（需相应权限） | 发布关于页内容 |
| `GET` | `/admin-api/participate` | Cookie（需相应权限） | 读取参与贡献页和 revision |
| `POST` | `/admin-api/participate` | Cookie（需相应权限） | 发布参与贡献页 |
| `GET` | `/admin-api/links` | Cookie（需相应权限） | 读取友链页和 revision |
| `POST` | `/admin-api/links` | Cookie（需相应权限） | 发布友链页 |
| `GET` | `/admin-api/feedback` | Cookie（需相应权限） | 读取完整反馈数据和 revision |
| `POST` | `/admin-api/feedback` | Cookie（需相应权限） | 发布反馈数据 |
| `GET` | `/admin-api/reviews` | Cookie（需相应权限） | 读取完整评价数据和 revision |
| `POST` | `/admin-api/reviews` | Cookie（需相应权限） | 以 CAS 更新评价及审核状态 |
| `GET` | `/admin-api/session` | Cookie（需相应权限） | 检查管理会话 |
| `GET` | `/admin-api/manifest` | Cookie（需相应权限） | 读取完整课程树和 revision |
| `POST` | `/admin-api/manifest` | Cookie（需相应权限） | 发布课程树并重建网站 |
| `POST` | `/admin-api/manifest-draft` | Cookie（需相应权限） | 保存课程树草稿，不重建网站 |
| `GET` | `/admin-api/accounts` | Cookie（需相应权限） | 账号列表、权限点与角色预设 |
| `POST` | `/admin-api/accounts` | Cookie（需相应权限） | 创建管理员账号 |
| `PATCH` | `/admin-api/accounts/:param` | Cookie（需相应权限） | 更新账号权限、启用状态或改密提示 |
| `POST` | `/admin-api/accounts/:param` | Cookie（需相应权限） | 重置账号密码 |
| `DELETE` | `/admin-api/accounts/:param` | Cookie（需相应权限） | 删除管理员账号 |
| `POST` | `/admin-api/me/password` | Cookie | 修改自己的密码 |
| `GET` | `/admin-api/audit` | Cookie（需相应权限） | 分页查询管理操作审计日志 |
<!-- api-route-registry:end -->

### 管理员账号与权限

管理端使用命名账号（用户名+密码，scrypt 哈希存储）登录。权限点共 8 个：
`content.read`（内容查看）、`content.edit`（内容编辑）、`content.moderate`（反馈处理）、
`storage.manage`（R2 同步）、`storage.delete`（R2 删除，已禁用的旧路由除外）、
`backup.manage`（备份管理）、`accounts.manage`（账号管理）、`audit.read`（审计查看）。
角色预设：`super_admin`（全部）、`content_admin`（查看+编辑+反馈处理）、`reviewer`（查看+反馈处理）、`viewer`（只读）。

- 首次部署会自动创建 `Shview` 超级管理员；初始密码来自一次性环境变量 `ADMIN_INITIAL_PASSWORD`，否则生成随机密码写入数据目录的 `admin-initial-password.txt`（0600），首次登录强制改密。
- 所有非 GET 管理请求、登录成功/失败都会写入审计日志；禁止停用、降级或删除最后一个持有 `accounts.manage` 的启用账号，也不能删除自己的账号。
- 账号与审计数据随备份导出（含密码哈希，不含明文）。

## 通用约定

### Content-Type 与请求大小

- 除上传外，POST 请求应发送 `Content-Type: application/json` 和 UTF-8 JSON。当前服务按正文解析 JSON，并未依赖该请求头判断格式；调用方仍应正确设置请求头。
- JSON 正文上限为 **2,000,000 字节**。无效 JSON、无效 UTF-8、请求中止返回 `400`；超限在旧接口和管理接口通常返回 `413`。公共 v1 路由会把正文读取失败统一映射为 `400 INVALID_JSON`，超限时底层还会关闭请求连接。
- `/admin-api/upload` 使用 `multipart/form-data`，限制每次最多 20 个文件、20 个 multipart part、每个文件最多 100 MiB。
- 所有服务端 JSON 响应均为 `application/json; charset=utf-8`。`GET /admin-api/backup` 额外返回 `Content-Disposition: attachment`。

### 缓存、ETag、CORS

- `/api/v1` 中除 health 外的 GET 成功响应带 `ETag`，并使用 `Cache-Control: public, max-age=60, stale-while-revalidate=300`。携带匹配的 `If-None-Match` 会返回 `304`、无正文。
- `/api/v1/health`、所有 POST、所有旧公开/管理接口均为 `Cache-Control: no-store`。
- Node 路由当前**不设置** `Access-Control-Allow-Origin`，也没有 `OPTIONS` 预检路由。浏览器代码应与站点同源；微信小程序不使用浏览器 CORS，但必须在微信公众平台配置合法 request 域名。

### 公共 v1 响应与错误

成功：

```json
{ "code": 0, "data": {} }
```

失败：

```json
{ "code": "COURSE_NOT_FOUND", "message": "课程不存在。" }
```

稳定错误码包括：

| HTTP | `code` | 含义 |
| --- | --- | --- |
| 400 | `INVALID_PATH` | 路径参数不是合法 URL 编码 |
| 400 | `INVALID_PAGINATION` | `page` 或 `page_size` 不是允许范围内的正整数 |
| 400 | `INVALID_GUIDE_CATEGORY` | 指南分类不在公开枚举中 |
| 400 | `INVALID_JSON` | 提交正文无法读取为 JSON |
| 400 | `INVALID_REVIEW` | 教师、1–5 分整数评分或最短正文等校验失败 |
| 404 | `NOT_FOUND` | v1 路由或方法不存在 |
| 404 | `COURSE_NOT_FOUND` | 课程 UID 不存在 |
| 404 | `GUIDE_NOT_FOUND` | 指南稳定 ID 不存在 |
| 404 | `REVIEW_GROUP_NOT_FOUND` | 评价分组不存在 |
| 409 | `SUBMISSION_CLOSED` | 评价提交已关闭 |
| 429 | `RATE_LIMITED` | 尝试或正式提交超过限额 |
| 500 | `INTERNAL_ERROR` | 未预期的服务端错误；不会向客户端返回内部异常文本 |

旧公开接口和管理接口使用 `{ "ok": true, ... }`；错误一般为 `{ "ok": false, "error": "..." }`，校验/发布错误也可能带 `errors`、`currentRevision`、`rolledBack`。常见 HTTP 状态是 `400`、`401`、`403`、`409`、`410`、`413`、`429`、`500`，发布状态不确定时可为 `503`。

## 公共小程序 API（`/api/v1`）

### 公共数据对象

课程对象只包含以下字段：

```json
{
  "id": "8b0d8d1a-...",
  "name": "课程名称",
  "short_name": "课程简称",
  "aliases": ["课程别名"],
  "summary": "课程摘要",
  "description": "课程摘要",
  "term": "大一下",
  "group": "通识必修课",
  "category_name": "通识必修课",
  "tags": ["数学"],
  "assessment": "绩点制",
  "teachers": ["教师姓名"],
  "teacher_groups": [
    { "id": "group-key", "group_key": "group-key", "teacher_name": "教师姓名", "teacher_name_short": "姓名", "review_count": 2 }
  ],
  "resource_count": 10,
  "review_count": 2,
  "offering_count": 1,
  "ratings": { "average": 4.5, "count": 2, "show_aggregate": true },
  "updated": "2026-08-15"
}
```

`id` 是不可变课程 UUID（manifest 的 `uid`），不是可编辑的课程名称或网站路由 `id`。`short_name` 与 `aliases` 分别只来自 manifest 的 `shortName` 和 `aliases`；空值为 `""` 和 `[]`，服务端不会猜别名。教师列表来自已通过评价的真实 `课程名 + 教师` 分组；没有评价时不会虚构教师安排。

资源对象：

```json
{
  "id": "stable-resource-hash",
  "course_id": "course-uuid",
  "course_name": "课程名称",
  "title": "2025年期末试题.pdf",
  "size": 238817,
  "size_label": "233 KB",
  "description": "期末试题",
  "section": "往年真题",
  "type": "往年真题",
  "term_label": "大一下",
  "extension": "PDF",
  "download_url": "https://resources.nkustudy.top/resources/..."
}
```

评价分组对象：

```json
{
  "group_key": "stable-group-hash",
  "course_id": "course-uuid-or-null",
  "course_name": "课程名称",
  "teacher_name": "教师姓名",
  "matched": true,
  "review_count": 2,
  "rating_average": 4.5
}
```

评价明细对象只含 `id`、`teacher_name`、`rating`、`tags`、`body`、`helpful_count`、`created_at`。

### `GET /api/v1/health`

- 参数/正文：无。
- 成功 `200`：`{ "code": 0, "data": { "status": "ok" } }`。
- 主要错误：运行时 manifest/reviews 不可用时 `500 INTERNAL_ERROR`。

```bash
curl -sS https://nkustudy.top/api/v1/health
```

### `GET /api/v1/home`

- 参数/正文：无。
- 成功 `200`：`data.announcement`、`data.hot_courses`（最多 6 个课程对象）、`data.latest_updates`（最多 8 个 `{id,title,summary,updated}`）。
- 排序：热门课程依次按评价数、资源数、中文课程名；最新更新按 `updated` 倒序。

```bash
curl -sS https://nkustudy.top/api/v1/home
```

### `GET /api/v1/search-index`

- 参数/正文：无；一次返回同一快照中的全部公开课程、教师、资料和指南索引项，不是分页候选集。
- 成功 `data`：`{version,generated_at,items,total}`。`version` 是白名单索引内容的 SHA-256 摘要截断值，内容不变则稳定；`generated_at` 是该快照所依赖的最新公开内容时间，使用带时区的 ISO 8601。
- 每项共有 `id`、`type`、`type_label`、`badge`、`name`、`short_name`、`aliases`、`tags`、`teachers`、`search_text`、`subtitle`。缺失字符串为 `""`，缺失数组为 `[]`；`type` 只可能是 `course`、`teacher`、`resource`、`guide`。
- 教师只来自已通过且能精确匹配现有课程的评价分组；相同规范化姓名合并，稳定 ID 为姓名的确定性哈希。当前没有权威教师注册表，因此无法区分同名教师，姓名修正会改变该 ID。
- 资料项额外返回 `course_id`、`course_name`、`resource_type`、`term_label`，不返回路径或下载地址；客户端跳转所属课程资料页。
- 指南项额外返回 `category`、`updated_at`。课程项的简称/别名只读取网站源数据。

```json
{
  "code": 0,
  "data": {
    "version": "stable-content-hash",
    "generated_at": "2026-08-16T04:00:00.000Z",
    "items": [{
      "id": "course-uuid",
      "type": "course",
      "type_label": "课",
      "badge": "课",
      "name": "有机化学",
      "short_name": "有机",
      "aliases": ["有机化学基础"],
      "tags": ["化学"],
      "teachers": ["教师姓名"],
      "search_text": "课程摘要 学期 类别 考核方式",
      "subtitle": "专业必修课 · 大二上"
    }],
    "total": 1
  }
}
```

### `GET /api/v1/guides`

查询参数：`category` 可为空或取 `course-selection`、`training-program`、`add-drop`、`exam-grade`；`page` 默认 1，`page_size` 默认 20、最大 100。未知分类返回 `400 INVALID_GUIDE_CATEGORY`。

成功 `data` 为 `{items,total,page,page_size,facets,data_updated_at}`；列表项只含 `id`、`title`、`summary`、`category`、`updated_at`、`applicable_scope`、`related_course_ids`。`facets.categories` 只列当前有已发布内容的分类。

### `GET /api/v1/guides/:guideId`

- `guideId` 是 `guides.json` 中由内容维护者分配、发布后不随标题变化的稳定 ID。
- 成功字段：`id`、`title`、`summary`、`category`、`updated_at`、`applicable_scope`、`steps[{title,body}]`、`related_courses[{id,name}]`、`source_title`、`source_url`、`correction_url`。
- `related_courses[].id` 必须是现有课程 UUID；URL 只允许无账号信息的公开 HTTPS 地址。
- 本阶段纠错采用公开链接方案，默认指向网站反馈页；没有新增小程序写接口或管理接口。
- 主要错误：`400 INVALID_PATH`、`404 GUIDE_NOT_FOUND`；运行时指南数据违反白名单或引用未知课程时失败关闭并返回 `500 INTERNAL_ERROR`。

### `GET /api/v1/courses`

查询参数：

| 参数 | 默认值/限制 | 语义 |
| --- | --- | --- |
| `page` | `1`；1–1,000,000 的整数 | 页码 |
| `page_size` | `20`；1–100 的整数 | 每页数量 |
| `q` | 空；规范化后最多 200 字符 | 在名称、简称、别名、摘要、term、group、assessment、标签和教师中包含匹配，不区分大小写 |
| `term` | 空；最多 120 字符 | 与服务器原值精确匹配 |
| `group` | 空；最多 120 字符 | 与服务器原值精确匹配 |
| `tag` | 空；最多 120 字符 | 必须包含该服务器标签 |
| `assessment` | 空；最多 120 字符 | 与服务器原值精确匹配 |

未知查询参数被忽略。成功 `data`：

```json
{
  "items": [],
  "total": 0,
  "page": 1,
  "page_size": 20,
  "facets": { "groups": [], "terms": [], "tags": [], "assessments": [] }
}
```

筛选值和 facets 直接复用网站数据；没有学年、校区、`category`、`sort` 字段。

```bash
curl -G -sS https://nkustudy.top/api/v1/courses \
  --data-urlencode 'q=概率论' \
  --data-urlencode 'group=通识必修课' \
  --data-urlencode 'page=1' \
  --data-urlencode 'page_size=20'
```

### `GET /api/v1/courses/:courseUid`

- 路径参数 `courseUid`：课程不可变 UUID，需 URL 编码。
- 成功 `200`：`data` 为课程对象。
- 主要错误：`400 INVALID_PATH`、`404 COURSE_NOT_FOUND`。

```bash
curl -sS 'https://nkustudy.top/api/v1/courses/<COURSE_UID>'
```

### `GET /api/v1/courses/:courseUid/resources`

- 路径参数同上。
- 成功 `200`：`{ "code":0, "data": { "course_id":"...", "items":[], "total":0 } }`。
- `.openlist` 占位文件不返回。
- `download_url` 是经来源与路径校验后生成的 R2 公网 URL；下载**不经过 Node 代理**。小程序需把 `https://resources.nkustudy.top` 配为合法 `downloadFile` 域名。
- 主要错误：`400 INVALID_PATH`、`404 COURSE_NOT_FOUND`、资源根配置异常时 `500 INTERNAL_ERROR`。

```bash
curl -sS 'https://nkustudy.top/api/v1/courses/<COURSE_UID>/resources'
```

### `GET /api/v1/review-groups`

- 参数/正文：无。
- 成功 `200`：`data.items` 为评价分组对象，`data.total` 为分组数；列表不含评价明细。
- 只处理状态为 `approved`/`通过` 且未隐藏的评价。

```bash
curl -sS https://nkustudy.top/api/v1/review-groups
```

### `GET /api/v1/review-groups/:groupKey`

- 路径参数 `groupKey`：由精确 trim 后的 `courseTitle + NUL + teacher` 做 SHA-256 并截取 24 位 base64url 得到，不应由客户端猜测；从列表响应读取。
- 成功 `200`：评价分组对象，并增加 `items` 评价明细数组。
- 历史评价未精确匹配现有课程时仍保留：`matched:false`、`course_id:null`。
- 主要错误：`400 INVALID_PATH`、`404 REVIEW_GROUP_NOT_FOUND`。

```bash
curl -sS 'https://nkustudy.top/api/v1/review-groups/<GROUP_KEY>'
```

### `POST /api/v1/reviews`

请求 JSON：

```json
{
  "course_id": "course-uuid",
  "teacher": "教师姓名",
  "rating": 5,
  "tags": ["讲解清晰"],
  "body": "评价正文",
  "website": ""
}
```

- `course_id` 必须存在；`teacher` 最多 80 字符；`rating` 必须为 1–5 的整数；`body` 最多 2000 字符且长度不小于当前服务端 `rules.minLength`；tags 去重后最多 12 个、每项最多 40 字符。
- `website` 是反机器人蜜罐字段，应留空。非空时服务端返回成功但不写评价。
- 成功 `200`：`{ "code":0, "data": { "submitted":true, "pending":true } }`；是否待审核由网站的同一份评价规则决定。
- 限流：先按 IP 统计尝试，每分钟 30 次、全局每分钟 1000 次；有效提交再按规则的 `hourlyLimit`、`dailyLimit` 持久化限流，默认分别为 3、10。
- 小程序和网站共用同一评价写入服务、审核队列和 `reviews.json`，不会产生第二套评价数据。

```bash
curl -sS https://nkustudy.top/api/v1/reviews \
  -H 'Content-Type: application/json' \
  --data '{"course_id":"<COURSE_UID>","teacher":"张老师","rating":5,"tags":["讲解清晰"],"body":"课程内容充实，复习建议具体。","website":""}'
```

## 网站旧公开接口

这些接口继续服务现有 Astro 网站。新小程序优先使用 `/api/v1`。

### `GET /review-api/reviews`

- 成功：`{ "ok":true, "reviews":[...], "rules":{...} }`。
- `reviews` 只含已通过且未隐藏的记录，并移除 `ipHash`、`userAgent`；保留网站所需的 `courseTitle`、`teacher`、`rating`、`tags`、`content`、状态和时间字段。
- `rules` 是当前评价规则，含开关、审核要求、限流值、最短长度、公告和备注。

```bash
curl -sS https://nkustudy.top/review-api/reviews
```

### `POST /review-api/submit`

请求：`{courseTitle, teacher, rating, tags?, content, website?}`。字段长度、审核、蜜罐和限流与 v1 评价提交共用同一服务；这里直接按课程标题写入，因此允许提交尚未匹配 manifest 的历史/新课程标题。

成功：`{ "ok":true, "pending":true }`。主要错误：`400` 无效评价/JSON、`409` 关闭提交、`429` 限流、`413` 正文超限。

```bash
curl -sS https://nkustudy.top/review-api/submit \
  -H 'Content-Type: application/json' \
  --data '{"courseTitle":"概率论","teacher":"张老师","rating":5,"content":"评价正文至少达到管理员设置的最短长度。","website":""}'
```

### `GET /feedback-api/feedback`

成功：

```json
{
  "ok": true,
  "title": "问题与建议",
  "announcement": "",
  "rules": { "submissionOpen": true, "minLength": 5 },
  "items": []
}
```

只返回未隐藏条目；每项移除 `ipHash`、`userAgent`、`contact`。

```bash
curl -sS https://nkustudy.top/feedback-api/feedback
```

### `POST /feedback-api/submit`

请求：`{type?, title, content, contact?, website?}`。`type` 最多 40 字符，空值默认为 `bug`；标题最多 120 字符；正文最多 2000 字符且达到规则最短长度；联系方式最多 120 字符。`website` 为蜜罐，应留空。

成功：`{ "ok":true }`。主要错误：`400` 校验/JSON、`403` 提交关闭、`429` 限流、`413` 正文超限。尝试限流为每 IP 每分钟 30、全局每分钟 1000；有效提交默认每小时 3、每天 15，可由后台规则调整。

```bash
curl -sS https://nkustudy.top/feedback-api/submit \
  -H 'Content-Type: application/json' \
  --data '{"type":"bug","title":"页面问题","content":"这里描述可复现的问题。","contact":"","website":""}'
```

### `GET /visit-api/stats`

成功：`{ "ok":true, "stats": { "total":0, "today":0, "updatedAt":"..." } }`。

```bash
curl -sS https://nkustudy.top/visit-api/stats
```

### `POST /visit-api/hit`

请求：`{ "path":"/courses/某课程" }`；缺省时使用 Referer 或 `/`。服务端只记录固定页面、课程详情模板、评价详情模板或 `/__unknown__`，不记录任意原始 URL；后台和 API 路径不计数。同一 IP+User-Agent 30 分钟内去重。

成功：`{ "ok":true, "stats": { "counted":true, "total":1, "today":1, "updatedAt":"..." } }`。限流为每 IP 每分钟 120、全局每分钟 600，超限返回 `429`。

```bash
curl -sS https://nkustudy.top/visit-api/hit \
  -H 'Content-Type: application/json' \
  --data '{"path":"/courses"}'
```

### `GET /editor-settings`

成功：`{ "ok":true, "data": { "version":1, "updated":"YYYY-MM-DD", "user":{"toolbar":[]}, "admin":{"toolbar":[]} } }`。这是公开的工具栏名称配置，不含密码或管理凭据。

```bash
curl -sS https://nkustudy.top/editor-settings
```

## 管理接口认证

管理端使用**命名账号**（用户名+密码）登录；密码以 scrypt 哈希存储在服务器 SQLite 中，权限点见上文「管理员账号与权限」。Cookie 签名密钥从仅服务器可读的 `ADMIN_SECRET_FILE` 加载。密钥不是 API 参数，不应进入网页、小程序、curl 历史或 Git。当前实现**没有**自定义 secret header。

首次部署且账号表为空时，自动创建超管 `Shview`：优先使用一次性环境变量 `ADMIN_INITIAL_PASSWORD`（≥10 位），否则生成随机密码写入数据目录 `admin-initial-password.txt`（0600，仅 root/服务账号可读）；该账号首次登录强制改密。旧的共享 `ADMIN_PASSWORD` 登录方式已移除。

### 登录、Cookie 与退出

`POST /admin-api/login` 请求 `{ "username":"...", "password":"..." }`。成功返回 `{ "ok":true, "data":{ "username":"...", "permissions":[...], "mustChangePassword":false } }`，并设置：

```text
Set-Cookie: nkustudy_admin=<signed-token>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800
```

错误：密码错误 `403`；每 IP 5 分钟 5 次、全局 5 分钟 60 次后 `429`；无效/过大 JSON 为 `400`/`413`。

`POST /admin-api/logout` 无需有效会话，返回 `{ "ok":true }` 并以 `Max-Age=0` 清除 Cookie。

建议用 cookie jar，避免复制 token：

```bash
umask 077
read -r -s -p 'Admin password: ' ADMIN_PASSWORD_INPUT; printf '\n'
printf '%s' "$ADMIN_PASSWORD_INPUT" \
  | node -e 'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({username:"Shview",password:s})))' \
  | curl -sS -c admin.cookies https://nkustudy.top/admin-api/login \
      -H 'Content-Type: application/json' \
      --data-binary @-
unset ADMIN_PASSWORD_INPUT

curl -sS -b admin.cookies https://nkustudy.top/admin-api/session
curl -sS -b admin.cookies -c admin.cookies -X POST https://nkustudy.top/admin-api/logout --data '{}'
```

除 login/logout 外，所有 `/admin-api/*` 均要求请求头携带登录所得 Cookie；缺失、签名无效或账号已停用返回 `401 {"ok":false,"error":"Unauthorized"}`。`GET /admin-api/session` 成功返回 `{ "ok":true, "data":{ "username":"...", "permissions":[...], "mustChangePassword":false } }`。缺少对应权限点的写操作返回 `403`，并计入审计日志。

## 管理接口：课程树与 R2

### Manifest 数据与 CAS

`GET /admin-api/manifest` 返回：

```json
{ "ok":true, "manifest": { "resourceRoot":"...", "courses":[] }, "revision":"sha256-revision" }
```

课程至少需要 `uid`、`id`、`term`、`group`、`title`、`updated`、`basePath`、`sections`。section 至少需要 `title`、`files`；file 至少需要 `title`、`path`。完整替换规则：

- 已有课程必须保留原 `uid`；新课程省略 `uid`，由服务端分配 UUID。
- `deletedCourseUids` 必须与实际删除的 UID 集合完全一致。
- 同一请求不能同时删除已有课程又新增无 UID 课程。
- `basePath` 必须是安全相对路径并以一个 `/` 结尾；file path 必须是安全相对路径。课程路径不得相互重叠，文件公开 key 不得冲突。
- 所有写接口均应使用刚从 GET 返回的 `expectedRevision`。过期 revision 返回 `409` 和 `currentRevision`，不会覆盖他人的变更。

### `POST /admin-api/manifest`

请求：

```json
{ "manifest": {}, "expectedRevision":"...", "deletedCourseUids":[] }
```

成功：`{ok:true, manifest, revision, backup?}`，保存 JSON、执行内容校验和 Astro 构建，再原子切换网站发布目录。已有课程 `basePath` 变化会被拒绝，必须改用 `r2-publish`。主要错误：`400` 缺 revision/删除声明/manifest 校验/不允许的路径变更，`409` CAS 冲突，构建/发布失败通常 `400` 或 `500` 并返回 `rolledBack:true`；发布证明状态不明确时可能 `503`。

```bash
curl -sS -b admin.cookies https://nkustudy.top/admin-api/manifest > manifest-response.json
# 编辑时应从响应中分别取出 manifest 和 revision，并准确计算 deletedCourseUids。
curl -sS -b admin.cookies https://nkustudy.top/admin-api/manifest \
  -H 'Content-Type: application/json' \
  --data @manifest-write-body.json
```

### `POST /admin-api/manifest-draft`

请求字段与 manifest 发布相同。成功同为 `{ok:true,manifest,revision,backup?}`，但只保存/校验草稿，不执行 Astro 构建和网站切换。前端在上传文件前用它固化课程和 section。错误规则与 manifest 相同，且不允许已有课程 `basePath` 变化。

### `POST /admin-api/upload`

- 查询参数：`courseId` 为网站 manifest 的可编辑 `course.id`（不是 UUID）；`sectionIndex` 是从 0 开始的 section 下标。
- 正文：`multipart/form-data`；网页使用重复的 `files` 字段。服务端实际接收任意 file part 名称。
- 成功：`{ "ok":true, "files":[{"title":"...","path":"...","size":1,"description":""}] }`。
- 上传直接写入该课程/section 的 R2 前缀，**不会自动更新 manifest**；调用方须把返回的 file 对象并入当前课程树后再发布。
- 错误：课程/section 不存在或 R2 未配置 `400`，文件/数量超限 `413`，R2/解析异常 `500`。

```bash
curl -sS -b admin.cookies -X POST \
  'https://nkustudy.top/admin-api/upload?courseId=<WEBSITE_COURSE_ID>&sectionIndex=0' \
  -F 'files=@./example.pdf'
```

### `POST /admin-api/sync-r2`

请求：`{ "courseId":"<website-course-id>", "expectedRevision":"..." }`。按当前课程 `basePath` 列出 R2，合并资源并保留已有说明字段，然后发布网站。成功：`{ok:true,manifest,revision,course}`。主要错误：缺 revision `400`、课程/R2 不存在 `500`、CAS 或同步期间路径变化 `409`。

### `POST /admin-api/sync-r2-all`

请求：`{ "expectedRevision":"..." }`。扫描当前 R2 `resources/` 树，合并已有课程并新增发现的课程，发布网站。成功：`{ok:true,manifest,revision,report}`；`report` 含 merge 统计、`unmatched` 和 `conflicts`。该操作不是“用本地旧 manifest 整份覆盖服务器”。缺 revision `400`、CAS 冲突 `409`、R2/构建异常 `500`。

```bash
curl -sS -b admin.cookies https://nkustudy.top/admin-api/sync-r2-all \
  -H 'Content-Type: application/json' \
  --data '{"expectedRevision":"<REVISION>"}'
```

### `POST /admin-api/r2-publish`

用于课程目录移动、资源删除、整课删除等破坏性 R2 变更。请求：

```json
{
  "manifest": {},
  "expectedRevision": "...",
  "deletedCourseUids": [],
  "moves": [
    { "courseUid":"...", "oldBasePath":"大一/分类/旧名", "newBasePath":"大一/分类/新名" }
  ],
  "fileDeletes": [
    { "courseUid":"...", "paths":["往年真题/a.pdf"] }
  ]
}
```

每个实际目录变化、文件删除和课程删除都必须一一精确声明；目标前缀必须为空且不得重叠。服务端先复制并核验目标对象，再 CAS 发布 manifest，最后删除精确旧 key。成功包含 manifest 发布结果，以及 `copied`、`deleted`、`extraSourceObjects`、`unmovedSourceKeys`、`cleanupWarnings` 等事务报告。主要错误：声明或路径不合法 `400`，revision 冲突、目标已存在、源对象缺失或验证失败 `409`，R2/发布错误 `500`。

### 已禁用的旧 R2 接口

以下三个 POST 在通过管理认证后固定返回 `410`，正文被丢弃：

- `/admin-api/delete-r2`
- `/admin-api/delete-r2-course`
- `/admin-api/move-r2-prefix`

响应：`{"ok":false,"error":"Unsafe legacy R2 mutation route is disabled; use /admin-api/r2-publish with manifest CAS."}`。不得作为可用兼容接口调用。

## 管理接口：网站内容和审核

### 通用内容发布协议

以下 GET 均返回 `{ok:true,data,revision}`；对应 POST 均接收 `{data,expectedRevision}`，成功返回 `{ok:true,data,revision}`，保存后执行 Astro 构建和网站原子发布：

| GET/POST 路径 | `data` 结构 |
| --- | --- |
| `/admin-api/home` | `{announcement}`，最多 2000 字符 |
| `/admin-api/footer` | `{enabled,showVisitCount,useRealVisitCount,visitCount,startedAt,copyrightText,copyrightYear,maintainers:[{label,url}]}` |
| `/admin-api/about` | `{title,content}`，分别最多 120/6000 字符 |
| `/admin-api/participate` | `{title,content}`，分别最多 120/8000 字符 |
| `/admin-api/links` | `{title,intro,mutualTitle,recommendedTitle,siteInfoTitle,siteInfo:{name,url,description},links:[{id,type,name,url,description,hidden}]}`；type 仅 `mutual`/`recommended` |
| `/admin-api/feedback` | 完整反馈 store：`{version,updated,title,announcement,rules,items}` |

主要错误：缺/过期 revision 分别为 `400`/`409`；构建失败会回滚内容并可能返回 `rolledBack:true`；发布状态不明确时可能 `503`。静态目录已切换但 fsync 或旧 release 清理降级时，成功响应保持原有字段并附加 `warnings: string[]`；管理页面会显示这些警告，调用方也应记录并安排运维核查。示例：

```bash
curl -sS -b admin.cookies https://nkustudy.top/admin-api/about
curl -sS -b admin.cookies https://nkustudy.top/admin-api/about \
  -H 'Content-Type: application/json' \
  --data '{"data":{"title":"NKUStudy","content":"关于内容"},"expectedRevision":"<REVISION>"}'
```

### `GET/POST /admin-api/reviews`

GET 返回 `{ok:true,data,revision}`，其中 `data` 是完整 `{version,updated,rules,reviews}`，包含审核所需的 pending/hidden 和内部审计字段，故只允许管理 Cookie 使用。

POST 请求 `{data,expectedRevision}`。服务端只合并 `data.rules`，并在 `data.reviews` 为数组时整表替换评价数组；使用同文件 CAS，防止覆盖同时到达的公开投稿。成功 `{ok:true,data,revision}`，缺 revision `400`，冲突 `409`。

### `GET/POST /admin-api/editor-settings`

GET 返回 `{ok:true,data}`，POST 接收 `{data}` 并返回 `{ok:true,data}`；此接口当前**没有 revision/CAS**。`data.user.toolbar` 和 `data.admin.toolbar` 只保留服务端允许的 Vditor 工具名。公开 `/editor-settings` 返回同一已清洗结构。

### `GET /admin-api/visit-stats`

返回 `{ok:true,stats,summary}`。`summary` 仅为公开 total/today/updatedAt；`stats` 是完整的版本、总量、按天、按页面和哈希访客记录。仅管理接口可读取完整记录。服务端最多保留 400 天和 5000 个活跃访客条目。

## 管理接口：备份

### `GET /admin-api/backup`

查询参数 `scope` 默认 `all`，允许 `all`、`manifest`、`reviews`、`feedback`、`pages`、`stats`、`config`。未知值返回 `400`。成功下载文件 `nkustudy-<scope>-backup-YYYY-MM-DD.json`，顶层含 `ok`、`scope`、`createdAt`、无敏感值的 `config`，并按 scope 包含相应数据。管理员密码和 R2 secret 不会进入此下载。

```bash
curl -sS -b admin.cookies -OJ 'https://nkustudy.top/admin-api/backup?scope=manifest'
```

### `GET/POST /admin-api/backup-settings`

GET 返回 `{ok:true,data}`。公开设置字段：

```json
{
  "version": 1,
  "updated": "YYYY-MM-DD",
  "autoEnabled": true,
  "dailyTime": "03:20",
  "r2DataBackup": true,
  "r2BackupPrefix": "backups/site-data",
  "webdavEnabled": false,
  "includeSiteData": true,
  "includeServerConfig": true,
  "includeCourseFiles": true,
  "encryptionPasswordConfigured": false,
  "destinations": [
    { "id":"...", "name":"WebDAV", "url":"https://...", "username":"...", "enabled":true, "passwordConfigured":false }
  ]
}
```

POST 接收 `{data}`。destination 可附带只写字段 `password`、`clearPassword`；顶层可附带 `encryptionPassword`、`clearEncryptionPassword`。密码存入独立的服务器 secret 文件，响应只返回 `*Configured` 布尔值。不要记录或回显密码。成功 `{ok:true,data}`；此接口当前没有 revision/CAS，但服务器串行保存设置。

### `POST /admin-api/backup-test-webdav`

请求 `{destination:{id?,url,username?,password?}}`。服务器对目标根目录执行 15 秒超时的 `PROPFIND`，若返回 405 则改用 `HEAD`；200/207/301/302 视为成功。响应 `{ok,status,statusText,message}`，当 `ok:false` 时 HTTP 为 `400`。缺 URL 或网络异常由统一错误处理返回 `500`。

### `POST /admin-api/backup-run`

正文可为 `{}`。成功返回备份报告：`{ok:true,manual:true,startedAt,finishedAt,r2:[],webdav:[],warnings:[]}`；每个 WebDAV 报告含 `id,name,uploaded,skipped,errors`。已有任务运行时返回 `409 {ok:false,error:"Backup is already running."}`；R2/WebDAV 异常可能返回 `500`。

```bash
curl -sS -b admin.cookies -X POST https://nkustudy.top/admin-api/backup-run \
  -H 'Content-Type: application/json' --data '{}'
```

## 字段白名单和隐私边界

公共 v1 DTO 逐字段构造，不直接展开 manifest、评价或反馈原始记录。公共接口不会暴露：

- `basePath`、文件相对 `path`、manifest `resourceRoot`、`source`、`repository`、本机/Windows 路径；
- R2 账号、bucket secret、管理密码、签名密钥、备份密码；
- contributors/管理元数据、审核标记、IP/actor hash、User-Agent、反馈联系方式；
- 管理接口、内部 revision、备份或发布路径。

标签、term、group（例如“通识选修课”）、assessment 和评价内容直接来自服务器；manifest/课程的 `hiddenMetaTags` 和服务端禁止展示项会从公开 facets/标签中过滤。资源仅返回已校验的 HTTPS `download_url`，不返回内部拼接字段。

## 当前明确未开放的接口

下列接口在当前版本中未注册，调用返回 `404`，其他开发者不得依赖或自行假设兼容行为：

- 微信登录和个人信息：`/api/v1/auth/wechat`、`/api/v1/auth/phone`、`/api/v1/auth/logout`、`/api/v1/me`；
- 收藏：`/api/v1/favorites` 及删除收藏；
- 投稿和举报：`/api/v1/resource-submissions`、`/api/v1/resource-submissions/mine`、`/api/v1/reports`、`/api/v1/resources/:id/reports`；
- 旧客户端设想的 `/api/v1/resources/:id`、`/api/v1/courses/:id/reviews`；
- `/api/v1` 下任何管理接口。

浏览课程、资料和公开评价不需要登录。管理工作继续只通过网页端 `/admin-api/*`，不会暴露给小程序。

## 文档一致性检查

路由变更后运行：

```bash
npm run check:api-docs
```

脚本会按测试覆盖的路由写法，从当前公共和管理 router 提取直接路径比较、路径数组及受支持的动态正则路由，并与本页“接口总表”双向比较。它能发现这些受支持写法中的接口增删漂移，但不是通用 JavaScript 路由分析器；采用新的注册写法时必须先扩展提取器测试。字段、权限、状态码和业务语义仍应同步检查服务层、DTO、集成测试与前端调用。
