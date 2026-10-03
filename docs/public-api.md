# Public mini-program API

The authoritative route, authentication, DTO, pagination and error contract is [API.md](API.md). This page remains as a navigation entry for existing links; it no longer maintains a second route list or release-status table.

- API base: `https://nkustudy.top/api/v1`.
- [Route registry](API.md#接口总表): checked against source by `npm run check:api-docs`.
- [Response, cache and transport conventions](API.md#通用约定).
- [Public data and endpoint contracts](API.md#公共小程序-apiapiv1).
- [WeChat login and identity](API.md#小程序微信登录).
- [Deployment and legal-domain configuration](DEPLOYMENT.md).

Content administration stays in the website's `/admin-api/*` interface. There is no public `/api/v1/admin*` compatibility surface. Course identifiers are immutable manifest `uid` values; resource downloads use the returned `download_url` at the configured public resource origin.

Guides are served from the versioned `server/data/learning-compass-snapshot.json`, loaded by `server/learning-compass-service.mjs`. They are not read from an optional runtime `guides.json`. Use the API's category facets and detail/variant contracts, without hard-coding counts or copying the retired guide schema.

Before release, run `npm run check:api-docs` and the isolated `npm run smoke:public-api` checks documented in the [S2 acceptance report](compliance/S2_ACCEPTANCE.md). After an authorized deployment, `npm run baseline:search -- 化学` can collect the live public search version and expected recall. Local fixture checks do not establish production acceptance.
