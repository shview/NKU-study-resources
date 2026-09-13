import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTENT_IMAGE_OWNERS,
  contentImagePrefix,
  contentPublicRoot,
  extractContentImageKeys,
  newContentImageName,
  orphanContentImageKeys,
  validateContentImage,
} from "../server/content-images.mjs";

const ROOT = "https://resources.nkustudy.top/content/";

test("contentPublicRoot derives from manifest resourceRoot strictly", () => {
  assert.equal(contentPublicRoot("https://resources.nkustudy.top/resources/"), ROOT);
  assert.throws(() => contentPublicRoot("http://resources.nkustudy.top/resources/"));
  assert.throws(() => contentPublicRoot("https://resources.nkustudy.top/files/"));
});

test("validateContentImage accepts known image types within the size cap", () => {
  assert.deepEqual(validateContentImage({ mimeType: "image/png", size: 1024 }), { ok: true, ext: "png" });
  assert.deepEqual(validateContentImage({ mimeType: "image/jpeg", size: 1024 }), { ok: true, ext: "jpg" });
  assert.equal(validateContentImage({ mimeType: "image/svg+xml", size: 10 }).ok, false, "svg 拒绝");
  assert.equal(validateContentImage({ mimeType: "image/png", size: 9 * 1024 * 1024 }).ok, false, "超 8MB 拒绝");
  assert.equal(validateContentImage({ mimeType: "image/png", size: 0 }).ok, false);
});

test("newContentImageName is flat, random and extension-safe", () => {
  const first = newContentImageName("png");
  const second = newContentImageName("png");
  assert.match(first, /^[0-9]{8}-[0-9a-f]{12}\.png$/);
  assert.notEqual(first, second);
});

test("extractContentImageKeys only honors same-owner absolute URLs", () => {
  const owner = "about";
  const content = {
    body: `![a](${ROOT}about/20260910-abcdef123456.png) ![b](${ROOT}home/20260910-other.png) text`,
    nested: { note: `${ROOT}about/20260911-112233445566.webp` },
    danger: `${ROOT}about/../evil.png`,
  };
  const keys = extractContentImageKeys(content, owner, ROOT);
  assert.deepEqual([...keys].sort(), ["content/about/20260910-abcdef123456.png", "content/about/20260911-112233445566.webp"]);
});

test("orphanContentImageKeys computes old-minus-next within the owner", () => {
  const oldContent = { body: `![](${ROOT}about/a1.png) ![](${ROOT}about/a2.png)` };
  const nextContent = { body: `![](${ROOT}about/a2.png)` };
  assert.deepEqual(orphanContentImageKeys(oldContent, nextContent, "about", ROOT), ["content/about/a1.png"]);
  assert.deepEqual(orphanContentImageKeys(nextContent, oldContent, "about", ROOT), []);
  // 其他归属的同名图片不受波及
  const withOtherOwner = { body: oldContent.body, extra: `![](${ROOT}home/a1.png)` };
  assert.deepEqual(orphanContentImageKeys(withOtherOwner, nextContent, "about", ROOT), ["content/about/a1.png"]);
});

test("owner whitelist guards the prefix helper", () => {
  assert.equal(contentImagePrefix("home"), "content/home/");
  assert.throws(() => contentImagePrefix("evil"));
  assert.ok(CONTENT_IMAGE_OWNERS.includes("reviews"));
});
