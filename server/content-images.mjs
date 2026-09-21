import { randomBytes } from "node:crypto";

/**
 * 内容图片（关于/参与/公告等 markdown 字段的插图）：
 * R2 独立前缀 content/<owner>/，与课程资料 resources/ 隔离；
 * 归属白名单 = 内容 JSON 文件名，删除对比只在同归属内进行，避免误删他页引用。
 */
export const CONTENT_IMAGE_OWNERS = Object.freeze(["home", "about", "participate", "footer", "reviews", "feedback", "links", "donate"]);

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

/** 魔数嗅探：声明类型必须与实际文件头一致，防止伪装成图片上传任意内容。 */
export function sniffImageType(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6) {
    const head = bytes.subarray(0, 6).toString("latin1");
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

export function validateContentImage({ mimeType, size, buffer }) {
  const ext = IMAGE_MIME_TYPES[String(mimeType || "").toLowerCase()];
  if (!ext) return { ok: false, error: "仅支持 png / jpeg / webp / gif 图片。" };
  if (!Number.isFinite(size) || size <= 0 || size > CONTENT_IMAGE_MAX_BYTES) {
    return { ok: false, error: "图片大小需在 8MB 以内。" };
  }
  if (buffer !== undefined) {
    const sniffed = sniffImageType(buffer);
    if (!sniffed) return { ok: false, error: "文件内容不是有效的图片。" };
    const declared = String(mimeType || "").toLowerCase() === "image/jpg" ? "image/jpeg" : String(mimeType || "").toLowerCase();
    if (sniffed !== declared) return { ok: false, error: "文件内容与声明的图片类型不一致。" };
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

/** 单次保存最多迁移的 base64 图片数，防止一次性塞入巨量内容。 */
export const CONTENT_IMAGE_MIGRATE_LIMIT = 5;

const DATA_URI_PATTERN = /data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]{16,})/g;

/** 深度遍历内容对象，收集全部 base64 数据 URI（按出现顺序去重）。 */
export function extractDataUriImages(contentObject) {
  const found = new Map();
  const visit = (value) => {
    if (typeof value === "string") {
      for (const match of value.matchAll(DATA_URI_PATTERN)) {
        const uri = match[0];
        if (!found.has(uri)) found.set(uri, { mime: match[1] === "jpg" || match[1] === "jpeg" ? "image/jpeg" : `image/${match[1]}`, base64: match[2] });
      }
      return;
    }
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value && typeof value === "object") { Object.values(value).forEach(visit); }
  };
  visit(contentObject);
  return [...found.entries()].map(([uri, info]) => ({ uri, ...info }));
}

/** 深度替换字符串中的数据 URI 为直链。 */
export function replaceDataUriImages(contentObject, replacements) {
  const map = new Map(replacements);
  const walk = (value) => {
    if (typeof value === "string") {
      let next = value;
      for (const [uri, url] of map) next = next.split(uri).join(url);
      return next;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      for (const key of Object.keys(value)) value[key] = walk(value[key]);
      return value;
    }
    return value;
  };
  return walk(contentObject);
}
