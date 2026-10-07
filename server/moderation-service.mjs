import {
  HANDLING_STATUSES, SERVER_ACTOR_FIELDS, LEGACY_ACTOR_ALIASES, createRulesProvenance,
  isFeedbackPublicEligible, isReviewPublicEligible, itemRevision, knownReportOrigin,
  moderationDocumentRevision, moderationHash, moderationSettings, normalizeModerationDocument, settingsRevision,
} from "./moderation-model.mjs";

const ITEM_CHANGES = { feedback: new Set(["handlingStatus", "hidden", "publicationDecision", "reply", "replyVisibility"]), reviews: new Set(["hidden", "publicationDecision"]) };
const COMMON_RULES = new Set(["submissionOpen", "hourlyLimit", "dailyLimit", "minLength", "notes"]);
const REVIEW_RULES = new Set([...COMMON_RULES, "moderationRequired", "turnstileEnabled", "submissionOptions", "announcement", "keywordFilter"]);
const TOP_METADATA = new Set(["updated", "updatedBy", "updatedAt", "settingsUpdatedBy", "settingsUpdatedAt", "settings_updated_by", "settings_updated_at", "rulesProvenance", ...LEGACY_ACTOR_ALIASES]);
const SAFE_STATES = new Set(["handlingStatus", "publicationState", "hidden", "private", "publicationBlocked", "replyVisibility"]);
const ACTOR_METADATA = new Set([...SERVER_ACTOR_FIELDS, ...LEGACY_ACTOR_ALIASES]);
const equal = (a, b) => moderationHash(a === undefined ? null : a) === moderationHash(b === undefined ? null : b);
const own = (object, key) => Object.hasOwn(object, key);

export class ModerationError extends Error {
  constructor(statusCode, code, message, details = {}) {
    super(message);
    this.name = "ModerationError";
    this.statusCode = statusCode;
    this.code = code;
    Object.assign(this, details);
  }
}

