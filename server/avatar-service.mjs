import { randomBytes } from "node:crypto";

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB
export const AVATAR_MAX_DIM = 4096;
export const AVATAR_OUTPUT_SIZE = 256;
export const AVATAR_EXTENSIONS = [".jpg", ".jpeg", ".png"];

export class AvatarError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * 头像上传服务：Busboy 接收（admin-server 注入）→ sharp 解码校验/重编码
 * （剥离 EXIF 等元信息、居中裁剪 256px JPEG）→ 微信同步图片审核 → R2 avatars/
 * 前缀直链（Cloudflare CDN 承担下载带宽）→ 登记归属。上传不自动绑定资料。
 */
export function createAvatarService({
  store,
  moderation,
  putObject,
  deleteObject = null,
  publicRoot,
  rateLimiter = null,
  rateLimit = { perUserPerDay: 5 },
  sharpImpl = null,
  now = () => Date.now(),
}) {
  if (!store || !moderation || typeof putObject !== "function" || !publicRoot) {
    throw new Error("AvatarService requires store, moderation, putObject and publicRoot.");
  }
  const sharp = sharpImpl;
  if (!sharp) throw new Error("AvatarService requires a sharp implementation.");

  function assertQuota(userId) {
    if (!rateLimiter) return;
    const consumed = rateLimiter.consume({
      scope: "avatar-upload",
      actorHash: `u${Number(userId)}`,
      limits: [{ windowMs: 24 * 60 * 60 * 1000, max: rateLimit.perUserPerDay }],
      now: now(),
    });
    if (consumed.allowed !== true) {
      throw new AvatarError("RATE_LIMITED", "头像上传过于频繁，请明天再试。", 429);
    }
  }

  async function processImage(buffer) {
    let image;
    try {
      image = sharp(buffer, { failOn: "error", limitInputPixels: AVATAR_MAX_DIM * AVATAR_MAX_DIM });
      const meta = await image.metadata();
      if (!meta.width || !meta.height) throw new Error("no dimensions");
      if (meta.width > AVATAR_MAX_DIM || meta.height > AVATAR_MAX_DIM) {
        throw new AvatarError("AVATAR_TOO_LARGE", `图片尺寸不能超过 ${AVATAR_MAX_DIM}×${AVATAR_MAX_DIM} 像素。`, 413);
      }
    } catch (error) {
      if (error instanceof AvatarError) throw error;
      if (/pixel limit|exceeds/i.test(String(error?.message || ""))) {
        throw new AvatarError("AVATAR_TOO_LARGE", `图片尺寸不能超过 ${AVATAR_MAX_DIM}×${AVATAR_MAX_DIM} 像素。`, 413);
      }
      throw new AvatarError("AVATAR_INVALID_IMAGE", "请上传有效的 JPEG 或 PNG 图片。", 400);
    }
    // 重编码即剥离全部元信息（EXIF/GPS 等），并规范化为 256px 方形 JPEG
    const output = await image
      .resize(AVATAR_OUTPUT_SIZE, AVATAR_OUTPUT_SIZE, { fit: "cover", position: "centre" })
      .jpeg({ quality: 82, progressive: false })
      .toBuffer();
    return output;
  }

  async function moderate(buffer) {
    try {
      const verdict = await moderation.check(buffer, { filename: "avatar.jpg", contentType: "image/jpeg" });
      if (!verdict.approved) {
        throw new AvatarError("AVATAR_CONTENT_REJECTED", "图片未通过安全审核，请更换图片。", 403);
      }
    } catch (error) {
      if (error instanceof AvatarError) throw error;
      throw new AvatarError("AVATAR_UPLOAD_UNAVAILABLE", "审核服务暂时不可用，请稍后重试。", 503);
    }
  }

  async function sweepOrphans({ ttlMs = 24 * 60 * 60 * 1000 } = {}) {
    if (typeof deleteObject !== "function") return 0;
    let removed = 0;
    for (const id of store.orphanIds({ before: now(), ttlMs })) {
      try {
        await deleteObject(avatarKey(id));
        store.remove(id);
        removed += 1;
      } catch {
        break; // 删除失败留待下轮
      }
    }
    return removed;
  }

  function avatarKey(id) {
    return `avatars/${id}.jpg`;
  }

  function urlOf(id) {
    return `${publicRoot}${id}.jpg`;
  }

  /** id → URL 反解（绑定校验用）；不匹配本站 avatars 根返回 null。 */
  function idFromUrl(url) {
    const text = String(url || "");
    if (!text.startsWith(publicRoot)) return null;
    const rest = text.slice(publicRoot.length);
    if (!/^[A-Za-z0-9_-]{16,64}\.jpg$/.test(rest)) return null;
    return rest.slice(0, -4);
  }

  return {
    configured: true,
    publicRoot,
    assertQuota,
    urlOf,
    idFromUrl,
    processImage,
    moderate,
    avatarKey,
    sweepOrphans,

    /** 完整上传：校验/处理 → 审核 → R2 → 登记。成功返回 { avatar_url }，不自动绑定。 */
    async upload({ userId, buffer }) {
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new AvatarError("AVATAR_INVALID_IMAGE", "缺少文件。", 400);
      }
      if (buffer.length > AVATAR_MAX_BYTES) {
        throw new AvatarError("AVATAR_TOO_LARGE", `图片不能超过 ${Math.floor(AVATAR_MAX_BYTES / 1024 / 1024)} MiB。`, 413);
      }
      assertQuota(userId);
      const processed = await processImage(buffer);
      await moderate(processed);
      const id = randomBytes(16).toString("base64url");
      try {
        await putObject(avatarKey(id), processed);
      } catch (error) {
        throw new AvatarError("AVATAR_UPLOAD_UNAVAILABLE", "存储服务暂时不可用，请稍后重试。", 503);
      }
      store.register({ id, userId, bytes: processed.length, now: now() });
      // 懒回收孤立头像（上传成功但从未绑定的资源）
      sweepOrphans().catch(() => {});
      return { avatar_url: urlOf(id), id };
    },
  };
}
