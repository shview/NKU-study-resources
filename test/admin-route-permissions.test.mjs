import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { ADMIN_ROUTE_PERMISSIONS } from "../server/admin-route-permissions.mjs";
import { ADMIN_PERMISSION_POINTS } from "../server/admin-accounts-store.mjs";

const source = fs.readFileSync(path.resolve("server/admin-server.mjs"), "utf8");

/** 与实现同构的静态路由提取：新增 /admin-api 静态路由未声明权限即失败。 */
function extractStaticAdminRoutes(source) {
  const pattern = /req\.method === "(GET|POST|DELETE|PUT)" && (?:\[[^\]]+\]\.includes\(url\.pathname\)|url\.pathname === "(\/admin-api\/[^"]+)")/g;
  const routes = new Set();
  for (const match of source.matchAll(pattern)) {
    if (match[2]) routes.add(`${match[1]} ${match[2]}`);
  }
  return routes;
}

test("every static /admin-api route declares a permission in the registry", () => {
  const inCode = extractStaticAdminRoutes(source);
  assert.ok(inCode.size > 50, `静态路由提取异常：${inCode.size}`);
  const missing = [...inCode].filter((route) => !(route in ADMIN_ROUTE_PERMISSIONS));
  assert.deepEqual(missing, [], "以下管理路由未在 ADMIN_ROUTE_PERMISSIONS 声明权限");
});

test("registry contains no stale routes absent from code", () => {
  const inCode = extractStaticAdminRoutes(source);
  const stale = Object.keys(ADMIN_ROUTE_PERMISSIONS).filter((route) => route.includes("/admin-api/") && !inCode.has(route));
  // 动态路由（如 law-query 等）允许不在静态提取结果里，但必须存在于源码字符串
  const trulyStale = stale.filter((route) => !source.includes(route.split(" ")[1]));
  assert.deepEqual(trulyStale, [], "注册表中的路由在源码里不存在");
});

test("declared permissions are valid permission points", () => {
  const valid = new Set([...ADMIN_PERMISSION_POINTS, "__auth__", "__disabled__"]);
  for (const [route, permission] of Object.entries(ADMIN_ROUTE_PERMISSIONS)) {
    assert.ok(valid.has(permission), `${route} 的权限 ${permission} 不是合法权限点`);
  }
});

test("law enforcement routes require the dedicated law.manage permission", () => {
  assert.equal(ADMIN_ROUTE_PERMISSIONS["GET /admin-api/law-query"], "law.manage");
  assert.equal(ADMIN_ROUTE_PERMISSIONS["GET /admin-api/law-export"], "law.manage");
});
