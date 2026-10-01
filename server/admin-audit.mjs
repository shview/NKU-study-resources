import { createHmac } from 'node:crypto';

export function queryAuditMetadata(url, secret) {
  const scope = ['account', 'review', 'feedback'].includes(url.searchParams.get('type')) ? url.searchParams.get('type') : 'account';
  const value = url.searchParams.get('value') || url.searchParams.get('id') || '';
  const range = Object.fromEntries(['from', 'to', 'log_page', 'log_page_size', 'audit_page'].filter(key => url.searchParams.has(key)).map(key => [key, Number.isFinite(Number(url.searchParams.get(key))) ? Number(url.searchParams.get(key)) : null]));
  const reference = url.searchParams.get('reference') || '';
  return { scope, range, reference: /^[a-zA-Z0-9._:-]{1,80}$/.test(reference) ? reference : null, criteriaHash: createHmac('sha256', secret).update(value).digest('hex').slice(0, 32) };
}

// Log changed field names. Only small status/boolean enums get before/after values.
// Text, account identity, reply bodies, URLs and credentials never enter the log.
export function contentChanges(previous, next, key) {
  const before = new Map((previous[key] || []).map(row => [String(row.id), row]));
  const after = new Map((next[key] || []).map(row => [String(row.id), row]));
  const changes = [];
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(id), b = after.get(id);
    const known = new Set(['id','status','hidden','private','blocked','title','content','type','contact','user_id','reply','rating','tags','teacher','courseTitle','updatedBy','updatedAt','repliedBy','repliedAt','handledBy','handledAt','reviewedBy','reviewedAt','createdAt','reportUrl','reportTarget']);
    const rawFields = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].filter(name => JSON.stringify(a?.[name]) !== JSON.stringify(b?.[name]));
    const fields = [...new Set(rawFields.map(name => known.has(name) ? name : 'other_fields'))];
    if (!fields.length) continue;
    const states = {};
    for (const name of ['status', 'hidden', 'private', 'blocked']) {
      const safe = value => typeof value === 'boolean' || ['pending', 'approved', 'rejected', 'open', 'completed', 'processing'].includes(value) ? value : null;
      if (fields.includes(name)) states[name] = { before: safe(a?.[name]), after: safe(b?.[name]) };
    }
    changes.push({ id, operation: !b ? 'delete' : !a ? 'create' : 'update', fields, states });
  }
  return changes;
}

export function stampContentActor(incoming, previous, key, username, now = new Date().toISOString()) {
  const next = structuredClone(incoming);
  const before = new Map((previous[key] || []).map(row => [String(row.id), row]));
  next[key] = (next[key] || []).map(row => {
    const old = before.get(String(row.id));
    const value = { ...row };
    for (const field of ['updatedBy', 'updatedAt', 'repliedBy', 'repliedAt', 'handledBy', 'handledAt', 'reviewedBy', 'reviewedAt']) {
      if (old && Object.hasOwn(old, field)) value[field] = old[field]; else delete value[field];
    }
    if (contentChanges({ rows: old ? [old] : [] }, { rows: [value] }, 'rows').length) {
      value.updatedBy = username; value.updatedAt = now;
      if (value.reply !== old?.reply) { value.repliedBy = username; value.repliedAt = now; }
      if (value.status !== old?.status || value.hidden !== old?.hidden) { value.handledBy = username; value.handledAt = now; }
    }
    return value;
  });
  return next;
}
