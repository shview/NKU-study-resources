# S1 身份认证与注册留存：修复与验收

- 日期：2026-09-29；执行任务：`01a0eca8-6fd2-7511-80a8-4d2655182b28`。
- 实际仓库：`NKU-study-resources`；分支 `codex/fresh-start-20260928`；基于 `d219f37f1df5f2e43c640134e3a3697e80b85312`，本次修改**未提交**。
- 开始时仅有未提交的 `docs/compliance/`；保留任务书 v1.1 决策及协调任务追加的 E-20260929-001。未使用外层空 Git 仓库。
- **结论：S1 本地可验子范围通过；真实微信/小程序、实际部署仍未验证，不能宣称网站真实认证全链路或 S1 整体无条件通过。验收后停止，等待协调任务确认，不启动 S2。**

## 1. 第一步：修复

修复依据是服务端身份、认证状态和数据归属，而非前端显示的登录状态或请求体里的 `user_id`、`phone_verified`。

| 边界 | 修改及理由 | 当前定位 |
|---|---|---|
| Cookie/Bearer | 共用会话提取和公开投稿门禁；显式 Authorization 优先，坏 Bearer 不回落好 Cookie；会话有效、手机号认证、未封禁均由服务端检查 | `server/user-identity.mjs:6,13`；`server/admin-server.mjs:960`；`server/public-api-router.mjs:348` |
| 认证结果 | 手机号只使用服务端微信响应；校验号码类型/格式、HTTP 失败和可用的 appid 水印；加请求超时、拒绝重定向；登录上游错误即使夹带 openid 也不能成功 | `server/wechat-phone.mjs`；`server/mp-auth-service.mjs:194` |
| 一次性授权 | SQLite 仅存 code 的 SHA-256 摘要；请求上游前原子占用，跨账号及重启重放返回 409；包括上游失败也需重新授权。24 小时清理摘要是本地防重放窗口，超过窗口仍由微信校验一次性 code，不能以本地摘要过期证明微信 code 仍有效 | `server/mp-auth-service.mjs:178`；`server/public-api-router.mjs:148` |
| 认证期间失效 | 微信请求返回后重新验证会话，写手机号时再检查封禁，避免等待期间被撤销/封禁仍完成认证 | `server/public-api-router.mjs:164`；`server/mp-auth-service.mjs:355` |
| DTO/缓存 | 本人账号复用白名单 DTO；旧公共评价/反馈改白名单；本人 GET、二维码状态、订单状态及携带用户凭证的 GET 使用 no-store。匿名公开课程继续 ETag/public 缓存 | `server/user-identity.mjs:26`；`server/admin-server.mjs:1436`；`server/public-api-router.mjs:146,368` |
| 身份事件 | 注册、密码/微信登录、会话恢复、手机认证、扫码确认/签发记录结果、稳定错误码/HTTP 状态；能识别目标账号时写用户 ID，否则 NULL；不记录密码、code、token、手机号或微信 errmsg | `server/public-api-router.mjs:65,373`；复用 `user-security-log-store.mjs`，未改留存机制 |
| 旧 SQLite | 对历史 `openid TEXT NOT NULL UNIQUE` 建 SQLite 一致性快照，再事务重建为 nullable；保留原列、ID、openid、索引/触发器、会话和自增高水位；外键检查失败回滚，未知约束结构明确拒绝自动迁移；不自动认证历史账号 | `server/mp-auth-service.mjs:121,150` |
| 私密投诉身份分流 | `report`/`complaint` 可匿名，归属 NULL；有有效会话时归属本人，提供无效/封禁凭证仍拒绝。普通投稿开关和指南反馈开关不吞投诉；保留长度校验、蜜罐、分层频控和提交频控 | `server/admin-server.mjs:1483` |
| 分流必需的最小隐私保护 | 新投诉由服务端写 `private: true`；公共列表排除该标记；后台全量保存时在原子更新内按原条目 ID 保留标记，不能通过改类型/删除标记把新投诉变公开。这是安全开放匿名受理的必要配套；没有做历史全量私密迁移、审核模型或前端重做 | `server/admin-server.mjs:1454,1553,2297`；`server/content-publish-service.mjs:133,152` |
| 网页提示 | 本人页展示手机号认证状态，说明需小程序授权且网页没有授权/短信入口；不伪造短信或声称小程序已可用 | `src/pages/me.astro:142` |