function invalid(message, code = "INVALID_MODERATION_CHANGE") {
  throw new ModerationError(400, code, message);
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object.`);
  return value;
}

function allowKeys(value, allowed, label) {
  record(value, label);
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(`${label}.${key} is not writable.`, "IMMUTABLE_FIELD");
}

function actorName(actor) {
  const value = typeof actor === "string" ? actor : actor?.username;
  if (typeof value !== "string" || !value.trim() || value.length > 160) invalid("A server-authenticated administrator is required.", "ADMIN_ACTOR_REQUIRED");
  return value;
}

function serverTime(nowIso) {
  const now = typeof nowIso === "function" ? nowIso() : nowIso || new Date().toISOString();
  if (typeof now !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(now) || !Number.isFinite(Date.parse(now))) throw new Error("A valid server timestamp is required.");
  return now;
}

function publicGate(kind, item) {
  return kind === "reviews" ? isReviewPublicEligible(item) : isFeedbackPublicEligible(item);
}

/** Audit names plus small enum/boolean states; never include text, account identity or contact. */
export function moderationAuditChanges(previous, next, id = previous?.id || "settings") {
  const fields = [...new Set([...Object.keys(previous || {}), ...Object.keys(next || {})])]
    .filter((key) => !equal(previous?.[key], next?.[key]));
  if (!fields.length) return [];
  const states = {};
  for (const field of fields) if (SAFE_STATES.has(field)) {
    const safe = (value) => typeof value === "boolean" || ["open", "processing", "completed", "rejected", "parked", "pending", "approved", "submitter", "public"].includes(value) ? value : null;
    states[field] = { before: safe(previous?.[field]), after: safe(next?.[field]) };
  }
  return [{ id, operation: "update", fields, states }];
}

function requireItemToken(body, item) {
  if (typeof body.expectedItemRevision !== "string" || !body.expectedItemRevision) invalid("expectedItemRevision is required.", "ITEM_REVISION_REQUIRED");
  const revision = itemRevision(item);
  if (body.expectedItemRevision !== revision) {
    throw new ModerationError(409, "ITEM_CONFLICT", "This item changed after it was loaded; no changes were written.", { currentItem: structuredClone(item), currentItemRevision: revision });
  }
}

function itemMutation(item, changes, kind, actor, now) {
  allowKeys(changes, ITEM_CHANGES[kind], "changes");
  const next = structuredClone(item);
  if (own(changes, "hidden")) {
    if (typeof changes.hidden !== "boolean") invalid("hidden must be a boolean.");
    next.hidden = changes.hidden;
  }
  if (own(changes, "handlingStatus")) {
    if (!HANDLING_STATUSES.includes(changes.handlingStatus)) invalid("Invalid handlingStatus.");
    if (next.handlingStatus !== changes.handlingStatus) {
      next.handlingStatus = changes.handlingStatus;
      next.handledBy = actor;
      next.handledAt = now;
    }
  }
  if (own(changes, "publicationDecision")) {
    if (!["approve", "reject", "revoke"].includes(changes.publicationDecision)) invalid("Invalid publicationDecision.");
    if (changes.publicationDecision === "approve" && (knownReportOrigin(item) || item.publicationBlocked === true)) {
      invalid("Private or unconfirmed legacy feedback cannot be approved for publication.", "PUBLICATION_BLOCKED");
    }
    next.publicationState = { approve: "approved", reject: "rejected", revoke: "pending" }[changes.publicationDecision];
    next.reviewedBy = actor;
    next.reviewedAt = now;
    next.decisionSource = "admin_decision";
  }
  if (own(changes, "reply")) {
    if (typeof changes.reply !== "string") invalid("reply must be a string.");
    if (changes.reply.length > 2000) invalid("reply exceeds 2000 characters.", "REPLY_TOO_LONG");
    if (changes.reply !== next.reply) {
      next.reply = changes.reply;
      next.repliedBy = actor;
      next.repliedAt = now;
      if (!own(changes, "replyVisibility")) next.replyVisibility = "submitter";
    }
  }
  if (own(changes, "replyVisibility")) {
    if (!["submitter", "public"].includes(changes.replyVisibility)) invalid("Invalid replyVisibility.");
    if (changes.replyVisibility === "public" && !publicGate(kind, next)) invalid("Public replies require an eligible public item.", "PUBLIC_REPLY_NOT_ALLOWED");
    next.replyVisibility = changes.replyVisibility;
  }
  if (kind === "feedback") {
    if (!publicGate(kind, next)) next.replyVisibility = "submitter";
    next.status = next.handlingStatus;
  } else next.status = next.publicationState;
  if (!equal(item, next)) {
    next.updatedBy = actor;
    next.updatedAt = now;
  }
  return next;
}

function settingText(value, max, field) {
  if (typeof value !== "string") invalid(`${field} must be a string.`);
  if (value.length > max) invalid(`${field} exceeds ${max} characters.`, "SETTING_TOO_LONG");
  return value;
}

function rulesMutation(current, incoming, kind) {
  allowKeys(incoming, kind === "reviews" ? REVIEW_RULES : COMMON_RULES, "changes.rules");
  const rules = structuredClone(current || {});
  for (const [key, value] of Object.entries(incoming)) {
    if (["submissionOpen", "moderationRequired", "turnstileEnabled"].includes(key)) {
      if (typeof value !== "boolean") invalid(`${key} must be a boolean.`);
      rules[key] = value;
    } else if (["hourlyLimit", "dailyLimit", "minLength"].includes(key)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > (key === "minLength" ? 2000 : 100000)) invalid(`Invalid ${key}.`);
      rules[key] = value;
    } else if (key === "notes" || key === "announcement") {
      rules[key] = settingText(value, key === "notes" ? 2000 : 4000, key);
    } else if (key === "submissionOptions") {
      allowKeys(value, new Set(["allowCustomCourse", "allowCustomTeacher"]), "changes.rules.submissionOptions");
      rules[key] = { ...rules[key] };
      for (const [option, enabled] of Object.entries(value)) {
        if (typeof enabled !== "boolean") invalid(`${option} must be a boolean.`);
        rules[key][option] = enabled;
      }
    } else if (key === "keywordFilter") {
      allowKeys(value, new Set(["enabled", "words"]), "changes.rules.keywordFilter");
      rules[key] = { ...rules[key] };
      if (own(value, "enabled")) {
        if (typeof value.enabled !== "boolean") invalid("keywordFilter.enabled must be a boolean.");
        rules[key].enabled = value.enabled;
      }
      if (own(value, "words")) {
        if (!Array.isArray(value.words) || value.words.length > 200 || value.words.some((word) => typeof word !== "string" || word.length > 100)) invalid("keywordFilter.words must contain at most 200 strings of at most 100 characters.");
        rules[key].words = [...new Set(value.words.map((word) => word.trim()).filter(Boolean))];
      }
    }
  }
  return rules;
}

/** Runs synchronously against the document already held by the caller's file lock. */
export function patchSettingsDocument(current, body, actor, { kind = "feedback", nowIso } = {}) {
  allowKeys(body, new Set(["expectedSettingsRevision", "changes"]), "body");
  const changes = record(body.changes, "changes");
  allowKeys(changes, new Set(kind === "reviews" ? ["rules"] : ["title", "announcement", "rules"]), "changes");
  if (typeof body.expectedSettingsRevision !== "string" || !body.expectedSettingsRevision) invalid("expectedSettingsRevision is required.", "SETTINGS_REVISION_REQUIRED");
  const revision = settingsRevision(current, kind);
  if (body.expectedSettingsRevision !== revision) {
    throw new ModerationError(409, "SETTINGS_CONFLICT", "These settings changed after they were loaded; no changes were written.", { currentSettings: moderationSettings(current, kind), currentSettingsRevision: revision });
  }
  const username = actorName(actor);
  const now = serverTime(nowIso);
  const next = structuredClone(current);
  if (own(changes, "title")) next.title = settingText(changes.title, 120, "title");
  if (own(changes, "announcement")) next.announcement = settingText(changes.announcement, 4000, "announcement");
  if (own(changes, "rules")) next.rules = rulesMutation(current.rules, changes.rules, kind);
  if (!equal(current.rules, next.rules)) next.rulesProvenance = createRulesProvenance(next.rules, { nowIso: now, actor: username });
  const beforeSettings = moderationSettings(current, kind);
  const afterSettings = moderationSettings(next, kind);
  const auditChanges = moderationAuditChanges(beforeSettings, afterSettings, "settings");
  if (auditChanges.length) {
    next.updated = now.slice(0, 10);
    next.settingsUpdatedBy = username;
    next.settingsUpdatedAt = now;
  }
  return {
    document: next, scope: "settings",
    result: { data: afterSettings, settingsRevision: settingsRevision(next, kind), rulesProvenance: structuredClone(next.rulesProvenance), changes: auditChanges, ...(kind === "reviews" ? { effectivePublicationMode: next.rules.moderationRequired ? "manual_review" : "configured_automatic_publication" } : {}) },
  };
}

function legacyItemDelta(previous, incoming, kind, warnings) {
  record(incoming, "data item");
  const changes = {};
  const keys = new Set([...Object.keys(previous), ...Object.keys(incoming)]);
  for (const key of keys) {
    if (ACTOR_METADATA.has(key) || key === "publicEligible") {
      if (own(incoming, key) && !equal(previous[key], incoming[key])) warnings.add("Client actor/time metadata was ignored.");
      continue;
    }
    if (equal(previous[key], incoming[key])) continue;
    if (key === "status") {
      if (!own(incoming, key)) continue;
      const value = String(incoming.status || "").trim();
      if (["approved", "通过"].includes(value)) invalid("Legacy status cannot approve publication; use publicationDecision.", "LEGACY_PUBLICATION_DECISION_REQUIRED");
      if (kind === "feedback" && HANDLING_STATUSES.includes(value)) changes.handlingStatus = value;
      else if (kind === "reviews" && ["pending", "rejected"].includes(value)) changes.publicationDecision = value === "pending" ? "revoke" : "reject";
      else if (value === "hidden") changes.hidden = true;
      else invalid("Invalid legacy status.");
    } else if (ITEM_CHANGES[kind].has(key) && key !== "publicationDecision") changes[key] = incoming[key];
    else invalid(`Item field ${key} is immutable.`, "IMMUTABLE_FIELD");
  }
  if (own(changes, "handlingStatus") && own(incoming, "handlingStatus") && incoming.handlingStatus !== previous.handlingStatus && incoming.handlingStatus !== changes.handlingStatus) invalid("Legacy status and handlingStatus disagree.");
  return changes;
}

/** Old whole-document POST becomes exactly one permitted item update, or settings only. */
export function adaptLegacyDocument(current, body, actor, { kind = "feedback", nowIso } = {}) {
  allowKeys(body, new Set(["data", "expectedRevision"]), "body");
  const incoming = record(body.data, "data");
  if (typeof body.expectedRevision !== "string" || !body.expectedRevision) invalid("expectedRevision is required.", "LEGACY_REVISION_REQUIRED");
  const currentRevision = moderationDocumentRevision(current);
  if (body.expectedRevision !== currentRevision) {
    throw new ModerationError(409, "LEGACY_DOCUMENT_CONFLICT", "The legacy document changed; reload before saving.", { currentRevision });
  }
  const username = actorName(actor);
  const now = serverTime(nowIso);
  const key = kind === "reviews" ? "reviews" : "items";
  if (!Array.isArray(incoming[key]) || incoming[key].length !== current[key].length) invalid("Legacy POST cannot add or remove items.", "IMMUTABLE_ITEM_SET");
  const currentIds = current[key].map((item) => item.id);
  const incomingIds = incoming[key].map((item) => item?.id);
  if (!equal(currentIds, incomingIds)) invalid("Legacy POST cannot change item ids or their order.", "IMMUTABLE_ITEM_SET");
  const warnings = new Set();
  const deltas = [];
  for (let index = 0; index < current[key].length; index += 1) {
    const changes = legacyItemDelta(current[key][index], incoming[key][index], kind, warnings);
    if (Object.keys(changes).length) deltas.push({ index, changes });
  }
  const settingsChanges = {};
  const settingKeys = new Set(kind === "reviews" ? ["rules"] : ["title", "announcement", "rules"]);
  for (const field of new Set([...Object.keys(current), ...Object.keys(incoming)])) {
    if (field === key) continue;
    if (TOP_METADATA.has(field)) {
      if (own(incoming, field) && !equal(current[field], incoming[field])) warnings.add("Client actor/time metadata was ignored.");
      continue;
    }
    if (equal(current[field], incoming[field])) continue;
    if (settingKeys.has(field)) {
      if (field === "rules") {
        record(incoming.rules, "data.rules");
        settingsChanges.rules = Object.fromEntries([...new Set([...Object.keys(current.rules), ...Object.keys(incoming.rules)])]
          .filter((name) => !equal(current.rules[name], incoming.rules[name])).map((name) => [name, incoming.rules[name]]));
      } else settingsChanges[field] = incoming[field];
    }
    else invalid(`Document field ${field} is immutable.`, "IMMUTABLE_FIELD");
  }
  if (deltas.length > 1 || deltas.length && Object.keys(settingsChanges).length) invalid("Legacy POST must contain one item change or settings only.", "LEGACY_MIXED_WRITE");
  if (Object.keys(settingsChanges).length) {
    const result = patchSettingsDocument(current, { expectedSettingsRevision: settingsRevision(current, kind), changes: settingsChanges }, username, { kind, nowIso: now });
    if (warnings.size) result.result.compatibilityWarnings = [...warnings];
    return result;
  }
  const next = structuredClone(current);
  const delta = deltas[0];
  if (delta) next[key][delta.index] = itemMutation(current[key][delta.index], delta.changes, kind, username, now);
  const previousItem = delta ? current[key][delta.index] : null;
  const nextItem = delta ? next[key][delta.index] : null;
  return {
    document: next, scope: delta ? "item" : "noop",
    result: {
      data: nextItem ? structuredClone(nextItem) : null,
      ...(nextItem ? { itemRevision: itemRevision(nextItem), publicEligible: publicGate(kind, nextItem) } : {}),
      revision: moderationDocumentRevision(next),
      changes: nextItem ? moderationAuditChanges(previousItem, nextItem) : [],
      ...(warnings.size ? { compatibilityWarnings: [...warnings] } : {}),
    },
  };
}

export class ModerationService {
  constructor({ store, filePath, kind = "feedback", nowIso = () => new Date().toISOString(), normalize, beforeWrite } = {}) {
    if (!store || !filePath || !["feedback", "reviews"].includes(kind)) throw new Error("ModerationService requires store, filePath and a known kind.");
    this.store = store;
    this.filePath = filePath;
    this.kind = kind;
    this.nowIso = nowIso;
    this.normalize = normalize || ((data) => normalizeModerationDocument(data, { kind, nowIso }));
    this.beforeWrite = beforeWrite;
    this.key = kind === "reviews" ? "reviews" : "items";
  }

  async read() {
    const data = this.normalize(await this.store.read(this.filePath));
    const revision = moderationDocumentRevision(data);
    const itemRevisions = Object.fromEntries(data[this.key].map((item) => [item.id, itemRevision(item)]));
    const settingsToken = settingsRevision(data, this.kind);
    for (const item of data[this.key]) item.publicEligible = publicGate(this.kind, item);
    return { data, revision, itemRevisions, settingsRevision: settingsToken };
  }

  async get(id) {
    const { data } = await this.read();
    const item = data[this.key].find((row) => row.id === id);
    if (!item) throw new ModerationError(404, "ITEM_NOT_FOUND", "Moderation item was not found.");
    return { data: item, itemRevision: itemRevision(item), publicEligible: publicGate(this.kind, item) };
  }

  async patchItem(id, body, actor) {
    allowKeys(body, new Set(["expectedItemRevision", "changes"]), "body");
    allowKeys(body.changes, ITEM_CHANGES[this.kind], "changes");
    const username = actorName(actor);
    let result;
    await this.store.update(this.filePath, async (persisted) => {
      const current = this.normalize(persisted);
      const index = current[this.key].findIndex((row) => row.id === id);
      if (index === -1) throw new ModerationError(404, "ITEM_NOT_FOUND", "Moderation item was not found.");
      const previous = current[this.key][index];
      // The comparison and mutation share AtomicJsonStore's lock, including async audit preparation.
      try {
        requireItemToken(body, previous);
      } catch (error) {
        if (error.currentItem) error.currentItem.publicEligible = publicGate(this.kind, error.currentItem);
        throw error;
      }
      const next = itemMutation(previous, body.changes, this.kind, username, serverTime(this.nowIso));
      const changes = moderationAuditChanges(previous, next);
      if (changes.length) await this.beforeWrite?.({ previous: structuredClone(previous), next: structuredClone(next), changes, id, kind: this.kind, scope: "item" });
      current[this.key][index] = next;
      result = { data: { ...structuredClone(next), publicEligible: publicGate(this.kind, next) }, itemRevision: itemRevision(next), publicEligible: publicGate(this.kind, next), changes };
      return current;
    }, { mode: 0o600 });
    return result;
  }

  patchSettingsDocument(current, body, actor) {
    return patchSettingsDocument(current, body, actor, { kind: this.kind, nowIso: this.nowIso });
  }

  adaptLegacyDocument(current, body, actor) {
    return adaptLegacyDocument(current, body, actor, { kind: this.kind, nowIso: this.nowIso });
  }

  /** For settings that do not require the root's static-publish transaction. */
  async patchSettings(body, actor) {
    let result;
    await this.store.update(this.filePath, async (persisted) => {
      const current = this.normalize(persisted);
      const patched = this.patchSettingsDocument(current, body, actor);
      result = patched.result;
      if (result.changes.length) await this.beforeWrite?.({ previous: moderationSettings(current, this.kind), next: result.data, changes: result.changes, id: "settings", kind: this.kind, scope: "settings" });
      return patched.document;
    }, { mode: 0o600 });
    return result;
  }

  /** Compatibility helper; production settings callers use the root's publisher mutator. */
  async patchLegacy(body, actor) {
    let result;
    await this.store.update(this.filePath, async (persisted) => {
      const current = this.normalize(persisted);
      const adapted = this.adaptLegacyDocument(current, body, actor);
      result = adapted.result;
      if (result.changes.length) await this.beforeWrite?.({ previous: current, next: adapted.document, changes: result.changes, id: result.data?.id || "settings", kind: this.kind, scope: adapted.scope });
      return adapted.document;
    }, { mode: 0o600 });
    return result;
  }
}
