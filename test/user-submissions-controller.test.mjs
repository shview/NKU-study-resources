import assert from "node:assert/strict";
import test from "node:test";
import { createOwnerListController, reportReceipt, requestUserJson, reviewSubmissionMessage, UserRequestError } from "../src/lib/user-submissions-controller.js";

const page = (number, total = 23, items = [{ title: `owner record ${number}` }]) => ({ code: 0, data: { items, total, page: number, page_size: 10 } });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test("report success requires durable private acceptance and does not turn a honeypot into a receipt", () => {
  for (const result of [{ ok: true }, { ok: true, accepted: false }, { ok: true, accepted: true, private: false, receiptId: "synthetic" }, { ok: true, accepted: true, private: true, receiptId: "" }]) {
    assert.throws(() => reportReceipt(result), UserRequestError);
  }
  assert.deepEqual(reportReceipt({ ok: true, accepted: true, private: true, receiptId: "synthetic", replyAvailable: false }), { receiptId: "synthetic", replyAvailable: false });
  assert.deepEqual(reportReceipt({ ok: true, accepted: true, private: true, receiptId: "synthetic", replyAvailable: true }), { receiptId: "synthetic", replyAvailable: true });
});

test("review copy follows the saved automatic or pending result and rejects an ignored request", () => {
  assert.match(reviewSubmissionMessage({ ok: true, accepted: true, pending: false }), /并公开/);
  assert.match(reviewSubmissionMessage({ ok: true, accepted: true, pending: true }), /等待审核/);
  assert.match(reviewSubmissionMessage({ ok: true, accepted: true, review: { publicationState: "pending" }, pending: false }), /等待审核/);
  assert.throws(() => reviewSubmissionMessage({ ok: true, accepted: false, pending: true }), UserRequestError);
});

test("owner pagination requests later pages and retry preserves the failed page instead of inventing an empty list", async () => {
  const calls = [], states = [];
  let fail = false;
  const controller = createOwnerListController({ path: "/api/v1/me/feedback", onState: (state) => states.push(state), request: async (url) => {
    calls.push(url);
    if (fail) throw new UserRequestError("synthetic storage unavailable", 503);
    return page(Number(new URL(url, "https://example.test").searchParams.get("page")));
  } });
  await controller.load(1);
  fail = true;
  await controller.load(2);
  assert.equal(controller.state().phase, "error");
  assert.equal(controller.state().page, 2);
  assert.match(controller.state().error, /storage unavailable/);
  fail = false;
  await controller.retry();
  assert.equal(controller.state().phase, "ready");
  assert.equal(controller.state().page, 2);
  assert.equal(controller.state().total, 23);
  assert.deepEqual(calls, [1, 2, 2].map((number) => `/api/v1/me/feedback?page=${number}&page_size=10`));
  assert.ok(states.some((state) => state.phase === "error"));
});

test("session errors clear owner rows and remain distinct from an empty successful response", async () => {
  let expired = false;
  const controller = createOwnerListController({ path: "/api/v1/me/reviews", request: async () => {
    if (expired) throw new UserRequestError("expired", 401);
    return page(1);
  } });
  await controller.load();
  expired = true;
  await controller.retry();
  assert.deepEqual(controller.state().items, []);
  assert.equal(controller.state().authExpired, true);
  assert.match(controller.state().error, /登录已失效/);
  assert.throws(() => createOwnerListController({ path: "/api/v1/feedback/synthetic" }), /Unsupported/);
});

test("a late page response cannot replace a newer requested page", async () => {
  const oldPage = deferred();
  const controller = createOwnerListController({ path: "/api/v1/me/feedback", request: (url) => url.includes("page=1&") ? oldPage.promise : Promise.resolve(page(2)) });
  const oldLoad = controller.load(1);
  await controller.load(2);
  oldPage.resolve(page(1));
  await oldLoad;
  assert.equal(controller.state().page, 2);
  assert.equal(controller.state().items[0].title, "owner record 2");
});

test("deleting the last page returns to the actual last page and malformed responses are visible errors", async () => {
  const calls = [];
  const controller = createOwnerListController({ path: "/api/v1/me/feedback", request: async (url) => { calls.push(url); return url.includes("page=3&") ? page(3, 11, []) : page(2, 11); } });
  await controller.load(3);
  assert.equal(controller.state().page, 2);
  assert.equal(calls.length, 2);
  const malformed = createOwnerListController({ path: "/api/v1/me/reviews", request: async () => ({ code: 0, data: {} }) });
  await malformed.load();
  assert.equal(malformed.state().phase, "error");
});

test("requests retain same-origin cookies, bypass owner caching, and visibly reject non-JSON results", async () => {
  let options;
  await assert.rejects(requestUserJson("/feedback-api/report", { method: "POST", body: "{}" }, { fetch: async (_url, init) => {
    options = init;
    return { ok: true, status: 200, json: async () => { throw new SyntaxError("synthetic"); } };
  } }), /无法读取/);
  assert.equal(options.credentials, "same-origin");
  assert.equal(options.cache, "no-store");
});

test("a stalled request exits loading after timeout with an uncertain-result error", async () => {
  await assert.rejects(requestUserJson("/feedback-api/report", {}, { timeoutMs: 5, fetch: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))) }), /请求超时/);
});