注销数据动作和 D-01 未修改。管理员查询、导出及权限分工未修改，继续服从 C-08。

## 2. 第二步：实际验收

新增 [真实 HTTP 验收测试](../../test/s1-identity.integration.test.mjs)。两套合成旧库各启动实际 `admin-server.mjs`，真实 HTTP 请求、真实 SQLite/JSON 读回，并两次重启（第二次清空微信配置）。只有微信上游使用本地 HTTP 合成服务；未替换认证服务、路由或数据库。每套 111 次受断言检查的 HTTP 请求，共 222 次。

证据：[nullable 请求/日志](evidence/S1/http-nullable.json)、[NOT NULL 请求/日志](evidence/S1/http-not-null.json)、[专项测试输出](evidence/S1/s1-http-test.log)。证据只包含合成数据；响应只留状态、缓存和稳定错误码，未保存 Cookie/token/密码。

| 验收项 | 预期 | 实际、读回证据 | 结论 |
|---|---|---|---|
| 匿名公开浏览 | 可读公开课程和评价 | `/api/v1/courses`、`/review-api/reviews`、`/api/v1/review-groups` 200；匿名课程保持 public 缓存；原路由测试验证 ETag/304 | 通过 |
| 匿名公开写 | 三个入口均拒绝 | `/review-api/submit`、`/api/v1/reviews`、`/feedback-api/submit` 普通反馈均 401；伪造认证状态不起作用 | 通过 |
| 已登录未认证 | Cookie/Bearer 均 403 | 两种凭证逐入口执行；注册请求塞入 phone/phone_verified 后 SQLite 仍为未认证 | 通过 |
| 已认证投稿 | 两种凭证可成功、归属由服务器决定 | 各入口 200；JSON 新评价及反馈的 `user_id` 均为 A；测试开启原有审核规则后均 pending。未改“允许关闭评价审核”问题，该项仍归 S3/MOD-04 | 通过（本轮身份范围） |
| 无效/过期/封禁凭证 | 不允许公开写 | 坏 Bearer + 好 Cookie 仍 401；数据库过期会话后两种凭证逐入口 401；封禁后逐入口 403；封禁密码登录及手机认证均 403 | 通过 |
| 官方换号与伪造 | 前端号码/归属无效 | 缺 code/超长 code 400；上游过期、错误 HTTP、对象号码、错误 appid 502；手机号只落合成上游值，B 未被误认证 | 通过（合成上游） |
| 重放、异步失效 | 不得二次认证或带失效身份完成 | A 的 code 给 B 使用 409，未新增上游请求；重启仍 409；上游等待期间封禁返回 403、撤销会话返回 401，SQLite 的 B 认证时间仍 NULL | 通过 |
| 微信登录边界 | code 无效/重放/封禁拒绝 | 格式错误 400，过期/上游重放 401（错误响应夹带 openid 也拒绝），封禁 403；正常登录 200，DTO 无 openid | 通过（合成上游） |
| 未配置 | 不产生假认证 | 清空 appid/secret 重启；手机认证与微信登录 503；B 仍未认证，数据库可查 PHONE_VERIFY_NOT_CONFIGURED 事件 | 通过 |
| 本人 DTO/跨用户 | 无内部行和横向读取 | A/B 分别读 `/me`、`/me/feedback`、`/me/reviews`、`/me/favorites`；伪造 query/body 的 user_id 不改变归属；B 列表为空、A 能读本人记录；递归排除敏感键 | 通过 |
| 公共 DTO | 无内部身份/投票者列表 | 合成已批准评价加入 user_id/helpfulBy/phone/openid/hash；旧/v1 公共响应均无上述字段 | 通过 |
| 私密缓存与扫码 | 私密响应不被共享缓存；票据一次用 | 私密 GET 即使带 If-None-Match 仍 200/no-store、无 ETag；扫码未认证确认 403、认证确认 200；状态成功下发 Cookie 仍 no-store，二次轮询 used，未知票据 expired | 通过（合成扫码票据） |
| 身份日志 | 成功/失败/拒绝可查且不复制秘密 | SQL 按动作和稳定代码断言注册成功/弱密码/重名、登录成功/错误/封禁/限流、微信登录、手机缺认证/格式/上游失败/重放/封禁/成功、扫码签发；时间、可信代理解析 IP、UA、路径齐全，已知错误密码目标账号保留 ID | 通过 |
| 身份日志泄密 | 不出现凭据/号码/微信原始错误 | 递归序列化实际身份日志，断言不含合成密码/token/code/AppSecret/号码/上游 errmsg；服务日志也不打印 phone 上游原始错误 | 通过 |
| 两类旧库 | 保数据、可注册/认证、幂等 | 两套旧库原账号7、openid、封禁账号8和 token 可读；索引保留；旧用户未认证；新注册 ID 超过历史自增高水位100；重启再次初始化无新迁移快照、认证状态不丢失 | 通过 |
| 迁移快照 | 安全、可读的旧结构副本 | NOT NULL 库生成一份 0600 SQLite 快照，原 NOT NULL 及两条历史账号仍可读；nullable 无多余快照。生产恢复演练未做 | 通过（合成快照） |
| 匿名私密投诉 | 可受理且不公开，不冒充账号 | 普通提交关闭、指南反馈关闭时仍 200；每套5条投诉真实保存，其中4条 user_id=NULL、1条属于登录B；伪造 user_id/private=false 无效 | 通过 |
| 投诉反滥用 | 仍有输入检查和频控 | 过短正文400；同IP前三条受理、第四条429；没有取消现有分层限流和蜜罐 | 通过 |
| 投诉后台读回/公共隔离 | 管理员能受理、普通用户不能后台读 | 合成管理员实际 GET 读到5条；实际 POST 删除 private、改 bug、approved、hidden=false 后，SQLite外的真实JSON仍5条private、公共列表0条；重启仍成立；普通用户读后台401 | 通过（新条目的最小保护） |
| 真实微信、小程序、生产 | 实际授权和部署闭环 | 未找到小程序手机号授权/扫码确认客户端源码；未使用真实企业小程序配置、测试用户、真机或生产代理/CDN。服务端默认官方 HTTPS，上游地址环境覆写仅在合成环境使用，生产有效配置未核验 | 未验证；外部条件 |

