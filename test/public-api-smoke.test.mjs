import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { smokeEnvironment, runPublicApiSmoke } from "../scripts/smoke-public-api.mjs";
import { validateGuideSnapshot, verifyGuideApi } from "../scripts/lib/public-api-smoke-contract.mjs";

const version = (value) => createHash("sha256").update(JSON.stringify(value)).digest("base64url").slice(0, 24);
const stamp = "2000-01-01T00:00:00Z";

// Independently constructed public replies; no production DTO/service imports.
// Seven guides force pagination and prove that the checker does not require 18.
function goldenReplies() {
  const source = {
    id: "SRC-SYNTHETIC", title: "Synthetic original", document_no: "", publisher: "Synthetic publisher",
    published_at: "2000", file_type: "pdf", file_name: "synthetic.pdf",
    file_url: "https://sources.example.invalid/guide-sources/synthetic.pdf", official_page_url: "", location_label: "",
  };
  const category = { value: "course-study", label: "Synthetic category", order: 1 };
  const variants = ["science", "arts"].map((id, index) => ({
    id, title: `Synthetic ${id}`, order: index + 1,
    sections: [{ id: `section-${id}`, title: `${id} original section`, body_format: "markdown", body: `Synthetic ${id} only`, source_ids: [source.id] }],
    sources: [{ ...source, location_label: `${id} original section` }],
  }));
  const summaries = [], details = [], guides = [];
  for (let index = 0; index < 7; index += 1) {
    const common = {
      id: `synthetic-guide-${index}`, title: `Synthetic guide ${index}（only）`, summary: `Synthetic summary ${index}`,
      category: category.value, category_label: category.label, applicable_scope: "Synthetic acceptance",
      updated_at: stamp, time_status: "long_term", content_type: index === 6 ? "multi_variant" : "standard", read_minutes: 1,
    };
    const sections = [{ id: `section-${index}`, title: `Synthetic section ${index}`, body_format: "markdown", body: `Synthetic original content ${index}`, source_ids: [source.id] }];
    const variantSummaries = index === 6 ? variants.map(({ id, title, order }) => ({ id, title, order, source_count: 1 })) : [];
    summaries.push({ ...common, source_count: 1 + variantSummaries.length, aliases: [], tags: [] });
    details.push({ ...common, sections, sources: [source], variants: variantSummaries, related_courses: [], correction_url: "" });
    guides.push({ ...common, aliases: [], tags: [], sections, sources: [source], variants: variantSummaries,
      variant_details: index === 6 ? variants.map(({ sources, ...variant }) => variant) : [],
      retrieval: [{ id: "private-chunk", text: "Synthetic private retrieval content" }],
    });
  }
  const snapshot = {
    source_build_version: "synthetic-reviewed-version", content_updated_at: stamp,
    public_origin: "https://sources.example.invalid", guide_sources_prefix: "guide-sources",
    categories: [category], sources: [source], guides, conflicts: [],
  };
  snapshot.version = version({ categories: snapshot.categories, guides, conflicts: [] });
  const sourceContent = { version: snapshot.source_build_version, content_updated_at: stamp, categories: [category.label],
    source_files: [source], guides: guides.map(({ id, title }) => ({ id, title, status: "published" })),
  };
  const items = summaries.map((summary) => ({ id: summary.id, type: "guide", name: summary.title.normalize("NFKC"), category: summary.category,
    category_label: summary.category_label, updated_at: stamp, aliases: [], tags: [],
  }));
  const searchIndex = { items, total: items.length, version: version(items), generated_at: stamp };
  const seen = [];
  const request = async (route) => {
    seen.push(route);
    const url = new URL(route, "http://127.0.0.1");
    let response;
    if (url.pathname === "/api/v1/guides") {
      if (url.searchParams.has("category")) response = { status: 400, body: { code: "INVALID_GUIDE_CATEGORY" } };
      else {
        const page = Number(url.searchParams.get("page")), size = Number(url.searchParams.get("page_size"));
        response = { status: 200, body: { code: 0, data: { items: summaries.slice((page - 1) * size, page * size), total: summaries.length,
          page, page_size: size, facets: { categories: [{ ...category, count: summaries.length }] }, data_updated_at: stamp,
        } } };
      }
    } else if (url.pathname.includes("/variants/")) {
      const id = url.pathname.split("/").at(-1), variant = variants.find((item) => item.id === id);
      response = variant ? { status: 200, body: { code: 0, data: { guide_id: "synthetic-guide-6", variant } } }
        : { status: 404, body: { code: "GUIDE_VARIANT_NOT_FOUND" } };
    } else {
      const detail = details.find((item) => item.id === url.pathname.split("/").at(-1));
      response = detail ? { status: 200, body: { code: 0, data: detail } } : { status: 404, body: { code: "GUIDE_NOT_FOUND" } };
    }
    return structuredClone(response);
  };
  return { snapshot, sourceContent, searchIndex, request, seen };
}

