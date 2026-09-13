import { randomBytes } from "node:crypto";

/**
 * 内容图片（关于/参与/公告等 markdown 字段的插图）：
 * R2 独立前缀 content/<owner>/，与课程资料 resources/ 隔离；
 * 归属白名单 = 内容 JSON 文件名，删除对比只在同归属内进行，避免误删他页引用。
 */
export const CONTENT_IMAGE_OWNERS = Object.freeze(["home", "about", "participate", "footer", "reviews", "feedback"]);

const IMAGE_MIME_TYPES = Object.freeze({
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
});

export const CONTENT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

export function contentImagePrefix(owner) {
  if (!CONTENT_IMAGE_OWNERS.includes(owner)) throw new Error(`Unknown content image owner: ${owner}`);
  return `content/${owner}/`;
}

/** 由 manifest.resourceRoot（…/resources/）推导内容图片公开根（…/content/）。 */
export function contentPublicRoot(resourceRoot) {
  const root = String(resourceRoot || "");
  if (!/^https:\/\/[^/]+\/resources\/$/.test(root)) {
    throw new Error("manifest.resourceRoot must look like https://<host>/resources/ to derive the content image root.");
  }
  return root.replace(/\/resources\/$/, "/content/");
}

export function validateContentImage({ mimeType, size }) {
  const ext = IMAGE_MIME_TYPES[String(mimeType || "").toLowerCase()];
  if (!ext) return { ok: false, error: "仅支持 png / jpeg / webp / gif 图片。" };
  if (!Number.isFinite(size) || size <= 0 || size > CONTENT_IMAGE_MAX_BYTES) {
    return { ok: false, error: "图片大小需在 8MB 以内。" };
  }
  return { ok: true, ext };
}

export function newContentImageName(ext) {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `${stamp}-${randomBytes(6).toString("hex")}.${ext}`;
}

/**
 * 从任意内容对象（JSON 序列化后）提取引用的内容图片 key。
 * 只认本归属前缀的绝对 URL，防止 about 的保存动作波及别的归属。
 */
export function extractContentImageKeys(contentObject, owner, publicRoot) {
  const prefix = contentImagePrefix(owner);
  // publicRoot 已含 /content/，URL 形态为 <publicRoot><owner>/<name>
  const urlPrefix = `${publicRoot}${owner}/`;
  const keys = new Set();
  const text = JSON.stringify(contentObject ?? "") || "";
  const pattern = new RegExp(`${urlPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([A-Za-z0-9._-]{1,120})`, "g");
  for (const match of text.matchAll(pattern)) {
    const name = match[1];
    // 文件名由服务端生成（日期-随机串.扩展名），拒绝路径形态
    if (/^[A-Za-z0-9._-]+$/.test(name) && !name.includes("..")) keys.add(`${prefix}${name}`);
  }
  return keys;
}

/** 旧内容引用减去新内容引用 = 保存后应删除的孤儿 key。 */
export function orphanContentImageKeys(oldObject, nextObject, owner, publicRoot) {
  const oldKeys = extractContentImageKeys(oldObject, owner, publicRoot);
  const nextKeys = extractContentImageKeys(nextObject, owner, publicRoot);
  return [...oldKeys].filter((key) => !nextKeys.has(key)).sort();
}
