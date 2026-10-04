import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const commonFields = ["id", "title", "summary", "category", "category_label", "applicable_scope", "updated_at", "time_status", "content_type", "read_minutes"];
const sourceFields = ["id", "title", "document_no", "publisher", "published_at", "file_type", "file_name", "file_url", "official_page_url", "location_label"];
const sectionFields = ["id", "title", "body_format", "body", "source_ids"];
const hashVersion = (value) => createHash("sha256").update(JSON.stringify(value)).digest("base64url").slice(0, 24);
const ids = (items) => items.map((item) => item.id).sort();
const pick = (value, fields) => Object.fromEntries(fields.map((field) => [field, value[field]]));

function shape(value, fields, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label}: expected object`);
  assert.deepEqual(Object.keys(value).sort(), [...fields].sort(), `${label}: public fields changed`);
}

function unique(items, label) {
  assert.ok(Array.isArray(items), `${label}: expected array`);
  assert.ok(items.every((item) => typeof item.id === "string" && item.id), `${label}: missing ID`);
  assert.equal(new Set(ids(items)).size, items.length, `${label}: duplicate ID`);
}

function timestamp(value, label) {
  assert.equal(typeof value, "string", `${label}: expected timestamp`);
  assert.match(value, /T.*(?:Z|[+-]\d{2}:\d{2})$/, `${label}: timezone required`);
  assert.ok(Number.isFinite(Date.parse(value)), `${label}: invalid timestamp`);
}

// These expectations come from the reviewed input and committed content snapshot,
// not from another call to the service being checked or a fixed guide count.
export function validateGuideSnapshot(snapshot, sourceContent) {
  assert.ok(snapshot && sourceContent, "Guide snapshot and reviewed source content are required");
  assert.ok(snapshot.guides?.length > 0, "Guide snapshot must not be empty");
  unique(snapshot.guides, "snapshot guides");
  unique(snapshot.sources, "snapshot sources");
  assert.ok(typeof sourceContent.version === "string" && sourceContent.version, "Source build version missing");
  assert.equal(snapshot.source_build_version, sourceContent.version, "Guide source build version mismatch");
  assert.equal(snapshot.version, hashVersion({ categories: snapshot.categories, guides: snapshot.guides, conflicts: snapshot.conflicts }), "Guide snapshot version checksum mismatch");
  timestamp(snapshot.content_updated_at, "guide content version timestamp");
  assert.equal(snapshot.content_updated_at, sourceContent.content_updated_at, "Guide content timestamp mismatch");
  const published = sourceContent.guides.filter((item) => item.status === "published");
  unique(published, "reviewed published guides");
  assert.deepEqual(ids(snapshot.guides), ids(published), "Guide snapshot missing or unexpected published guide");
  assert.deepEqual(snapshot.categories.map((item) => item.label).sort(), [...sourceContent.categories].sort(), "Guide categories differ from reviewed source");
  unique(sourceContent.source_files, "reviewed source files");
  assert.deepEqual(ids(snapshot.sources), ids(sourceContent.source_files), "Guide source file mapping incomplete");
  const publicOrigin = new URL(snapshot.public_origin);
  assert.equal(publicOrigin.protocol, "https:", "Guide source origin must be HTTPS");
  assert.equal(publicOrigin.origin, snapshot.public_origin, "Guide source origin must not contain a path or credentials");
  assert.match(snapshot.guide_sources_prefix, /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/, "Guide source prefix is invalid");
  for (const source of snapshot.sources) {
    shape(source, sourceFields, `source ${source.id}`);
    const original = sourceContent.source_files.find((item) => item.id === source.id);
    for (const field of ["title", "file_type", "file_name"]) assert.equal(source[field], original[field], `source ${source.id}: ${field} differs from reviewed source`);
    assert.equal(source.file_url, `${snapshot.public_origin}/${snapshot.guide_sources_prefix}/${encodeURIComponent(original.file_name)}`, `source ${source.id}: original file URL mismatch`);
  }
  for (const guide of snapshot.guides) {
    const original = published.find((item) => item.id === guide.id);
    assert.equal(guide.title, original.title, `guide ${guide.id}: title differs from reviewed source`);
    assert.ok(snapshot.categories.some((category) => category.value === guide.category && category.label === guide.category_label), `guide ${guide.id}: category mismatch`);
    timestamp(guide.updated_at, `guide ${guide.id}`);
    assert.ok(["long_term", "current", "ended", "historical"].includes(guide.time_status), `guide ${guide.id}: invalid time_status`);
    assert.ok(["standard", "multi_variant"].includes(guide.content_type), `guide ${guide.id}: invalid content_type`);
    assert.ok(Number.isInteger(guide.read_minutes) && guide.read_minutes >= 0, `guide ${guide.id}: invalid read_minutes`);
  }
  return snapshot;
}

function verifySectionsAndSources(actual, expected, snapshot, label) {
  unique(actual.sections, `${label} sections`);
  unique(actual.sources, `${label} sources`);
  assert.ok(actual.sections.length > 0 && actual.sources.length > 0, `${label}: sections and sources required`);
  assert.deepEqual(actual.sections, expected.sections.map((section) => pick(section, sectionFields)), `${label}: section content mismatch`);
  for (const section of actual.sections) {
    shape(section, sectionFields, `${label} section`);
    assert.equal(section.body_format, "markdown", `${label}: body format mismatch`);
    assert.ok(typeof section.body === "string" && section.body.trim(), `${label}: missing section body`);
    assert.ok(section.source_ids.length > 0, `${label}: missing section citation`);
    for (const id of section.source_ids) assert.ok(actual.sources.some((source) => source.id === id), `${label}: unresolved section source ${id}`);
  }
  for (const source of actual.sources) {
    shape(source, sourceFields, `${label} source`);
    const original = snapshot.sources.find((item) => item.id === source.id);
    assert.ok(original, `${label}: unknown source ${source.id}`);
    assert.deepEqual(pick(source, sourceFields.filter((field) => field !== "location_label")), pick(original, sourceFields.filter((field) => field !== "location_label")), `${label}: source file metadata mismatch`);
  }
  assert.deepEqual(actual.sources, expected.sources, `${label}: source mapping mismatch`);
}

export async function verifyGuideApi({ request, snapshot, sourceContent, searchIndex }) {
  validateGuideSnapshot(snapshot, sourceContent);
  const get = async (route, status = 200, errorCode = null) => {
    const response = await request(route);
    assert.equal(response.status, status, `${route}: HTTP status mismatch`);
    assert.equal(response.body.code, errorCode ?? 0, `${route}: response code mismatch`);
    return response.body.data;
  };
  const pageSize = 5;
  const all = [];
  const expectedFacets = snapshot.categories.map((category) => ({ ...category, count: snapshot.guides.filter((guide) => guide.category === category.value).length })).filter((category) => category.count > 0);
  const pages = Math.ceil(snapshot.guides.length / pageSize);
  for (let page = 1; page <= pages + 1; page += 1) {
    const list = await get(`/api/v1/guides?page=${page}&page_size=${pageSize}`);
    shape(list, ["items", "total", "page", "page_size", "facets", "data_updated_at"], "guide list");
    assert.equal(list.page, page, "Guide pagination page mismatch");
    assert.equal(list.page_size, pageSize, "Guide pagination size mismatch");
    assert.equal(list.total, snapshot.guides.length, "Guide list total mismatch");
    assert.equal(list.items.length, Math.min(pageSize, Math.max(0, snapshot.guides.length - (page - 1) * pageSize)), "Guide page is missing items");
    assert.equal(list.data_updated_at, snapshot.content_updated_at, "Guide list content version mismatch");
    assert.deepEqual(list.facets, { categories: expectedFacets }, "Guide category facets mismatch");
    all.push(...list.items);
  }
  unique(all, "public guide list");
  assert.deepEqual(ids(all), ids(snapshot.guides), "Guide list missing or unexpected guide");
  let variantCount = 0;
  for (const summary of all) {
    const expected = snapshot.guides.find((guide) => guide.id === summary.id);
    shape(summary, [...commonFields, "source_count", "aliases", "tags"], `guide ${summary.id} summary`);
    assert.deepEqual(pick(summary, commonFields), pick(expected, commonFields), `guide ${summary.id}: summary content mismatch`);
    assert.equal(summary.source_count, expected.sources.length + (expected.content_type === "multi_variant" ? expected.variants.length : 0), `guide ${summary.id}: source count mismatch`);
    assert.deepEqual(summary.aliases, expected.aliases, `guide ${summary.id}: aliases mismatch`);
    assert.deepEqual(summary.tags, expected.tags, `guide ${summary.id}: tags mismatch`);
    const route = `/api/v1/guides/${encodeURIComponent(summary.id)}`;
    const detail = await get(route);
    shape(detail, [...commonFields, "sections", "sources", "variants", "related_courses", "correction_url"], `guide ${summary.id} detail`);
    assert.deepEqual(pick(detail, commonFields), pick(summary, commonFields), `guide ${summary.id}: list/detail mismatch`);
    verifySectionsAndSources(detail, expected, snapshot, `guide ${summary.id}`);
    assert.deepEqual(detail.variants, expected.variants, `guide ${summary.id}: variant list mismatch`);
    // Compatibility fields in the current learning-compass DTO. This is a
    // snapshot contract assertion, not a restriction on future product features.
    assert.deepEqual(detail.related_courses, [], `guide ${summary.id}: unexpected related courses`);
    assert.equal(detail.correction_url, "", `guide ${summary.id}: correction URL contract changed`);
    for (const variant of detail.variants) {
      shape(variant, ["id", "title", "order", "source_count"], "guide variant summary");
      const sourceVariant = expected.variant_details.find((item) => item.id === variant.id);
      assert.ok(sourceVariant, `guide ${summary.id}: missing variant source`);
      const actual = await get(`${route}/variants/${encodeURIComponent(variant.id)}`);
      shape(actual, ["guide_id", "variant"], "guide variant response");
      assert.equal(actual.guide_id, summary.id, "Variant belongs to the wrong guide");
      shape(actual.variant, ["id", "title", "order", "sections", "sources"], "guide variant detail");
      assert.deepEqual(pick(actual.variant, ["id", "title", "order"]), pick(variant, ["id", "title", "order"]), "Variant detail does not match its summary");
      const sourceIds = [...new Set(sourceVariant.sections.flatMap((section) => section.source_ids))];
      const sources = sourceIds.map((id) => ({ ...snapshot.sources.find((source) => source.id === id), location_label: sourceVariant.sections.filter((section) => section.source_ids.includes(id)).map((section) => section.title).join("；") }));
      verifySectionsAndSources(actual.variant, { sections: sourceVariant.sections, sources }, snapshot, `variant ${variant.id}`);
      variantCount += 1;
    }
  }
  assert.ok(Array.isArray(searchIndex.items), "Search index items missing");
  assert.equal(searchIndex.total, searchIndex.items.length, "Search index total mismatch");
  assert.equal(searchIndex.version, hashVersion(searchIndex.items), "Search index content version mismatch");
  timestamp(searchIndex.generated_at, "search index timestamp");
  const searched = searchIndex.items.filter((item) => item.type === "guide");
  unique(searched, "search guides");
  assert.deepEqual(ids(searched), ids(all), "Search index missing or unexpected guide");
  for (const item of searched) {
    const summary = all.find((guide) => guide.id === item.id);
    // Search DTO text is deliberately trimmed/NFKC-normalized and bounded;
    // the guide detail preserves the original reviewed text.
    assert.equal(item.name, summary.title.trim().normalize("NFKC").slice(0, 500), `search guide ${item.id}: title mismatch`);
    for (const field of ["category", "category_label", "updated_at"]) assert.deepEqual(item[field], summary[field], `search guide ${item.id}: ${field} mismatch`);
    for (const [field, limit] of [["aliases", 20], ["tags", 30]]) {
      const normalized = [...new Set(summary[field].map((value) => value.trim().normalize("NFKC").slice(0, 120)).filter(Boolean))].slice(0, limit);
      assert.deepEqual(item[field], normalized, `search guide ${item.id}: ${field} mismatch`);
    }
  }
  const missingId = "__smoke_missing_guide__";
  assert.ok(!snapshot.guides.some((guide) => guide.id === missingId));
  await get(`/api/v1/guides/${missingId}`, 404, "GUIDE_NOT_FOUND");
  await get("/api/v1/guides?category=__smoke_invalid_category__", 400, "INVALID_GUIDE_CATEGORY");
  const variantGuide = snapshot.guides.find((guide) => guide.variants.length);
  if (variantGuide) await get(`/api/v1/guides/${encodeURIComponent(variantGuide.id)}/variants/__smoke_missing_variant__`, 404, "GUIDE_VARIANT_NOT_FOUND");
  return { guides: all.length, variants: variantCount, snapshotVersion: snapshot.version, sourceVersion: snapshot.source_build_version };
}
