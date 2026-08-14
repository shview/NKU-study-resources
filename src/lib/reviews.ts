import reviewData from "../data/reviews.json";

export type Review = {
  id: string;
  courseTitle: string;
  teacher: string;
  rating: number | string;
  content: string;
  status?: string;
  hidden?: boolean;
  createdAt?: string;
};

type ReviewStore = {
  reviews: Review[];
};

export type ReviewGroup = {
  key: string;
  courseTitle: string;
  teacher: string;
  reviews: Review[];
  average: number;
  counts: Record<number, number>;
};

export const reviews = (reviewData as ReviewStore).reviews ?? [];

export function reviewKey(review: Pick<Review, "courseTitle" | "teacher">) {
  return `${review.courseTitle}-${review.teacher}`;
}

export function reviewPath(key: string) {
  return `/reviews/${encodeURIComponent(key)}/`;
}

export function approvedReviews(items: Review[] = reviews) {
  return items.filter((review) => ["approved", "通过"].includes(String(review.status || "").trim()) && !review.hidden);
}

export function ratingCounts(items: Review[]) {
  const counts: Record<number, number> = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  for (const review of items) {
    const rating = Math.max(1, Math.min(5, Number(review.rating || 0)));
    if (Number.isFinite(rating)) counts[rating] += 1;
  }
  return counts;
}

export function averageRating(items: Review[]) {
  if (!items.length) return 0;
  const total = items.reduce((sum, review) => sum + Number(review.rating || 0), 0);
  return total / items.length;
}

export function groupReviews(items: Review[] = approvedReviews()) {
  const groups = new Map<string, Review[]>();
  for (const review of items) {
    const key = reviewKey(review);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push(review);
  }
  return Array.from(groups, ([key, group]) => ({
    key,
    courseTitle: group[0]?.courseTitle ?? "",
    teacher: group[0]?.teacher ?? "",
    reviews: group.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""))),
    average: averageRating(group),
    counts: ratingCounts(group),
  })).sort((a, b) => b.reviews.length - a.reviews.length || b.average - a.average || a.key.localeCompare(b.key, "zh-CN"));
}
