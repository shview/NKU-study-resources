# Public mini-program API

The mini program uses `https://nkustudy.top/api/v1`. Every success response is:

```json
{ "code": 0, "data": {} }
```

Errors use HTTP 400, 404, 409, 429, or 500 and a stable code/message shape. Unexpected exceptions are not returned to clients. GET content may be cached for 60 seconds and supports ETag; health and every POST response are `no-store`.

## Routes

Only these public routes exist:

- `GET /health`
- `GET /home`
- `GET /courses?page=1&page_size=20&q=&term=&group=&tag=&assessment=`
- `GET /courses/:courseUid`
- `GET /courses/:courseUid/resources`
- `GET /review-groups`
- `GET /review-groups/:groupKey`
- `POST /reviews`

`page_size` is at most 100. All filters use strings stored by the website. Groups such as `通识选修课`, tags, assessment values, terms, and teacher names are not duplicated into an API enum. There are deliberately no academic-year or campus fields.

No `/api/v1/admin*` route exists. The public router does not proxy, map, or reuse `/admin-api/*`; website administrators continue to manage content in the web interface. Authentication, favorites, submissions, reports, and resource-detail endpoints are outside this release.

## Course and home DTOs

Course list/detail DTOs contain only:

```json
{
  "id": "immutable-course-uuid",
  "name": "课程标题",
  "summary": "课程摘要",
  "description": "课程摘要",
  "term": "大一下",
  "group": "通识选修课",
  "category_name": "通识选修课",
  "tags": ["服务器标签"],
  "assessment": "服务器考核方式",
  "teachers": ["教师姓名"],
  "teacher_groups": [],
  "resource_count": 0,
  "review_count": 0,
  "offering_count": 0,
  "ratings": { "average": null, "count": 0, "show_aggregate": false },
  "updated": "2026-08-15"
}
```

`id` is the course `uid`, never the editable title or website route id. Home returns `announcement`, `hot_courses`, and `latest_updates`, computed from the current runtime `home.json`, `manifest.json`, and approved reviews. It never reads fixture or compiled data.

## Reviews

The grouping key is a stable hash of the website's existing stored `courseTitle + teacher` pair. Grouping and ordering follow the website: exact trimmed strings, then review count, average rating, and key. An exact course-title match supplies `course_id`; an unmatched historical review remains visible with `matched: false` and `course_id: null`. This is expected data, not an invented teacher/course association.

The public review DTO contains `id`, `teacher_name`, the website's one `rating`, `tags`, `body`, `helpful_count`, and `created_at`. It does not create separate difficulty, workload, grading, or attendance scores.

Mini-program submission body:

```json
{
  "course_id": "immutable-course-uuid",
  "teacher": "教师姓名",
  "rating": 5,
  "tags": ["印象标签"],
  "body": "评价正文",
  "anonymous": true
}
```

`anonymous` is accepted from the current client but no identity is published. The service resolves `course_id` to the current course title, then uses the exact same submission service, persistent limits, atomic queue, `reviews.json`, and moderation state as `/review-api/submit`. It does not create a mini-program review database.

## Resource DTO and domains

Resources contain only `id`, `course_id`, `course_name`, `title`, `size`, `size_label`, `description`, `section`, `type`, `term_label`, `extension`, and `download_url`. `id` is a hash of course UID and the file's public relative path. The relative path itself is not returned.

`download_url` is built from the configured HTTPS `PUBLIC_RESOURCE_ORIGIN` (normally `https://resources.nkustudy.top`) and the runtime manifest, encoding each path segment. The final origin and root prefix are checked before return. Downloads go directly to R2 rather than through Node.

Configure these WeChat legal domains before real-device release:

- request domain: `https://nkustudy.top`
- download domain: `https://resources.nkustudy.top`

## Explicit field denylist

DTO code constructs every object property-by-property and never spreads manifest or review records. It never exposes `basePath`, file `path`, `source`, `resourceRoot`, `repository`, local/Windows paths, contributor/admin metadata, IP or actor hashes, user-agent values, moderation flags, R2 credentials, secrets, or management settings.

## Current mini-program contract changes

The current client must be adjusted in its integration phase:

- send `group`, not `category`, and read `facets.groups`;
- replace the unapproved `/courses/:id/reviews` call with `/review-groups` plus group detail calls;
- open files directly from `download_url`; `/resources/:id` is not part of this API;
- derive displayed resource sections/types from server values rather than a hard-coded client list.

## Calls intentionally unsupported in this release

The mini program must not call these paths or options until the named later phase implements them:

- `/search-index`: replace with `GET /courses?q=...`; no separate search-index route will be added.
- `/guides`: disable the remote guide request and keep local/static guide content until a public guide DTO is designed.
- `/auth/wechat`, `/me`, `/me/favorites`, `/me/submissions`, and `/me/reviews`: disable sign-in and personal-data actions until the authenticated SQLite phase; browsing remains anonymous.
- `/resources/:id/reports`: hide the report action until authenticated writes and moderation are implemented.
- `/courses/:id/reviews`: replace with `/review-groups` and `/review-groups/:groupKey`; the old client shape will not be emulated.
- `/resources/:id`: open the returned `download_url`; no resource-detail compatibility route will be added.
- `sort`: remove it client-side; the server's stable ordering is authoritative in this release.
- `page_size=200`: reduce to the enforced maximum of 100 and paginate normally.

No management endpoint will be added under `/api/v1`. Content administration remains website-only.
