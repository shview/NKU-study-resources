import assert from "node:assert/strict";
import test from "node:test";
import { createWebLoginController } from "../src/lib/web-login-controller.js";

const ticket = "synthetic-ticket-001";
const startData = { ticket, expires_in: 300, qr_available: false };
const reply = (data, status = 200) => ({ ok: status === 200, status, json: async () => ({ code: status === 200 ? 0 : 1, data }) });
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function harness(responses) {
  const calls = [], states = [], logins = [], timers = new Map();
  let time = 1000, sequence = 0, timerId = 0;
  const controller = createWebLoginController({
    fetch: async (url, options) => {
      calls.push({ url, options });
      assert.ok(responses.length, "unexpected request");
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return await next;
    },
    onState: (state) => states.push(state),
    onLogin: (user) => logins.push(user),
    now: () => time,
    nonce: () => `request-${++sequence}`,
    schedule: (callback) => { timers.set(++timerId, callback); return timerId; },
    unschedule: (id) => timers.delete(id),
  });
  return { ...controller, calls, states, logins, timers,
    last: () => states.at(-1),
    advance: (ms) => { time += ms; },
    tick: async () => { const [id, callback] = timers.entries().next().value; timers.delete(id); await callback(); },
  };
}

test("fresh status requests bypass cached pending and verify the same account's browser session", async () => {
  const h = harness([reply(startData), reply({ status: "pending" }), reply({ status: "confirmed", user: { id: 7 } }), reply({ user: { id: 7 } })]);
  await h.start();
  await h.tick();
  await h.tick();
  assert.equal(h.last().phase, "success");
  assert.deepEqual(h.logins, [{ id: 7 }]);
  assert.equal(h.timers.size, 0);
  for (const { options } of h.calls) {
    assert.equal(options.cache, "no-store");
    assert.equal(options.credentials, "same-origin");
  }
  const statusCalls = h.calls.filter(({ url }) => url.includes("/status?"));
  assert.equal(statusCalls.length, 2);
  assert.notEqual(statusCalls[0].url, statusCalls[1].url);
  assert.equal(new URL(statusCalls[1].url, "https://example.test").searchParams.get("ticket"), ticket);
  assert.equal(h.calls.at(-1).options.method, "POST");
  assert.equal(h.calls.at(-1).options.body, "{}");
});

test("manual checks and slow responses never overlap or consume a ticket twice", async () => {
  const slow = deferred();
  const h = harness([reply(startData), slow.promise]);
  await h.start();
  const checking = h.check();
  await h.check();
  await h.check();
  assert.equal(h.calls.length, 2);
  assert.equal(h.timers.size, 0);
  slow.resolve(reply({ status: "pending" }));
  await checking;
  assert.equal(h.timers.size, 1);
});

test("manual check uses the existing ticket without starting a replacement", async () => {
  const h = harness([reply(startData), reply({ status: "pending" })]);
  await h.start();
  await h.check();
  assert.equal(h.calls.filter(({ url }) => url.endsWith("/start")).length, 1);
  assert.equal(h.last().ticket, ticket);
  assert.equal(h.timers.size, 1);
});

test("refresh ignores an earlier start response and keeps only the new polling loop", async () => {
  const slow = deferred();
  const h = harness([slow.promise, reply({ ...startData, ticket: "synthetic-new-ticket" })]);
  const oldStart = h.start();
  await h.start();
  slow.resolve(reply(startData));
  await oldStart;
  assert.equal(h.last().ticket, "synthetic-new-ticket");
  assert.equal(h.timers.size, 1);
  assert.equal(h.calls[0].options.signal.aborted, true);
});

test("closing cancels polling and ignores a late confirmation response", async () => {
  const slow = deferred();
  const h = harness([reply(startData), slow.promise]);
  await h.start();
  const checking = h.check();
  h.stop();
  slow.resolve(reply({ status: "confirmed", user: { id: 7 } }));
  await checking;
  assert.equal(h.logins.length, 0);
  assert.equal(h.calls.length, 2);
  assert.equal(h.timers.size, 0);
});

test("a late old poll cannot stop a refreshed ticket", async () => {
  const slow = deferred();
  const h = harness([reply(startData), slow.promise, reply({ ...startData, ticket: "synthetic-new-ticket" })]);
  await h.start();
  const checking = h.check();
  await h.start();
  slow.resolve(reply({ status: "used" }));
  await checking;
  assert.equal(h.last().phase, "pending");
  assert.equal(h.last().ticket, "synthetic-new-ticket");
  assert.equal(h.timers.size, 1);
});

test("network failure is visible and the next check can recover", async () => {
  const h = harness([reply(startData), new Error("offline"), reply({ status: "pending" })]);
  await h.start();
  await h.check();
  assert.equal(h.last().phase, "retry");
  assert.match(h.last().message, /无法查询/);
  await h.tick();
  assert.equal(h.last().phase, "pending");
});

test("a consumed confirmation retries only session restoration after a network error", async () => {
  const h = harness([reply(startData), reply({ status: "confirmed", user: { id: 7 } }), new Error("offline"), reply({ user: { id: 7 } })]);
  await h.start();
  await h.check();
  assert.equal(h.last().phase, "retry");
  await h.check();
  assert.equal(h.logins.length, 1);
  assert.equal(h.calls.filter(({ url }) => url.includes("/status?")).length, 1);
});

for (const response of [reply({}, 401), reply({ user: null }), reply({ user: { id: 8 } })]) {
  test(`missing or mismatched browser session never reports success: ${JSON.stringify(await response.json())}`, async () => {
    const h = harness([reply(startData), reply({ status: "confirmed", user: { id: 7 } }), response]);
    await h.start();
    await h.check();
    assert.equal(h.last().phase, "error");
    assert.match(h.last().message, /Cookie/);
    assert.equal(h.logins.length, 0);
    assert.equal(h.timers.size, 0);
  });
}

for (const status of ["expired", "used"]) test(`${status} tickets require explicit refresh, never infer login from an unrelated session`, async () => {
  const h = harness([reply(startData), reply({ status })]);
  await h.start();
  await h.check();
  assert.equal(h.last().phase, "expired");
  assert.equal(h.calls.length, 2);
  assert.equal(h.logins.length, 0);
  assert.equal(h.timers.size, 0);
});

test("polling ends at expiry even while the network is unavailable", async () => {
  const h = harness([reply(startData)]);
  await h.start();
  h.advance(300001);
  await h.tick();
  assert.equal(h.last().phase, "expired");
  assert.equal(h.calls.length, 1);
  assert.equal(h.timers.size, 0);
});

test("failed start displays an error without polling or creating another ticket", async () => {
  const h = harness([new Error("offline")]);
  await h.start();
  assert.equal(h.last().phase, "error");
  assert.equal(h.timers.size, 0);
});
