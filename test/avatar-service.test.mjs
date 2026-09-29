import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { AvatarStore } from "../server/avatar-store.mjs";
import { createAvatarService, AVATAR_MAX_BYTES } from "../server/avatar-service.mjs";
import { createWechatImageModeration } from "../server/wechat-image-moderation.mjs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nkustudy-avatar-"));

/** mock 微信 API：stable_token 恒可用；img_sec_check 按图片内容尾部字节返回 errcode。 */
async function withMockWechat(handler, fn) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (url.pathname === "/cgi-bin/stable_token") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "mock-token", expires_in: 7200 }));
      return;
    }
    if (url.pathname === "/wxa/img_sec_check") {
      const verdict = handler(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(verdict));
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testImage({ width = 60, height = 60, format = "jpeg" } = {}) {
  const pipeline = sharp({ create: { width, height, channels: 3, background: "#3366aa" } });
  return format === "png" ? pipeline.png().toBuffer() : pipeline.jpeg().toBuffer();
}

function makeService({ moderationBase, putObject, deleteObject, rateLimiter = null, now } = {}) {
  const store = new AvatarStore({ dbPath: path.join(tempDir, `avatars-${Date.now()}-${Math.random().toString(36).slice(2)}.db`) });
  const moderation = createWechatImageModeration({ appid: "wx-test", secret: "s", apiBase: moderationBase });
  const service = createAvatarService({
    store,
    moderation,
    putObject,
    deleteObject,
    publicRoot: "https://resources.example.invalid/avatars/",
    rateLimiter,
    sharpImpl: sharp,
    now,
  });
  return { store, service };
}

test("upload processes, moderates, stores and registers ownership", async () => {
  await withMockWechat(() => ({ errcode: 0, errmsg: "ok" }), async (base) => {
    const puts = [];
    const { store, service } = makeService({
      moderationBase: base,
      putObject: async (key, buf) => { puts.push([key, buf]); },
    });
    const result = await service.upload({ userId: 7, buffer: await testImage() });
    assert.match(result.avatar_url, /^https:\/\/resources\.example\.invalid\/avatars\/[A-Za-z0-9_-]{16,64}\.jpg$/);
    assert.equal(puts.length, 1);
    assert.match(puts[0][0], /^avatars\/[A-Za-z0-9_-]{16,64}\.jpg$/);
    const meta = await sharp(puts[0][1]).metadata();
    assert.equal(meta.format, "jpeg", "PNG/JPEG 一律重编码为 JPEG");
    assert.equal(meta.width, 256);
    assert.equal(meta.height, 256);
    const id = result.avatar_url.split("/").pop().replace(/\.jpg$/, "");
    assert.equal(store.bindable({ userId: 7, id }).id, id, "本人可绑定");
    assert.equal(store.bindable({ userId: 8, id }), null, "他人不可绑定");
  });
});

test("upload rejects invalid image, oversize bytes and oversize pixels with distinct codes", async () => {
  await withMockWechat(() => ({ errcode: 0 }), async (base) => {
    const { service } = makeService({ moderationBase: base, putObject: async () => {} });
    await assert.rejects(service.upload({ userId: 1, buffer: Buffer.from("not an image at all") }), (error) => error.code === "AVATAR_INVALID_IMAGE" && error.statusCode === 400);
    await assert.rejects(service.upload({ userId: 1, buffer: Buffer.alloc(AVATAR_MAX_BYTES + 1, 1) }), (error) => error.code === "AVATAR_TOO_LARGE" && error.statusCode === 413);
    await assert.rejects(service.upload({ userId: 1, buffer: await testImage({ width: 5000, height: 20 }) }), (error) => error.code === "AVATAR_TOO_LARGE" && error.statusCode === 413);
    await assert.rejects(service.upload({ userId: 1, buffer: Buffer.alloc(0) }), (error) => error.code === "AVATAR_INVALID_IMAGE");
  });
});

test("moderation verdicts map to content-rejected and service-unavailable", async () => {
  let verdictCount = 0;
  await withMockWechat(() => {
    verdictCount += 1;
    return verdictCount === 1 ? { errcode: 0, errmsg: "ok" } : { errcode: 87014, errmsg: "risky" };
  }, async (base) => {
    const { service } = makeService({ moderationBase: base, putObject: async () => {} });
    const normal = await service.upload({ userId: 1, buffer: await testImage() });
    assert.ok(normal.avatar_url);
    await assert.rejects(service.upload({ userId: 1, buffer: await testImage() }), (error) => error.code === "AVATAR_CONTENT_REJECTED" && error.statusCode === 403);
  });
  await withMockWechat(() => ({ errcode: -1, errmsg: "system busy" }), async (base) => {
    const { service } = makeService({ moderationBase: base, putObject: async () => {} });
    await assert.rejects(service.upload({ userId: 1, buffer: await testImage() }), (error) => error.code === "AVATAR_UPLOAD_UNAVAILABLE" && error.statusCode === 503);
  });
});

test("per-user daily quota yields RATE_LIMITED", async () => {
  await withMockWechat(() => ({ errcode: 0 }), async (base) => {
    const calls = [];
    const fakeLimiter = {
      consume({ scope, actorHash }) {
        calls.push(`${scope}:${actorHash}`);
        return { allowed: calls.length < 3 };
      },
    };
    const { service } = makeService({ moderationBase: base, putObject: async () => {}, rateLimiter: fakeLimiter });
    await service.upload({ userId: 3, buffer: await testImage() });
    await service.upload({ userId: 3, buffer: await testImage() });
    await assert.rejects(service.upload({ userId: 3, buffer: await testImage() }), (error) => error.code === "RATE_LIMITED" && error.statusCode === 429);
  });
});

test("idFromUrl/bind flow marks bound; orphan sweep deletes stale unbound avatars only", async () => {
  await withMockWechat(() => ({ errcode: 0 }), async (base) => {
    const deleted = [];
    let clock = 1_000_000;
    const { store, service } = makeService({
      moderationBase: base,
      putObject: async () => {},
      deleteObject: async (key) => { deleted.push(key); },
      now: () => clock,
    });
    const keep = await service.upload({ userId: 5, buffer: await testImage() });
    const stale = await service.upload({ userId: 5, buffer: await testImage() });
    // 绑定 keep；stale 一直未绑定
    const keepId = service.idFromUrl(keep.avatar_url);
    assert.ok(keepId);
    store.markBound(keepId, { now: clock });
    assert.equal(service.idFromUrl("https://example.com/x.jpg"), null, "外链反解必须为空");
    clock += 48 * 60 * 60 * 1000;
    const removed = await service.sweepOrphans({ ttlMs: 24 * 60 * 60 * 1000 });
    assert.equal(removed, 1);
    assert.deepEqual(deleted, [`avatars/${service.idFromUrl(stale.avatar_url)}.jpg`]);
    assert.equal(store.getById(keepId).bound_at > 0, true, "已绑定头像不被回收");
    assert.equal(store.getById(service.idFromUrl(stale.avatar_url)), null);
  });
});
