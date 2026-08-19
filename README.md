# NKUStudy · 南开课程资料导航

<div align="center">

**[https://nkustudy.top](https://nkustudy.top)** · 学生共建，非南开大学官方平台

网站 · 管理后台 · 小程序公共 API · R2 资源分发

</div>

---

> 生产内容、评价、反馈、凭据、备份、SQLite 数据库与课程资源文件一律不入 Git；
> 网站管理后台是唯一的内容管理入口；小程序 API 只暴露公共/用户操作，永不暴露 `/admin-api/*`。

## 这是什么

NKUStudy 是面向南开学生的课程资料导航与选课参考平台，整合课程信息、学习资料、课程与教师评价：

- **公开网站**（Astro 静态站）：课程库、资料下载、评价浏览、选课指南——免登录直接用
- **管理后台**（`/admin/`）：课程资源管理、评价/反馈审核、内容发布——多账号 + 权限分级 + 操作审计
- **微信小程序公共 API**（`/api/v1`）：微信身份登录、收藏、评价提交——配套小程序仓库 [mzk-C4/NKU-study-wxapp](https://github.com/mzk-C4/NKU-study-wxapp)
- **资源分发**：课程文件存 Cloudflare R2，经 `resources.nkustudy.top`（Cloudflare CDN）下载

数据基线：68+ 门课程、840+ 份资料、71+ 条评价，持续更新。

## 架构

```
访客/小程序
   │ HTTPS
   ▼
Caddy（TLS / 反代 / HTTP→HTTPS）
   ├─ 静态站 ──────────► /var/www/nkustudy-publish（原子发布的多版本 release）
   └─ 动态服务 ────────► Node 22 · server/admin-server.mjs（仅监听 127.0.0.1:8787）
        ├─ /api/v1/*        小程序公共 API（缓存 + ETag + 限流）
        ├─ /review-api/* 等 网站公开读写（评价/反馈/访问统计）
        └─ /admin-api/*     管理接口（Cookie 会话 + CSRF 源校验 + 权限点）
   存储
    ├─ 运行数据 JSON（课程 manifest/评价/反馈/页面内容）─ /var/lib/nkustudy/json
    ├─ SQLite（会话/限流/小程序用户/收藏/审计）─────── /var/lib/nkustudy/miniprogram.sqlite
    └─ Cloudflare R2（课程文件 + JSON 备份 + 审计归档）
```

- **发布模型**：每个版本部署到独立 release 目录（`/opt/nkustudy-releases/<日期-提交>`），systemd 工作目录原子切换，保留全部历史可回滚；静态站同样按 release 发布、软链切换
- **内容变更**：管理端保存 → JSON 原子写入 → 触发 Astro 重新构建 → 静态 release 原子上线（带发布日志与崩溃恢复）
- **R2 变更**：走 manifest CAS（乐观锁）+ 复制后校验 + 事务清理的保守事务模型

## 管理后台能力

- **多账号权限**：账号+密码（scrypt），8 权限点（内容查看/编辑/反馈处理、R2 同步/删除、备份、账号管理、审计查看）× 4 角色预设（super_admin / content_admin / reviewer / viewer）；末位超管保护、会话 8h 绝对过期 + 30min 空闲过期
- **审计日志**：所有写操作与登录成败入审计（到秒、动作中文化）；超 2 万条按批归档至 R2
- **审核效率**：评价按课程侧边栏审核、批量通过/隐藏、待审数角标、关键词过滤（默认关闭，命中联系方式/敏感词强制待审）
- **飞书通知**：多机器人（独立 webhook+签名+用途），新评价/新反馈实时卡片，每日汇总（可选启用），单机定向测试
- **小程序用户管理**：列表/搜索/排序、登录统计、黑名单（封禁即无法登录、会话即时失效）
- **访问统计**：7/30/90 天折线图（鼠标追踪悬浮）、按类别汇总（网页/小程序）、页面明细（解码课程名）、访客 IP（30 分钟去重）
- **备份**：每日自动 + 手动，R2 与 WebDAV 双通道（站点数据/服务器配置/课程文件），恢复步骤经过实际演练验证

## 公共 API 概览（完整契约见 [docs/API.md](docs/API.md)）

| 分类 | 端点 |
|---|---|
| 课程/资料 | `GET /api/v1/home` · `courses` · `courses/{id}` · `courses/{id}/resources` · `search-index` · `guides` |
| 评价 | `GET /api/v1/review-groups[/{key}]` · `POST /api/v1/reviews`（先审后显） |
| 登录 | `POST /api/v1/auth/wechat`（wx.login code → 30 天 Bearer token）· `me` · `me/profile` · `auth/logout` |
| 个人 | `GET /me/favorites` · `POST/DELETE /favorites` · `GET /me/reviews` |

统一响应 `{code, message, data}` + 分页字段；GET 带 ETag/304；AppSecret 仅存服务器环境变量，openid 永不下发客户端。

## 仓库结构

```
server/          Node 服务（admin-server + 各服务模块：账号/会话/审计/认证/收藏/通知/限流/发布…）
src/             Astro 站点（页面/组件/样式）+ admin.astro 管理界面
scripts/         校验/构建/迁移/冒烟脚本（含 API 文档一致性检查）
docs/            API.md（74 对路由契约）· DEPLOYMENT.md · data-schema.md · public-api.md · mp-visit-reporting.md
test/            137 项测试（单元 + 全链路集成，含 mock code2Session）
```

## 开发

```bash
npm ci                 # 安装依赖
npm test               # 137 项测试（Node 内置 test runner）
npm run build:fixtures # 用固定数据构建验证（本地无需生产数据）
npm run check:api-docs # API 文档与路由注册一致性检查
npm run dev            # Astro 开发服务器
```

- 生产环境受 fail-closed 预检保护（`DATA_DIR` 0700+哨兵、密钥 0600、`PUBLIC_DIR` 受管软链），本地开发自动放宽
- **永远不要**把本地 `src/data` 覆盖到生产；生产数据只经管理后台或迁移脚本变更（见 `docs/data-schema.md`）
- 提交前跑 `npm test`；CI（GitHub Actions）执行同一套检查

## 部署要点（详见 docs/DEPLOYMENT.md）

```bash
# 摘要：打包提交 → 服务器解压到 /opt/nkustudy-releases/<date-hash> → npm ci → npm test
# → 切换 systemd WorkingDirectory → restart → 管理端发布触发静态重建
```

关键环境变量：`DATA_DIR` `STATE_DB_PATH` `ADMIN_SECRET_FILE` `ADMIN_ORIGIN`（必填）、`WECHAT_APPID/WECHAT_APPSECRET`（小程序登录）、`R2_*`（资源与备份）、`TRUSTED_PROXIES`（生产必填，仅信任本机反代）。

## 安全基线（2026-08 渗透测试通过）

16 类攻击向量实测拦截：认证绕过 / Cookie 伪造 / CSRF 源伪造 / 方法欺骗 / 路径混淆 / XFF 限流绕过 / 暴力破解（5 次/IP/5min，验密前生效）；登录时序等化防用户名枚举；会话令牌 256 位随机 HMAC 存库。报告见团队内部存档。

## 相关仓库

- 小程序：[mzk-C4/NKU-study-wxapp](https://github.com/mzk-C4/NKU-study-wxapp)（原生微信小程序，对接本仓库 `/api/v1`）

## 声明

学生共建项目，非南开大学官方平台；内容仅供参考，选课与考核信息请以教务系统为准。
