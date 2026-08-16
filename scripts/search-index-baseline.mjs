const base = String(process.env.PUBLIC_API_BASE || "https://nkustudy.top/api/v1").replace(/\/+$/, "");
const keyword = String(process.argv[2] || "化学").trim().normalize("NFKC").toLocaleLowerCase("zh-CN");
if (!keyword) throw new Error("A non-empty search baseline keyword is required.");

const response = await fetch(`${base}/search-index`, { signal: AbortSignal.timeout(15_000) });
if (!response.ok) throw new Error(`Search index request failed with HTTP ${response.status}.`);
const body = await response.json();
if (body?.code !== 0 || !Array.isArray(body?.data?.items) || !body.data.version) throw new Error("Search index response does not match the public contract.");

const expectedCourses = body.data.items
  .filter((item) => item?.type === "course")
  .filter((item) => [item.name, item.short_name, ...(item.aliases || []), ...(item.tags || [])]
    .join("\n").normalize("NFKC").toLocaleLowerCase("zh-CN").includes(keyword))
  .map((item) => ({ id: item.id, name: item.name }))
  .sort((left, right) => left.name.localeCompare(right.name, "zh-CN") || left.id.localeCompare(right.id));

console.log(JSON.stringify({
  api_base: base,
  keyword,
  index_version: body.data.version,
  generated_at: body.data.generated_at,
  expected_course_count: expectedCourses.length,
  expected_courses: expectedCourses,
}, null, 2));
