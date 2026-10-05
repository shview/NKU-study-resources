import { createHash } from "node:crypto";
import { reviewKeywordMatch } from "./review-keyword-filter.mjs";

export const MODERATION_SCHEMA_VERSION = 2;
export const HANDLING_STATUSES = Object.freeze(["open", "processing", "completed", "rejected", "parked"]);
export const PUBLICATION_STATES = Object.freeze(["pending", "approved", "rejected"]);
export const SERVER_ACTOR_FIELDS = Object.freeze(["updatedBy", "updatedAt", "handledBy", "handledAt", "reviewedBy", "reviewedAt", "repliedBy", "repliedAt"]);
export const LEGACY_ACTOR_ALIASES = Object.freeze(["updated_by", "updated_at", "handled_by", "handled_at", "reviewed_by", "reviewed_at", "replied_by", "replied_at"]);

const REACTION_FIELDS = new Set(["helpfulBy", "helpfulCount", "helpful_count", "viewer_reaction", "reactionCount", "reactionCounts", "reactions", "publicEligible"]);
const REPORT_FIELDS = ["report_url", "report_target", "reportUrl", "reportTarget"];
const CONFIGURATION_SOURCES = new Set(["legacy_configuration_import", "admin_settings"]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function moderationHash(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value)) ?? "null").digest("hex");
}

export function moderationDocumentRevision(document) {
  return moderationHash(document);
}

export function itemRevision(item) {
  return moderationHash(Object.fromEntries(Object.entries(item).filter(([key]) => !REACTION_FIELDS.has(key) && key !== "status")));
}

export function moderationSettings(document, kind = "feedback") {
  return kind === "reviews"
    ? { rules: structuredClone(document.rules || {}) }
    : { title: document.title || "", announcement: document.announcement || "", rules: structuredClone(document.rules || {}) };
}

export function settingsRevision(document, kind = "feedback") {
  return moderationHash(moderationSettings(document, kind));
}

function timestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

function nowValue(nowIso) {
  const now = typeof nowIso === "function" ? nowIso() : nowIso || new Date().toISOString();
  if (!timestamp(now)) throw new Error("A valid server timestamp is required.");
  return now;
}

function documentError(message) {
  const error = new Error(message);
  error.statusCode = 500;
  error.code = "INVALID_MODERATION_DOCUMENT";
  return error;
}

export function knownReportOrigin(item) {
  return item?.private === true
    || ["report", "complaint"].includes(String(item?.type || "").trim().toLowerCase())
    || REPORT_FIELDS.some((key) => String(item?.[key] ?? "").trim() !== "");
}

export function createRulesProvenance(rules, { nowIso, actor = null, source = actor ? "admin_settings" : "legacy_configuration_import" } = {}) {
  const snapshot = structuredClone(rules || {});
  return { snapshot, hash: moderationHash(snapshot), source, configuredAt: nowValue(nowIso), configuredBy: actor || null };
}

export function validRulesProvenance(provenance, rules = provenance?.snapshot) {
  return !!provenance && CONFIGURATION_SOURCES.has(provenance.source)
    && timestamp(provenance.configuredAt)
    && provenance.hash === moderationHash(provenance.snapshot)
    && provenance.hash === moderationHash(rules || {})
    && (provenance.source !== "admin_settings" || typeof provenance.configuredBy === "string" && provenance.configuredBy.trim() !== "");
}

/** The configured automatic policy remains the same as the pre-S3 submission rule. */
export function reviewPublicationFields({ rules = {}, rulesProvenance, content = "", now, nowIso } = {}) {
  const decisionTime = nowValue(now || nowIso);
  const provenance = validRulesProvenance(rulesProvenance, rules)
    ? rulesProvenance : createRulesProvenance(rules, { nowIso: decisionTime });
  const keywordHits = rules.keywordFilter?.enabled === true
    ? reviewKeywordMatch(content, Array.isArray(rules.keywordFilter.words) ? rules.keywordFilter.words : []) : [];
  const pending = !!rules.moderationRequired || keywordHits.length > 0;
  return {
    schemaVersion: MODERATION_SCHEMA_VERSION,
    publicationState: pending ? "pending" : "approved",
    status: pending ? "pending" : "approved",
    decisionSource: "automatic_rules",
    reviewedBy: "system",
    reviewedAt: decisionTime,
    ruleSnapshot: structuredClone(provenance.snapshot),
    ruleHash: provenance.hash,
    ruleSource: provenance.source,
    ruleConfiguredAt: provenance.configuredAt,
    ruleConfiguredBy: provenance.configuredBy,
    ...(keywordHits.length ? { flagged: keywordHits.join("|").slice(0, 80) } : {}),
  };
}