匿名投诉不建立匿名查询凭证，也不声称能向匿名用户站内送达回复。旧投诉的永久私密迁移、前端投诉表单、管理员修改原文/归属、审核/完成状态分离等仍留 S3；本报告不关闭 REP-05、REP-06 全项。

## 3. 检查环境与项目回归

- 隔离副本：`/private/tmp/nku-s1-validation`，未读取或复制生产 DATA_DIR、`.env` 或真实凭证。集成测试每次创建 `/private/tmp/nku-s1-http-*` 的合成 DATA_DIR 并清理。
- 精确依赖：Node 22.23.2、npm 10.9.8、Astro 7.2.2、TypeScript 5.9.3、better-sqlite3 12.11.1。工作仓库原有 Astro 7.2.8 未动；隔离副本采用锁文件 `npm ci --offline --ignore-scripts`。原生安装因沙箱本地代理/缓存权限失败，使用同一 Node ABI、同版本 12.11.1 的既有 `better_sqlite3.node`；真实读写及迁移均通过，并非用 mock 替代数据库。
- 沙箱首次本地监听 EPERM，获得工具审批后重跑回环 HTTP 成功；不是功能通过证据。Astro 首次 telemetry 写用户配置受阻，使用 `ASTRO_TELEMETRY_DISABLED=1` 后完成。没有自动审批拒绝导致的未完成操作。
- 阶段内按 fix-finding 技能进行了一次只读边界调查和一次只读候选复核，未并行处理其他整改大项。候选复核未发现可确认的 S1 绕过/回归；其定向30项测试通过。最后再以当前实现执行以下检查。