test("public guide smoke accepts reviewed content of a different size, all details and isolated variants", async () => {
  const fixture = goldenReplies();
  const result = await verifyGuideApi(fixture);
  assert.equal(result.guides, 7);
  assert.equal(result.variants, 2);
  assert.equal(result.sourceVersion, "synthetic-reviewed-version");
  for (const route of ["/api/v1/guides?page=3&page_size=5", "/api/v1/guides/synthetic-guide-6/variants/science", "/api/v1/guides/synthetic-guide-6/variants/arts", "/api/v1/guides/__smoke_missing_guide__"]) assert.ok(fixture.seen.includes(route), route);
});

test("public guide smoke detects missing data, misrouted content, source leaks and stale versions", async (t) => {
  const cases = [
    ["missing listed guide despite plausible response envelope", (route, response) => { if (route.includes("page=1&")) response.body.data.items.pop(); }, /Guide page is missing items/],
    ["duplicate list ID with unchanged totals", (route, response) => { if (route.includes("page=1&")) response.body.data.items[0] = response.body.data.items[1]; }, /duplicate ID/],
    ["listed guide returns 404", (route, response) => { if (route === "/api/v1/guides/synthetic-guide-0") Object.assign(response, { status: 404, body: { code: "GUIDE_NOT_FOUND" } }); }, /HTTP status mismatch/],
    ["wrong guide detail ID", (route, response) => { if (route === "/api/v1/guides/synthetic-guide-0") response.body.data.id = "synthetic-guide-1"; }, /list\/detail mismatch/],
    ["right guide ID but wrong body", (route, response) => { if (route === "/api/v1/guides/synthetic-guide-0") response.body.data.sections[0].body = "Another guide's content"; }, /section content mismatch/],
    ["missing original source", (route, response) => { if (route === "/api/v1/guides/synthetic-guide-0") response.body.data.sources = []; }, /sections and sources required/],
    ["redirected original file URL", (route, response) => { if (route === "/api/v1/guides/synthetic-guide-0") response.body.data.sources[0].file_url = "http://wrong.example.invalid/file.pdf"; }, /source file metadata mismatch/],
    ["private retrieval leaked into public detail", (route, response) => { if (route === "/api/v1/guides/synthetic-guide-0") response.body.data.retrieval = [{ text: "Private body" }]; }, /public fields changed/],
    ["stale guide list version", (route, response) => { if (route.includes("page=1&")) response.body.data.data_updated_at = "1999-01-01T00:00:00Z"; }, /content version mismatch/],
    ["variant content belongs to another college", (route, response) => { if (route.endsWith("/variants/arts")) response.body.data.variant.sections[0].body = "Science-only content"; }, /section content mismatch/],
    ["unknown guide accidentally accepted", (route, response) => { if (route.endsWith("/__smoke_missing_guide__")) response.status = 200; }, /HTTP status mismatch/],
    ["invalid category accidentally accepted", (route, response) => { if (route.includes("category=")) response.status = 200; }, /HTTP status mismatch/],
  ];
  for (const [label, mutate, expected] of cases) {
    await t.test(label, async () => {
      const fixture = goldenReplies(), original = fixture.request;
      fixture.request = async (route) => { const response = await original(route); mutate(route, response); return response; };
      await assert.rejects(verifyGuideApi(fixture), expected);
    });
  }
});