export function newFeedbackModerationFields({ type = "general", now, nowIso, private: isPrivate = false } = {}) {
  const complaint = isPrivate || ["report", "complaint"].includes(String(type).trim().toLowerCase());
  return {
    schemaVersion: MODERATION_SCHEMA_VERSION,
    private: complaint,
    privacySource: complaint ? "server_report_submission" : "server_feedback_submission",
    publicationBlocked: false,
    handlingStatus: "open",
    publicationState: "pending",
    status: "open",
    hidden: false,
    replyVisibility: "submitter",
    decisionSource: "submission_pending",
    ...(now || nowIso ? { updatedAt: nowValue(now || nowIso) } : {}),
  };
}

export function validServerApproval(item) {
  if (item?.schemaVersion !== MODERATION_SCHEMA_VERSION || item.publicationState !== "approved" || !timestamp(item.reviewedAt)) return false;
  if (item.decisionSource === "admin_decision") return typeof item.reviewedBy === "string" && item.reviewedBy.trim() !== "";
  if (item.decisionSource === "legacy_visibility_import") {
    return (Object.hasOwn(item, "courseTitle") || Object.hasOwn(item, "teacher"))
      && ["approved", "通过"].includes(String(item.legacyStatus || "").trim()) && item.reviewedBy === "system";
  }
  if (item.decisionSource !== "automatic_rules" || item.reviewedBy !== "system" || !(Object.hasOwn(item, "courseTitle") || Object.hasOwn(item, "teacher"))) return false;
  const provenance = { snapshot: item.ruleSnapshot, hash: item.ruleHash, source: item.ruleSource, configuredAt: item.ruleConfiguredAt, configuredBy: item.ruleConfiguredBy };
  if (!validRulesProvenance(provenance) || item.ruleSnapshot?.moderationRequired) return false;
  return item.ruleSnapshot?.keywordFilter?.enabled !== true
    || reviewKeywordMatch(item.content, Array.isArray(item.ruleSnapshot.keywordFilter.words) ? item.ruleSnapshot.keywordFilter.words : []).length === 0;
}

/** Shared fail-closed public gate. Handling, replies and legacy status are never approval evidence. */
export function isPublicEligible(item) {
  const isReview = !!item && (Object.hasOwn(item, "courseTitle") || Object.hasOwn(item, "teacher"));
  const provenFeedbackOrigin = ['server_feedback_submission', 'verified_legacy_feedback_origin'].includes(item?.privacySource);
  return !!item && (isReview || provenFeedbackOrigin) && validServerApproval(item) && !knownReportOrigin(item)
    && item.publicationBlocked !== true && item.hidden !== true;
}

export function isFeedbackPublicEligible(item) {
  return ['server_feedback_submission', 'verified_legacy_feedback_origin'].includes(item?.privacySource)
    && item?.decisionSource !== "legacy_visibility_import" && item?.decisionSource !== "automatic_rules" && isPublicEligible(item);
}

export function isReviewPublicEligible(item) {
  return isPublicEligible(item);
}

