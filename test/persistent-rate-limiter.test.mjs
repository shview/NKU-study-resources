import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { hashActor } from "../server/client-identity.mjs";
import { PersistentRateLimiter } from "../server/persistent-rate-limiter.mjs";

async function databasePath(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nkustudy-rate-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, "state.sqlite");
}

test("limits persist across instances and database reopen", async (t) => {
  const dbPath = await databasePath(t);
  const input = { scope: "review-submit", actorHash: hashActor("203.0.113.8", "test-secret-that-is-long-enough"), limits: [{ windowMs: 60_000, max: 2 }], now: 120_000 };
  const first = new PersistentRateLimiter({ dbPath });
  assert.equal(first.consume(input).allowed, true);
  assert.equal(first.consume(input).allowed, true);
  first.close();
  const reopened = new PersistentRateLimiter({ dbPath });
  assert.equal(reopened.consume(input).allowed, false);
  reopened.close();
});

test("transactional counters are shared and never persist raw actors", async (t) => {
  const dbPath = await databasePath(t);
  const actor = "198.51.100.24";
  const actorHash = hashActor(actor, "another-test-secret-that-is-long-enough");
  const a = new PersistentRateLimiter({ dbPath });
  const b = new PersistentRateLimiter({ dbPath });
  const attempts = Array.from({ length: 50 }, (_, index) => (index % 2 ? a : b).consume({
    scope: "feedback-submit",
    actorHash,
    limits: [{ windowMs: 60_000, max: 50 }],
    now: 180_000,
  }));
  assert.equal(attempts.filter((result) => result.allowed).length, 50);
  assert.equal(a.consume({ scope: "feedback-submit", actorHash, limits: [{ windowMs: 60_000, max: 50 }], now: 180_000 }).allowed, false);
  a.close();
  b.close();
  const inspect = new Database(dbPath, { readonly: true });
  const rows = inspect.prepare("SELECT actor_hash, count FROM rate_limits").all();
  inspect.close();
  assert.equal(rows.some((row) => row.actor_hash === actor), false);
  assert.equal(rows.some((row) => row.actor_hash === actorHash && row.count === 50), true);
});

test("invalid numeric and key inputs fail closed", async (t) => {
  const limiter = new PersistentRateLimiter({ dbPath: await databasePath(t) });
  const base = { scope: "attempt", actorHash: "a".repeat(32), limits: [{ windowMs: 1_000, max: 1 }], now: 1_000 };
  assert.throws(() => limiter.consume({ ...base, limits: [{ windowMs: Number.NaN, max: 1 }] }), /positive safe integer/);
  assert.throws(() => limiter.consume({ ...base, limits: [{ windowMs: 1_000, max: Infinity }] }), /positive safe integer/);
  assert.throws(() => limiter.consume({ ...base, now: -1 }), /non-negative safe integer/);
  assert.throws(() => limiter.consume({ ...base, scope: "" }), /non-empty bounded string/);
  limiter.close();
});

test("layered consume is atomic and actor rejection does not consume global capacity", async (t) => {
  const limiter = new PersistentRateLimiter({ dbPath: await databasePath(t) });
  const input = (actorHash) => ({
    scope: "layered-attempt",
    actorHash,
    globalActorHash: "global-counter",
    actorLimits: [{ windowMs: 60_000, max: 1 }],
    globalLimits: [{ windowMs: 60_000, max: 3 }],
    now: 240_000,
  });
  assert.equal(limiter.consumeLayered(input("actor-a")).allowed, true);
  assert.equal(limiter.consumeLayered(input("actor-a")).allowed, false);
  assert.equal(limiter.consumeLayered(input("actor-b")).allowed, true);
  assert.equal(limiter.consumeLayered(input("actor-c")).allowed, true);
  assert.equal(limiter.consumeLayered(input("actor-d")).allowed, false);
  const global = limiter.db.prepare("SELECT count FROM rate_limits WHERE scope = ? AND actor_hash = ?").get("layered-attempt", "global-counter");
  assert.equal(global.count, 3);
  limiter.close();
});

test("layered global capacity is shared transactionally across database instances", async (t) => {
  const dbPath = await databasePath(t);
  const a = new PersistentRateLimiter({ dbPath });
  const b = new PersistentRateLimiter({ dbPath });
  const results = Array.from({ length: 50 }, (_, index) => (index % 2 ? a : b).consumeLayered({
    scope: "shared-layer",
    actorHash: `actor-${index}`,
    globalActorHash: "global-counter",
    actorLimits: [{ windowMs: 60_000, max: 2 }],
    globalLimits: [{ windowMs: 60_000, max: 30 }],
    now: 300_000,
  }));
  assert.equal(results.filter((result) => result.allowed).length, 30);
  a.close();
  b.close();
});

test("persistent windows are anchored to the first attempt instead of resetting at epoch bucket boundaries", async (t) => {
  const limiter = new PersistentRateLimiter({ dbPath: await databasePath(t) });
  const input = {
    scope: "boundary",
    actorHash: "actor-boundary",
    limits: [{ windowMs: 60_000, max: 1 }],
  };
  assert.equal(limiter.consume({ ...input, now: 59_999 }).allowed, true);
  const crossedEpochBucket = limiter.consume({ ...input, now: 60_001 });
  assert.equal(crossedEpochBucket.allowed, false);
  assert.equal(crossedEpochBucket.retryAfterMs, 59_998);
  assert.equal(limiter.consume({ ...input, now: 119_999 }).allowed, true);
  limiter.close();
});