| 命令（副本中，TMPDIR=/private/tmp） | 实际结果 | 证据 |
|---|---|---|
| `node --check` 六个变更服务端模块；实际仓库 `git diff --check` | 通过 | 本次工具执行；源码摘要见 `source-state.json` |
| `node --test test/mp-auth-service.test.mjs test/public-api-router.test.mjs` | 22项通过 | 全部亦纳入后续全套 |
| `S1_EVIDENCE_DIR=… npm test` | **213通过，0失败**，原211项+本轮2套HTTP | [npm-test.log](evidence/S1/npm-test.log) |
| `S1_EVIDENCE_DIR=… node --test test/s1-identity.integration.test.mjs` | 两套均通过；导出最终重启后身份事件 | [s1-http-test.log](evidence/S1/s1-http-test.log) |
| `npm run check:api-docs` | 122条路由通过 | [api-docs.log](evidence/S1/api-docs.log) |
| `ASTRO_TELEMETRY_DISABLED=1 npm run build:fixtures` | 13页面构建通过；本人页仅做构建验证，未声称真机界面完成 | [build-fixtures.log](evidence/S1/build-fixtures.log) |
| `npm run check:fixtures`；`DATA_DIR=…/src/data/fixtures npm run check:content` | 均通过，1课程/0资源文件的公开夹具 | [fixtures.log](evidence/S1/fixtures.log)、[content.log](evidence/S1/content.log) |
| `DATA_DIR=…/src/data/fixtures npm run audit:encoding` | 9份合成JSON通过 | [encoding.log](evidence/S1/encoding.log) |
| `ASTRO_TELEMETRY_DISABLED=1 DATA_DIR=…/src/data/fixtures NODE_OPTIONS=--max-old-space-size=8192 npm run check` | **失败：2022 errors**，与B-01基线按文件+TS码+消息+次数比较完全一致；忽略行号移动，无新增诊断 | [check.log](evidence/S1/check.log)、[check-comparison.json](evidence/S1/check-comparison.json) |
| `ASTRO_TELEMETRY_DISABLED=1 npm run smoke:public-api` | **失败：Guide list response contract failed**，同既有指南夹具契约失败，未放松断言 | [smoke.log](evidence/S1/smoke.log) |

因此不能声称“所有项目检查全绿”。类型/指南基线修复仍归 QA-21，S1 没有顺手修掉或削弱这些检查。

## 4. 范围盘点与剩余条件

- 本轮公开文本投稿门禁覆盖旧评价、v1评价、普通反馈三个入口。收藏是本人私密数据；helpful 互动只产生登录用户的计数/本人反应，不创建公开文本，保留登录与封禁检查。
- 任务书原有“捐助付款后的昵称公开”路径本轮没有进入真实支付或修改付款/发布逻辑；不能把付款等同手机号认证，也不据三个入口通过宣称 UGC-02 的全站盘点已关闭。此路径仍需协调任务明确剩余治理与验收归属。
- 官方协议代码与合成上游验证通过，不等于官方服务真实联调通过。需提供适用小程序源码、受控测试环境及真实授权链路后补 WX-22；无需给本任务真实管理员密码。
- 生产 Cookie/HTTPS、可信代理/CDN缓存、旧 schema 实际形态、生产迁移和备份恢复未验证。迁移只自动处理已识别的历史 `openid TEXT NOT NULL` 结构；其他自定义定义失败关闭，需另行评审。
- 迁移回退方案：停服务并保留当前 SQLite/WAL/SHM，用本次生成的完整 `*.before-openid-nullable-*.sqlite` 在受控副本验证后恢复，再使用对应旧代码或重跑迁移；不能在线只覆盖主库，也不能直接丢弃迁移后新增写入。合成测试核验快照可读及原约束/账号，未执行生产回退。
- 日志归档、存储故障补偿、网络入口日志和其余用户事件留 S2；新 code 摘要表不等同安全日志归档。REP-06其余入口、历史永久私密和后台UI留S3；C-08权限变更留S4；注销与D-01留S5。

## 5. 最终交付状态

变更文件：`server/user-identity.mjs`（新增）、`server/admin-server.mjs`、`server/content-publish-service.mjs`、`server/mp-auth-service.mjs`、`server/public-api-router.mjs`、`server/wechat-phone.mjs`、`src/pages/me.astro`、`test/public-api-router.test.mjs`（补齐实际共享鉴权依赖）、`test/s1-identity.integration.test.mjs`（新增），以及本报告、主台账和 `docs/compliance/evidence/S1/`。

没有修改锁文件、真实运行数据、管理员查询导出权限、注销策略或原申报PDF；没有提交、推送、合并、部署或发送外部消息。代码及脱敏证据保留在当前工作树；[源码摘要](evidence/S1/source-state.json)标记验收对应字节。S1本地结果待协调任务确认；外部未验证项如实保留，**不自动进入S2**。
