import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTENT_IMAGE_OWNERS,
  CONTENT_IMAGE_MIGRATE_LIMIT,
  extractDataUriImages,
  replaceDataUriImages,
  sniffImageType,
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

const PNG_BYTES = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("sniffImageType detects real image signatures", () => {
  assert.equal(sniffImageType(PNG_BYTES), "image/png");
  assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImageType(Buffer.from("GIF89a1")), "image/gif");
  assert.equal(sniffImageType(Buffer.concat([Buffer.from("RIFF0000"), Buffer.from("WEBP")])), "image/webp");
  assert.equal(sniffImageType(Buffer.from("<?php echo 1;")), null);
});

test("validateContentImage rejects spoofed content types via magic bytes", () => {
  const spoofed = validateContentImage({ mimeType: "image/png", size: 13, buffer: Buffer.from("<?php echo 1;") });
  assert.equal(spoofed.ok, false);
  assert.match(spoofed.error, /不是有效的图片/);
  const mismatch = validateContentImage({ mimeType: "image/png", size: PNG_BYTES.length, buffer: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(10)]) });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /不一致/);
  const good = validateContentImage({ mimeType: "image/png", size: PNG_BYTES.length, buffer: PNG_BYTES });
  assert.equal(good.ok, true);
});

test("extractDataUriImages walks nested content and normalizes jpeg mime", () => {
  const content = {
    announcement: `前文 ![二维码](data:image/png;base64,${"A".repeat(32)}) 后文`,
    nested: { items: [{ note: `data:image/jpeg;base64,${"B".repeat(32)}` }, `data:image/jpg;base64,${"B".repeat(32)}`] },
    plain: "没有图片",
  };
  const images = extractDataUriImages(content);
  assert.equal(images.length, 3, "png + jpeg + jpg 各自独立");
  assert.equal(images[1].mime, "image/jpeg");
  assert.equal(images[2].mime, "image/jpeg", "jpg 归一化为 image/jpeg");
  const replaced = replaceDataUriImages(structuredClone(content), images.map((image, index) => [image.uri, `https://r.example/content/home/img${index}.png`]));
  assert.equal(replaced.announcement.includes("img0.png"), true);
  assert.equal(replaced.nested.items[0].note, "https://r.example/content/home/img1.png");
  assert.equal(JSON.stringify(replaced).includes("base64"), false, "替换后不再残留 base64");
  assert.ok(CONTENT_IMAGE_MIGRATE_LIMIT >= 1);
});
