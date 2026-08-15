import assert from "node:assert/strict";
import test from "node:test";
import { responseWarnings, statusWithWarnings } from "../src/lib/admin-response-warnings.js";

test("admin status aggregates publish and R2 cleanup warnings", () => {
  const data = {
    warnings: ["static durability degraded", ""],
    cleanupWarnings: ["old R2 objects remain", 42],
  };
  assert.deepEqual(responseWarnings(data), ["static durability degraded", "old R2 objects remain"]);
  assert.equal(statusWithWarnings("已发布", data), "已发布；警告：static durability degraded；old R2 objects remain");
  assert.equal(statusWithWarnings("已发布", {}), "已发布");
});
