# 小程序访问统计上报规格（给前端组）

## 目标

让小程序的页面访问进入网站后台「访问统计」，与网页访问合并展示，归入「小程序」类别。

## 接口

```text
POST https://nkustudy.top/visit-api/hit
Content-Type: application/json

{ "path": "/mp/<页面名>" }
```

- 与网页同接口、同限流（每 IP 每分钟 120 次，客户端无需自己做节流）。
- `request` 合法域名 `https://nkustudy.top` 已在小程序后台配置，无需新增域名。
- 上报失败静默忽略即可，不得影响页面加载。

## 页面名规则

- 仅小写字母、数字、中划线，1–32 位；不符合规范的 `/mp/...` 会被服务端归入 `/mp/other`。
- 建议页面名与页面对应关系：

| 页面 | path |
|---|---|
| 首页 | `/mp/home` |
| 课程库 | `/mp/courses` |
| 课程概览 | `/mp/course-detail` |
| 课程资料 | `/mp/course-resources` |
| 课程评价 | `/mp/course-reviews` |
| 搜索 | `/mp/search` |
| 指南列表 | `/mp/guides` |
| 指南详情 | `/mp/guide-detail` |
| 写评价 | `/mp/write-review` |
| 分享资料 | `/mp/submit-resource` |
| 个人中心 | `/mp/profile` |

## 实现示例

`miniprogram/utils/report-visit.js`：

```js
const BASE = 'https://nkustudy.top';

module.exports = function reportVisit(page) {
  if (!/^[a-z0-9-]{1,32}$/.test(page || '')) page = 'other';
  wx.request({
    url: `${BASE}/visit-api/hit`,
    method: 'POST',
    header: { 'content-type': 'application/json' },
    data: { path: `/mp/${page}` },
    fail: () => {},
  });
};
```

各页面 `onLoad` 中调用一次：

```js
const reportVisit = require('../../utils/report-visit.js');

Page({
  onLoad() {
    reportVisit('course-detail');
  },
});
```

## 隐私与去重

- 不要传 openid、unionid 或任何用户标识；服务端只用 IP+UA 的哈希做 30 分钟去重。
- 统计后台按「小程序」类别汇总，明细按页面名展示，趋势图与网页访问合并计入每日总量。
