import assert from "node:assert/strict";
import test from "node:test";
import { ReviewSubmissionService } from "../server/review-submission-service.mjs";

function fixture() {
  const data = {
    rules: { submissionOpen: true, moderationRequired: true, minLength: 12 },
    reviews: [
      { id: "review-1", courseTitle: "中文课程", teacher: "张老师", rating: 5, content: "正文", status: "approved", hidden: false },
      { id: "review-2", courseTitle: "历史课程", teacher: "李老师", rating: 4, content: "正文", status: "approved", hidden: false },
    ],
  };
  const store = {
    async update(path, mutator) {
      return mutator(data);
    },
  };
  const service = new ReviewSubmissionService({
    store,
    reviewsPath: "reviews.json",
    readReviews: () => data,
    consumeAttempt: () => true,
    consumeSubmission: () => true,
    actorHash: (ip) => `hash:${ip}`,
  });
  return { service, data };
}

test("helpful reaction marks, dedupes and cancels per user", async () => {
  const { service, data } = fixture();

  const marked = await service.reactHelpful("review-1", 7, "up");
  assert.equal(marked.review_id, "review-1");
  assert.equal(marked.helpful_count, 1);
  assert.equal(marked.viewer_reaction, "up");

  const again = await service.reactHelpful("review-1", 7, "up");
  assert.equal(again.helpful_count, 1, "same user marking again stays idempotent");

  const secondUser = await service.reactHelpful("review-1", 9, "up");
  assert.equal(secondUser.helpful_count, 2);

  const cancelled = await service.reactHelpful("review-1", 7, null);
  assert.equal(cancelled.helpful_count, 1);
  assert.equal(cancelled.viewer_reaction, null);

  const stored = data.reviews.find((review) => review.id === "review-1");
  assert.deepEqual(stored.helpfulBy, [9]);
  assert.equal(stored.helpfulCount, 1);
  assert.equal(stored.updatedAt, undefined, "reactions never masquerade as content edits");
});

test("helpful reaction rejects down votes and unknown reviews", async () => {
  const { service } = fixture();
  await assert.rejects(() => service.reactHelpful("review-1", 7, "down"), /仅支持「有帮助」/);
  await assert.rejects(() => service.reactHelpful("review-1", 0, "up"), /登录/);
  assert.equal(await service.reactHelpful("missing-review", 7, "up"), null);
});
