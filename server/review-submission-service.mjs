import { randomBytes } from "node:crypto";
import { PublicApiError } from "./public-api-errors.mjs";

function cleanText(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

function cleanTags(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((tag) => cleanText(tag, 40)).filter(Boolean))].slice(0, 12);
}

/**
 * Shared write boundary for the website and mini-program review submissions.
 * Both callers consume the same persistent limits and append to the same
 * reviews.json queue.
 */
export class ReviewSubmissionService {
  constructor({
    store,
    reviewsPath,
    readReviews,
    consumeAttempt,
    consumeSubmission,
    actorHash,
    nowIso = () => new Date().toISOString(),
    today = () => new Date().toISOString().slice(0, 10),
    createId = () => `review-${Date.now()}-${randomBytes(4).toString("hex")}`,
  } = {}) {
    if (!store || !reviewsPath || !readReviews || !consumeAttempt || !consumeSubmission || !actorHash) {
      throw new Error("ReviewSubmissionService dependencies are required.");
    }
    this.store = store;
    this.reviewsPath = reviewsPath;
    this.readReviews = readReviews;
    this.consumeAttempt = consumeAttempt;
    this.consumeSubmission = consumeSubmission;
    this.actorHash = actorHash;
    this.nowIso = nowIso;
    this.today = today;
    this.createId = createId;
  }

  assertAttempt(clientIp) {
    if (!this.consumeAttempt(clientIp)) {
      throw new PublicApiError(429, "请求太频繁，请稍后再试。", "RATE_LIMITED");
    }
  }

  async submit(input, { clientIp, userAgent } = {}) {
    const data = this.readReviews();
    const rules = data.rules || {};
    if (!rules.submissionOpen) {
      throw new PublicApiError(409, "评价提交暂未开放。", "SUBMISSION_CLOSED");
    }
    if (input?.website) return { pending: true };

    const courseTitle = cleanText(input?.courseTitle, 120);
    const teacher = cleanText(input?.teacher, 80);
    const content = cleanText(input?.content, 2000);
    const rating = Number(input?.rating);
    const tags = cleanTags(input?.tags);
    const minimumLength = Math.max(1, Number(rules.minLength || 12));
    if (!courseTitle || !teacher || !Number.isInteger(rating) || rating < 1 || rating > 5 || content.length < minimumLength) {
      throw new PublicApiError(400, "请填写课程、老师、1 至 5 分的评分，并补充更完整的评价内容。", "INVALID_REVIEW");
    }
    if (!this.consumeSubmission(clientIp, rules)) {
      throw new PublicApiError(429, "提交太频繁，请稍后再试。", "RATE_LIMITED");
    }

    const now = this.nowIso();
    const review = {
      id: this.createId(),
      courseTitle,
      teacher,
      rating,
      ...(tags.length ? { tags } : {}),
      content,
      status: rules.moderationRequired ? "pending" : "approved",
      hidden: false,
      createdAt: now,
      updatedAt: now,
      ipHash: this.actorHash(clientIp),
      userAgent: cleanText(userAgent, 240),
    };
    await this.store.update(this.reviewsPath, (current) => {
      current.reviews = Array.isArray(current.reviews) ? current.reviews : [];
      current.reviews.unshift(review);
      current.updated = this.today();
      return current;
    }, { mode: 0o600 });
    return { pending: review.status === "pending" };
  }
}
