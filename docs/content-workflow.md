# NKUStudy 内容维护流程

## 生产内容的唯一入口

课程、资源索引、首页、关于、参与、友链、评价与反馈只允许通过网站管理端维护。维护人员不要登录服务器直接编辑 JSON，也不要用本地数据覆盖生产数据。微信小程序只读取公开接口并提交普通用户操作；它不提供内容管理功能，`/api/v1` 也不得映射或代理任何 `/admin-api` 路由。

## 发布边界

- 可变 JSON 位于 `DATA_DIR=/var/lib/nkustudy/json`，持久状态库位于 `/var/lib/nkustudy/miniprogram.sqlite`，管理签名密钥位于 `/var/lib/nkustudy/admin-secret`；代码 release 不保存这些数据。
- 代码发布只同步源码，不携带 `src/data/*.json`、凭据、数据库、日志、备份或资源文件。
- 网站构建读取服务器最新受控数据；缺少必需文件时立即失败，绝不回退到 fixture。
- 课程资料仍由 R2 提供，密钥只存在于服务器环境变量。
- 所有 manifest 草稿、发布和 R2 同步由同一 `ManifestService` 串行执行；生产只能运行一个写进程。

## 隔离测试数据

`src/data/fixtures` 只含人工检查过的合成数据。`npm run build:fixtures` 构建到 `dist-fixture` 并清理暂存文件；`dist-fixture` 不得发布，也不得写回管理端。

## 变更与迁移

管理端写入后执行内容校验、候选构建和旧接口回归。涉及结构迁移时，先停止服务并冻结管理操作，按 `docs/data-schema.md` 的锁与哈希 CAS 流程迁移，再恢复服务。不得直接批量替换线上文件。
