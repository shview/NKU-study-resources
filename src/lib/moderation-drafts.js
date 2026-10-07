const copy = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** Keeps saved server records and explicit, independently saveable drafts apart. */
export function createModerationDraftStore({ fields, revisionField = "expectedItemRevision" }) {
  const allowed = new Set(fields);
  const records = new Map();
  const requireRecord = (id) => {
    const record = records.get(String(id));
    if (!record) throw new Error("记录尚未加载，请重新加载。");
    return record;
  };
  const isDirty = (record) => Object.keys(record.changes).length > 0;

  return {
    hydrate(items, revisions = {}) {
      for (const item of items) {
        const id = String(item.id);
        const existing = records.get(id);
        // An ordinary refresh must never rebase or discard unsaved changes.
        if (existing && (isDirty(existing) || existing.saving || existing.conflict)) continue;
        records.set(id, { saved: copy(item), revision: revisions[id] || "", changes: {}, saving: false, error: "", message: "", conflict: null, submitted: null });
      }
    },
    read(id) {
      const record = requireRecord(id);
      return { ...copy(record), value: { ...copy(record.saved), ...copy(record.changes) }, dirty: isDirty(record) };
    },
    change(id, field, value) {
      if (!allowed.has(field)) throw new Error(`不可修改字段：${field}`);
      const record = requireRecord(id);
      // The submitted value may become the next saved baseline. Returning to the
      // old baseline during that request is a new intent, not a clean draft.
      const submittedInFlight = record.saving && Object.hasOwn(record.submitted || {}, field);
      if (!submittedInFlight && equal(record.saved[field], value)) delete record.changes[field];
      else record.changes[field] = copy(value);
      record.error = "";
      record.message = "";
    },
    cancel(id) {
      const record = requireRecord(id);
      if (record.saving) return false;
      record.changes = {};
      record.error = "";
      record.message = "已取消本条草稿";
      // A conflict needs an explicit current-record decision, even after cancellation.
      if (record.conflict) {
        record.saved = copy(record.conflict.item);
        record.revision = record.conflict.revision;
        record.conflict = null;
      }
      return true;
    },
    begin(id) {
      const record = requireRecord(id);
      if (record.saving) throw new Error("本条正在保存。");
      if (record.conflict) throw new Error("请先处理本条冲突。");
      if (!isDirty(record)) throw new Error("本条没有待保存改动。");
      if (!record.revision) throw new Error("缺少服务器版本，请重新加载后再保存。");
      if (typeof record.changes.reply === "string" && record.changes.reply.length > 2000) throw new Error("回复不能超过 2000 字。");
      record.saving = true;
      record.error = "";
      record.message = "";
      record.submitted = copy(record.changes);
      return { [revisionField]: record.revision, changes: copy(record.submitted) };
    },
    succeed(id, item, revision, message = "已保存本条") {
      const record = requireRecord(id);
      if (!item || !revision) throw new Error("服务器未返回已保存记录与版本，草稿已保留，请核对后重试。");
      const submitted = record.submitted || {};
      for (const [field, value] of Object.entries(submitted)) {
        if (equal(record.changes[field], value)) delete record.changes[field];
      }
      record.saved = copy(item);
      record.revision = revision;
      record.saving = false;
      record.submitted = null;
      record.conflict = null;
      record.error = "";
      record.message = isDirty(record) ? `${message}；本条仍有新的未保存改动。` : message;
    },
    fail(id, error, conflict = null) {
      const record = requireRecord(id);
      record.saving = false;
      record.submitted = null;
      record.message = "";
      record.error = String(error?.message || error || "保存失败，草稿已保留。");
      if (conflict?.item && conflict?.revision) record.conflict = copy(conflict);
    },
    resolve(id, choices = {}) {
      const record = requireRecord(id);
      if (!record.conflict) return;
      const nextChanges = {};
      for (const [field, value] of Object.entries(record.changes)) {
        if (!['mine', 'server'].includes(choices[field])) throw new Error("请为每个冲突字段选择保留草稿或服务器值。");
        if (choices[field] === "mine" && !equal(record.conflict.item[field], value)) nextChanges[field] = copy(value);
      }
      record.saved = copy(record.conflict.item);
      record.revision = record.conflict.revision;
      record.changes = nextChanges;
      record.conflict = null;
      record.error = "";
      record.message = "已加载最新版本；保留的改动需再次点保存。";
    },
    hasUnsaved() {
      return [...records.values()].some((record) => isDirty(record) || record.saving || record.conflict);
    },
    isSaving() {
      return [...records.values()].some((record) => record.saving);
    },
  };
}
