import io

p = "test/admin-server.integration.test.mjs"
s = io.open(p, encoding="utf-8").read()

old = '''  const port = await freePort();
  const wxMock = http.createServer((req, res) => {'''
new = '''  const port = await freePort();
  fs.writeFileSync(path.join(dataDir, "catalog.json"), JSON.stringify({
    version: 1,
    updated: "2026-08-22",
    sources: ["test"],
    courses: [
      { id: "cat-test-1", name: "泥人张百年技艺传承与经营实践", aliases: [], categories: ["通识选修课"], modules: ["艺术审美与文化思辨"], teachers: ["张宇"], terms: ["2025-2026-1"] },
      { id: "cat-test-2", name: "人工智能与创新", aliases: [], categories: ["人工智能学院"], modules: [], teachers: [], terms: ["2025-2026-1"] },
    ],
  }), "utf8");
  const wxMock = http.createServer((req, res) => {'''
assert old in s, "fixture anchor"
s = s.replace(old, new)

old = '''  const notifyState = await (await fetch(`http://127.0.0.1:${port}/admin-api/notify-settings`, { headers: { cookie } })).json();'''
new = '''  const catalogResponse = await (await fetch(`http://127.0.0.1:${port}/api/v1/catalog?q=泥人张`)).json();
  assert.equal(catalogResponse.code, 0);
  assert.equal(catalogResponse.data.total, 1);
  assert.equal(catalogResponse.data.items[0].teachers[0], "张宇");

  const catalogReviewBadTeacher = await fetch(`http://127.0.0.1:${port}/api/v1/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ catalog_course_id: "cat-test-1", teacher: "不存在老师", rating: 5, body: "Catalog validation test content long enough." }),
  });
  assert.equal(catalogReviewBadTeacher.status, 400);
  assert.equal((await catalogReviewBadTeacher.json()).code, "TEACHER_NOT_IN_CATALOG");

  const catalogReviewOk = await fetch(`http://127.0.0.1:${port}/api/v1/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ catalog_course_id: "cat-test-1", teacher: "张宇", rating: 5, body: "Catalog course review content long enough for validation." }),
  });
  assert.equal(catalogReviewOk.status, 200);
  assert.equal((await catalogReviewOk.json()).data.pending, true);

  const catalogReviewFreeTeacher = await fetch(`http://127.0.0.1:${port}/api/v1/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ catalog_course_id: "cat-test-2", teacher: "任意新老师", rating: 4, body: "Teacher list empty so free text is allowed here." }),
  });
  assert.equal(catalogReviewFreeTeacher.status, 200);

  const catalogReviewMissing = await fetch(`http://127.0.0.1:${port}/api/v1/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ catalog_course_id: "cat-nope", teacher: "张宇", rating: 5, body: "Missing catalog course must be rejected." }),
  });
  assert.equal(catalogReviewMissing.status, 404);
  assert.equal((await catalogReviewMissing.json()).code, "CATALOG_COURSE_NOT_FOUND");

  const notifyState = await (await fetch(`http://127.0.0.1:${port}/admin-api/notify-settings`, { headers: { cookie } })).json();'''
assert old in s, "integration anchor"
s = s.replace(old, new)

s = s.replace('assert.equal(reviews.reviews.length, 3);', 'assert.equal(reviews.reviews.length, 5);')
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("integration ok")

p2 = "docs/API.md"
s2 = io.open(p2, encoding="utf-8").read()
old2 = '| `GET` | `/api/v1/search-index` | 公开 | 小程序本地搜索索引 |'
assert old2 in s2
s2 = s2.replace(old2, old2 + '\n| `GET` | `/api/v1/catalog` | 公开 | 选课手册课程目录（课程+教师，支持 q 搜索与分页） |')

old3 = '统一响应格式为 `code、message、data`；分页接口增加 `page、page_size、total`。'
assert old3 in s2
add3 = old3 + '''

### 课程目录与评价选课

- `GET /api/v1/catalog?q=<关键词>&page=&page_size=`：来自教务选课手册的课程目录
  （课程名/开课单位/归属模块/授课教师/开设学期）；关键词同时匹配课程名与教师名。
- `POST /api/v1/reviews` 支持两种课程定位：
  - `course_id`：课程库（manifest）课程的 uid，教师为自由文本（兼容现状）；
  - `catalog_course_id`：课程目录中的课程 id；此时**教师必须从该课程的授课教师列表中选择**，
    否则返回 `400 TEACHER_NOT_IN_CATALOG`（教师列表为空的课程允许自由填写）。'''
s2 = s2.replace(old3, add3)
io.open(p2, "w", encoding="utf-8", newline="\n").write(s2)
print("docs ok")