function normalizeItem(raw, kind, now) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.id !== "string" || !raw.id.trim()) {
    throw documentError("Moderation items require an existing nonempty string id.");
  }
  if (raw.schemaVersion !== undefined && ![1, MODERATION_SCHEMA_VERSION].includes(raw.schemaVersion)) throw documentError(`Unsupported item schemaVersion for ${raw.id}.`);
  const item = structuredClone(raw);
  delete item.publicEligible;
  for (const field of ['hidden', 'private', 'publicationBlocked']) {
    if (raw[field] !== undefined && typeof raw[field] !== "boolean") throw documentError(`Invalid ${field} for ${raw.id}.`);
  }
  for (const key of LEGACY_ACTOR_ALIASES) delete item[key];
  const legacy = raw.schemaVersion !== MODERATION_SCHEMA_VERSION;
  item.schemaVersion = MODERATION_SCHEMA_VERSION;
  item.hidden = item.hidden === true || legacy && String(item.status || "").trim() === "hidden";
  if (legacy) {
    item.legacyStatus = String(raw.status || "").trim();
    item.publicationState = "pending";
    item.decisionSource = "legacy_unconfirmed";
    // S2 actors remain useful for updates/replies, but they never prove an old publication decision.
    delete item.reviewedBy;
    delete item.reviewedAt;
    if (kind === "reviews" && ["approved", "通过"].includes(item.legacyStatus)) {
      Object.assign(item, { publicationState: "approved", decisionSource: "legacy_visibility_import", reviewedBy: "system", reviewedAt: now });
    }
  } else if (!PUBLICATION_STATES.includes(item.publicationState)) {
    throw documentError(`Invalid publicationState for ${raw.id}.`);
  }
  if (kind === "feedback") {
    if (legacy) {
      item.handlingStatus = HANDLING_STATUSES.includes(item.legacyStatus) ? item.legacyStatus : "open";
      item.replyVisibility = "submitter";
      if (knownReportOrigin(raw)) {
        item.private = true;
        item.privacySource = "legacy_private_origin";
      } else {
        item.publicationBlocked = true;
        item.publicationBlockedReason = "LEGACY_PRIVACY_UNCONFIRMED";
        item.privacySource = "legacy_privacy_unconfirmed";
      }
    }
    if (!HANDLING_STATUSES.includes(item.handlingStatus)) throw documentError(`Invalid handlingStatus for ${raw.id}.`);
    if (knownReportOrigin(item)) {
      item.private = true;
      item.replyVisibility = "submitter";
    } else if (!['server_feedback_submission', 'verified_legacy_feedback_origin'].includes(item.privacySource)) {
      item.publicationBlocked = true;
      item.publicationBlockedReason = "LEGACY_PRIVACY_UNCONFIRMED";
      item.privacySource = "legacy_privacy_unconfirmed";
    }
    if (!['submitter', 'public'].includes(item.replyVisibility)) item.replyVisibility = "submitter";
    item.status = item.handlingStatus;
  } else {
    item.status = item.publicationState;
  }
  return item;
}

/** Pure, idempotent migration; callers must persist it before accepting traffic. */
export function normalizeModerationDocument(data, { kind = "feedback", nowIso, rulesDefaults = {} } = {}) {
  if (!["feedback", "reviews"].includes(kind)) throw new Error("Unknown moderation document kind.");
  if (!data || typeof data !== "object" || Array.isArray(data)) throw documentError("Moderation document must be an object.");
  if (data.version !== undefined && ![1, MODERATION_SCHEMA_VERSION].includes(data.version)) throw documentError("Unsupported moderation document version.");
  if (data.schemaVersion !== undefined && ![1, MODERATION_SCHEMA_VERSION].includes(data.schemaVersion)) throw documentError("Unsupported moderation document schemaVersion.");
  const key = kind === "reviews" ? "reviews" : "items";
  if (data[key] !== undefined && !Array.isArray(data[key])) throw documentError(`${key} must be an array.`);
  if (data.rules !== undefined && (!data.rules || typeof data.rules !== "object" || Array.isArray(data.rules))) throw documentError("Moderation rules must be an object.");
  const now = nowValue(nowIso);
  const document = structuredClone(data);
  for (const alias of LEGACY_ACTOR_ALIASES) delete document[alias];
  document.version = MODERATION_SCHEMA_VERSION;
  document.schemaVersion = MODERATION_SCHEMA_VERSION;
  document.rules = { ...structuredClone(rulesDefaults), ...document.rules };
  if (!validRulesProvenance(document.rulesProvenance, document.rules)) {
    document.rulesProvenance = createRulesProvenance(document.rules, { nowIso: now });
  }
  document[key] = (document[key] || []).map((item) => normalizeItem(item, kind, now));
  const ids = new Set();
  for (const item of document[key]) {
    if (ids.has(item.id)) throw documentError(`Duplicate moderation item id: ${item.id}.`);
    ids.add(item.id);
  }
  return document;
}

export const migrateModerationDocument = normalizeModerationDocument;
export const normalizeFeedbackDocument = (data, options = {}) => normalizeModerationDocument(data, { ...options, kind: "feedback" });
export const normalizeReviewsDocument = (data, options = {}) => normalizeModerationDocument(data, { ...options, kind: "reviews" });
