import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AdminSessionStore } from "../server/admin-session-store.mjs";

test("admin sessions persist, expire server-side, and can be revoked", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nkustudy-admin-session-"));
  const dbPath = path.join(directory, "state.sqlite");
  const secret = "test-secret-that-is-longer-than-thirty-two-characters";
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  let store = new AdminSessionStore({ dbPath, secret, absoluteTtlMs: 10_000, idleTtlMs: 1_000, maxSessions: 2 });
  const token = store.create({ now: 1_000 });
  assert.equal(store.validate(token, { now: 1_500 }), true);
  store.close();

  store = new AdminSessionStore({ dbPath, secret, absoluteTtlMs: 10_000, idleTtlMs: 1_000, maxSessions: 2 });
  assert.equal(store.validate(token, { now: 2_000 }), true);
  assert.equal(store.revoke(token), true);
  assert.equal(store.validate(token, { now: 2_001 }), false);

  const idleToken = store.create({ now: 3_000 });
  assert.equal(store.validate(idleToken, { now: 4_000 }), false, "idle expiry is enforced by the server");
  const absoluteToken = store.create({ now: 5_000 });
  for (let now = 5_900; now < 15_000; now += 900) assert.equal(store.validate(absoluteToken, { now }), true);
  assert.equal(store.validate(absoluteToken, { now: 15_000 }), false, "absolute expiry cannot be extended by activity");
  assert.equal(store.validate("not a valid token", { now: 6_000 }), false);
  store.close();
});

test("admin session count is bounded", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nkustudy-admin-session-cap-"));
  const store = new AdminSessionStore({
    dbPath: path.join(directory, "state.sqlite"),
    secret: "another-test-secret-longer-than-thirty-two-characters",
    absoluteTtlMs: 10_000,
    idleTtlMs: 10_000,
    maxSessions: 2,
  });
  t.after(async () => {
    store.close();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const oldest = store.create({ now: 1_000 });
  const middle = store.create({ now: 2_000 });
  const newest = store.create({ now: 3_000 });
  assert.equal(store.validate(oldest, { now: 3_001 }), false);
  assert.equal(store.validate(middle, { now: 3_001 }), true);
  assert.equal(store.validate(newest, { now: 3_001 }), true);
});