test("public guide smoke rejects a self-consistent but incomplete search or snapshot", async () => {
  const missingSearch = goldenReplies();
  missingSearch.searchIndex.items.pop();
  missingSearch.searchIndex.total -= 1;
  missingSearch.searchIndex.version = version(missingSearch.searchIndex.items);
  await assert.rejects(verifyGuideApi(missingSearch), /Search index missing or unexpected guide/);
  const staleSearch = goldenReplies();
  staleSearch.searchIndex.version = "stale";
  await assert.rejects(verifyGuideApi(staleSearch), /Search index content version mismatch/);
  const missingSnapshot = goldenReplies();
  missingSnapshot.snapshot.guides.pop();
  missingSnapshot.snapshot.version = version({ categories: missingSnapshot.snapshot.categories, guides: missingSnapshot.snapshot.guides, conflicts: [] });
  assert.throws(() => validateGuideSnapshot(missingSnapshot.snapshot, missingSnapshot.sourceContent), /missing or unexpected published guide/);
  const staleSource = goldenReplies();
  staleSource.snapshot.source_build_version = "wrong-source-version";
  assert.throws(() => validateGuideSnapshot(staleSource.snapshot, staleSource.sourceContent), /source build version mismatch/);
});

test("smoke child environment isolates runtime paths and does not inherit credentials or preload options", () => {
  const poison = {
    R2_ACCESS_KEY_ID: "synthetic-resource-key", BACKUP_R2_SECRET_ACCESS_KEY: "synthetic-backup-key", AWS_PROFILE: "synthetic-profile",
    WECHAT_APPID: "synthetic-appid", WECHAT_APPSECRET: "synthetic-wechat-key", OPENAI_API_KEY: "synthetic-ai-key",
    QWEN_API_KEY: "synthetic-qwen-key", FEISHU_WEBHOOK: "synthetic-hook", HTTPS_PROXY: "http://proxy.example.invalid",
    NODE_OPTIONS: "--import=synthetic-preload", DATA_DIR: "/synthetic-production-data", PUBLIC_DIR: "/synthetic-production-public",
    ADMIN_SECRET_FILE: "/synthetic-production-secret", UNRECOGNIZED_FUTURE_SECRET: "synthetic-future-key",
  };
  const before = Object.fromEntries(Object.keys(poison).map((key) => [key, process.env[key]]));
  const directory = path.resolve("synthetic-smoke-only");
  try {
    Object.assign(process.env, poison);
    const env = smokeEnvironment(directory, 12345);
    for (const key of Object.keys(poison)) {
      if (["DATA_DIR", "PUBLIC_DIR", "ADMIN_SECRET_FILE"].includes(key)) assert.ok(env[key].startsWith(directory + path.sep), key);
      else assert.equal(Object.hasOwn(env, key), false, `${key} must not be inherited`);
    }
    for (const key of ["DATA_DIR", "STATE_DB_PATH", "PUBLIC_DIR", "PUBLIC_RELEASES_DIR", "ADMIN_SECRET_FILE", "BACKUP_SECRET_FILE"]) assert.ok(env[key].startsWith(directory + path.sep), key);
    assert.equal(env.ADMIN_HOST, "127.0.0.1");
    assert.equal(env.NODE_ENV, "test");
    assert.equal(env.ADMIN_PORT, "12345");
    for (const [key, value] of Object.entries(poison)) assert.equal(process.env[key], value, "Environment builder must not mutate the caller");
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("public API smoke runs real isolated HTTP with fixture runtime data and committed guide content", { timeout: 30_000 }, async () => {
  const result = await runPublicApiSmoke();
  assert.equal(result.health, "ok");
  assert.equal(result.courses, 1);
  assert.ok(result.guides > 0 && result.variants > 0);
  assert.equal(result.etag, 304);
  assert.equal(result.publicAdmin, 404);
  assert.equal(result.disabledAuth, 503);
});
