import { ADMIN_PERMISSION_POINTS } from "./admin-accounts-store.mjs";

/**
 * 管理路由 → 权限点 权威注册表（公安安全评估 P0）：
 * - 新增 /admin-api 静态路由必须在此声明权限，否则 test/admin-route-permissions.test.mjs 失败；
 * - "__auth__" 表示仅需登录（无附加权限点）；
 * - "__disabled__" 表示已下线的遗留路由（恒 410）。
 */
const AUTH = "__auth__";
const DISABLED = "__disabled__";

export const ADMIN_ROUTE_PERMISSIONS = Object.freeze({
  // 内容（读）
  "GET /admin-api/about": "content.read",
  "GET /admin-api/donate": "content.read",
  "GET /admin-api/donate-stats": "content.read",
  "GET /admin-api/editor-settings": "content.read",
  "GET /admin-api/feedback": "content.read",
  "GET /admin-api/footer": "content.read",
  "GET /admin-api/home": "content.read",
  "GET /admin-api/links": "content.read",
  "GET /admin-api/manifest": "content.read",
  "GET /admin-api/mp-users": "content.read",
  "GET /admin-api/participate": "content.read",
  "GET /admin-api/reviews": "content.read",
  "GET /admin-api/visit-stats": "content.read",
  "GET /admin-api/privacy": "content.read",
  // 内容（写/发布）
  "POST /admin-api/about": "content.edit",
  "POST /admin-api/catalog/courses": "content.edit",
  "POST /admin-api/catalog/import-courses": "content.edit",
  "POST /admin-api/content-images": "content.edit",
  "POST /admin-api/content-images/cleanup": "content.edit",
  "POST /admin-api/donate": "content.edit",
  "POST /admin-api/editor-settings": "content.edit",
  "POST /admin-api/footer": "content.edit",
  "POST /admin-api/home": "content.edit",
  "POST /admin-api/links": "content.edit",
  "POST /admin-api/manifest": "content.edit",
  "POST /admin-api/manifest-draft": "content.edit",
  "POST /admin-api/participate": "content.edit",
  "POST /admin-api/privacy": "content.edit",
  "POST /admin-api/reviews": "content.edit",
  "POST /admin-api/upload": "content.edit",
  "POST /admin-api/feedback": "content.moderate",
  // 存储
  "POST /admin-api/delete-r2": DISABLED,
  "POST /admin-api/delete-r2-course": DISABLED,
  "POST /admin-api/move-r2-prefix": DISABLED,
  "POST /admin-api/r2-publish": "storage.manage",
  "POST /admin-api/sync-r2": "storage.manage",
  "POST /admin-api/sync-r2-all": "storage.manage",
  // 账号与权限
  "GET /admin-api/accounts": "accounts.manage",
  "POST /admin-api/accounts": "accounts.manage",
  "GET /admin-api/session": AUTH,
  "POST /admin-api/login": AUTH,
  "POST /admin-api/logout": AUTH,
  "POST /admin-api/me/password": AUTH,
  // 服务密钥 / AI
  "GET /admin-api/service-keys": "services.manage",
  "POST /admin-api/service-keys": "services.manage",
  "POST /admin-api/service-keys-settings": "services.manage",
  "GET /admin-api/ai-settings": "ai.manage",
  "POST /admin-api/ai-settings": "ai.manage",
  "POST /admin-api/ai-settings/test": "ai.manage",
  "GET /admin-api/donate-pay": "services.manage",
  "POST /admin-api/donate-pay": "services.manage",
  // 备份与通知
  "GET /admin-api/backup": "backup.manage",
  "GET /admin-api/backup-settings": "backup.manage",
  "POST /admin-api/backup-run": "backup.manage",
  "POST /admin-api/backup-settings": "backup.manage",
  "POST /admin-api/backup-test-webdav": "backup.manage",
  "GET /admin-api/notify-settings": "backup.manage",
  "POST /admin-api/notify-settings": "backup.manage",
  "POST /admin-api/notify-bots": "backup.manage",
  "POST /admin-api/notify-test": "backup.manage",
  // 审计与依法调取
  "GET /admin-api/audit": "audit.read",
  "GET /admin-api/law-query": "law.manage",
  "GET /admin-api/law-export": "law.manage",
});

const VALID = new Set([...ADMIN_PERMISSION_POINTS, AUTH, DISABLED]);
for (const [route, permission] of Object.entries(ADMIN_ROUTE_PERMISSIONS)) {
  if (!VALID.has(permission)) {
    throw new Error(`ADMIN_ROUTE_PERMISSIONS: ${route} 声明了未知权限 ${permission}`);
  }
}
