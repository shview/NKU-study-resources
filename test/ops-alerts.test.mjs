import assert from "node:assert/strict";
import test from "node:test";
import { createOpsAlerts, OPS_ALERT_KEYS } from "../server/ops-alerts.mjs";

test("ops alerts use four fixed subsystem states and never copy event data into messages or logs", async () => {
  const messages = [];
  const logs = [];
  const secret = "SYNTHETIC-user-password-path-event-id-DO-NOT-SEND";
  const details = { password: secret, user: secret, event_id: secret, error: new Error(secret), path: secret };
  Object.defineProperty(details, "health", { get() { throw new Error("details must not be read"); } });
  const alerts = createOpsAlerts({
    now: () => 0,
    send: async (message, options) => { messages.push({ message, options }); return { sent: true }; },
    log: (entry) => logs.push(entry),
  });
  for (let index = 0; index < 1_000; index += 1) {
    assert.equal(alerts.report(`${secret}-${index}`, true, details), false);
  }
  for (const key of OPS_ALERT_KEYS) {
    for (let index = 0; index < 100; index += 1) assert.equal(alerts.report(key, true, details), true);
  }
  assert.equal(messages.length, 0, "report must return before starting network work");
  await alerts.flush();
  assert.equal(messages.length, 4, "concurrent reports are deduplicated independently per fixed key");
  assert.deepEqual(new Set(logs.map((entry) => entry.key)), new Set(["log-user", "log-admin", "log-law", "backup"]));
  for (const { message, options } of messages) {
    assert.deepEqual(options, { purpose: "ops" });
    assert.deepEqual(Object.keys(message).sort(), ["lines", "template", "title"]);
    assert.equal(message.template, "red");
    assert.equal(message.lines.includes("**检测时间（UTC）**：1970-01-01T00:00:00.000Z"), true, "timestamps come from the injected clock");
  }
  assert.equal(JSON.stringify({ messages, logs }).includes(secret), false);
});

test("ops alerts cool down successful sends and allow immediate alerts after recovery", async () => {
  let time = 0;
  let sent = 0;
  const alerts = createOpsAlerts({ now: () => time, cooldownMs: 1_000, retryMs: 100, send: async () => { sent += 1; return { sent: true }; } });
  alerts.report("backup", true);
  await alerts.flush();
  assert.equal(sent, 1);
  time = 999;
  alerts.report("backup", true);
  await alerts.flush();
  assert.equal(sent, 1);
  time = 1_000;
  alerts.report("backup", true);
  await alerts.flush();
  assert.equal(sent, 2, "an ongoing failure can remind after cooldown");
  time = 1_001;
  alerts.report("backup", false);
  await alerts.flush();
  assert.equal(sent, 2, "recovery does not send an extra notification");
  alerts.report("backup", true);
  await alerts.flush();
  assert.equal(sent, 3, "a new failure is not hidden by the previous failure's cooldown");
});

test("failed, unavailable and partial notification deliveries retry without propagating exceptions or secrets", async () => {
  let time = 0;
  const messages = [];
  const logs = [];
  const secret = "SYNTHETIC-TRANSPORT-SECRET";
  const responses = [
    () => { throw new Error(secret); },
    () => ({ sent: false, reason: secret }),
    () => ({ sent: true, results: [{ sent: true }, { sent: false, reason: secret }] }),
    () => ({ sent: true, results: [{ sent: true }] }),
  ];
  const alerts = createOpsAlerts({
    now: () => time, cooldownMs: 1_000, retryMs: 100,
    send: async (message) => { messages.push(message); return responses[messages.length - 1](); },
    log: (entry) => { logs.push(entry); throw new Error(secret); },
  });
  for (let attempt = 0; attempt < responses.length; attempt += 1) {
    time = attempt * 100;
    assert.doesNotThrow(() => alerts.report("log-user", true, { error: secret }));
    await assert.doesNotReject(alerts.flush());
    assert.equal(messages.length, attempt + 1);
    time += 99;
    alerts.report("log-user", true);
    await alerts.flush();
    assert.equal(messages.length, attempt + 1, "repeated reports wait for the retry boundary");
  }
  time = 400;
  alerts.report("log-user", true);
  await alerts.flush();
  assert.equal(messages.length, 4, "a successful retry switches to the longer cooldown");
  assert.deepEqual(logs.map((entry) => entry.status), ["failed", "failed", "failed", "sent"]);
  assert.equal(JSON.stringify({ messages, logs }).includes(secret), false);
});

test("in-flight sends are coalesced and cannot suppress a new failure following recovery", async () => {
  let time = 0;
  let release;
  let calls = 0;
  const alerts = createOpsAlerts({
    now: () => time, cooldownMs: 1_000,
    send: async () => {
      calls += 1;
      if (calls === 1) return new Promise((resolve) => { release = resolve; });
      return { sent: true };
    },
  });
  alerts.report("log-admin", true);
  await Promise.resolve();
  assert.equal(calls, 1);
  for (let index = 0; index < 50; index += 1) alerts.report("log-admin", true);
  time = 10;
  alerts.report("log-admin", false);
  time = 20;
  alerts.report("log-admin", true);
  assert.equal(calls, 1, "only one send may be in flight for a subsystem");
  release({ sent: true });
  await alerts.flush();
  assert.equal(calls, 2, "the old result cannot set cooldown on the new failure");
  time = 21;
  alerts.report("log-admin", true);
  await alerts.flush();
  assert.equal(calls, 2);
});

test("recovery before queued delivery cancels a stale alert and recovery after failure cancels retries", async () => {
  let time = 0;
  let calls = 0;
  const alerts = createOpsAlerts({ now: () => time, retryMs: 100, send: async () => { calls += 1; return { sent: false }; } });
  alerts.report("log-law", true);
  alerts.report("log-law", false);
  await alerts.flush();
  assert.equal(calls, 0);
  alerts.report("log-law", true);
  await alerts.flush();
  assert.equal(calls, 1);
  alerts.report("log-law", false);
  time = 1_000;
  alerts.report("log-law", false);
  await alerts.flush();
  assert.equal(calls, 1);
});
