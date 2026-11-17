# C++ 笔记本地导入候选（2026-11-17）

当前未发布。唯一生产源仍是网站的 learning-compass 快照；未创建服务、修改手册快照、重启后台、提交或推送。

## 内容与产物

原文： https://nankai.feishu.cn/wiki/Cve2wGjESikMqrkMY7bcEbqgned ，Docx 修订 22113。作者：王昊成（小红书：秋来拾光），无所不能哈基咪。

- `artifacts/cpp-notes/source.json`：bot 身份读取的完整 DocxXML。原文只读，未修改飞书。
- `artifacts/cpp-notes/sheets/`：95 个嵌入表格的全部物理范围、值和样式归档，无截断；无合并单元格、浮动图片或图表。
- `public/guide-media/cpp-notes/`：166 张飞书原图，不生成替代图片。
- `content/cpp-notes.json`：63 章；保留 458 个代码块、592 个有效标题锚点、7 处公式、嵌套列表与作者信息。两处空白 h1 合入相邻章节，不生成空白页。22 个附件保留原文入口，未下载附件本体。
- `artifacts/cpp-notes/candidate-snapshot.json`：33 篇原有指南加 63 章 C++ 的独立候选。原指南对象及 AI 检索结果逐项相等，官方检索未加入笔记。

## 复现

在网站仓库运行：

```powershell
python scripts/fetch-cpp-assets.py
python scripts/compile-feishu-cpp.py
python test/feishu-cpp-compiler_test.py
node scripts/merge-cpp-notes.mjs
node --test test/cpp-notes.test.mjs
python scripts/preview-cpp-notes.py --chrome <本机Chrome可执行文件>
```

fetch 依赖本机已配置的 lark-cli bot 读取权限；不读取或打印凭据。source.json 需先用 `docs +fetch --doc <原文URL> --doc-format xml --detail full --as bot` 归档。缺图、未知结构、未支持公式、截断表格或超预算章节会失败，不静默省略。

候选合并默认输出 artifacts，拒绝输入输出为同一路径。正式发布应基于当时最新快照重新合并，不覆盖其他会话新增内容。原图须随网站发布到相同 HTTPS 路径。

## 客户端与验证边界

小程序现有 `/pages/feishu-document/index?doc=cpp-notes` 读取公共指南分页，按固定 `cpp-notes-NNN` ID 列出章节，进入既有 guide-detail 分包。没有新 API；复用 `student_experience`、`feishu-html-v1`、`body_html`、`body_outline`。生产尚无这些章节时显示原文入口，不提供失效章节链接。目录类型单独为 C++，不会混入生存手册筛选。

PASS：Python 2 项（代码逐字对比、原图/嵌套列表计数、表格和有效锚点完整性）；网站候选契约 1 项；客户端相关 37 项；小程序静态检查。所有 63 章通过上游 mp-html 原生解析器，节点最大约 400 KB；最大 HTML 326683 字节。浏览器截图 `artifacts/cpp-notes/preview-images.png`、`preview-code.png` 采用真实内容、原校徽与 reader-style，属于 HTML 排版预览，不能当作微信模拟器证据。

SKIP：遵守协作隔离，没有改 guide-detail / mp-html / reader-style，没有操作开发者工具。共用详情页目前仍有“生存手册”固定导航标题；主会话释放该文件后需将 C++ 章节标题显示为“C++ 笔记”，再做模拟器的章节跳转、代码横滚、表格横滚、图片预览、深色主题和真机验收。

发布所需条件：网站 owner 的发布窗口及已授权服务器连接、重新合并最新快照、166 张原图上线并只读校验 200、网站服务加载新候选、客户端共享标题收尾与微信验收。此轮未使用服务器连接，未上传微信版本。

## 微信装载补充（2026-11-17）

后续用户已要求微信装载。客户端共享导航标题已修正，开发者工具真实装载63章与166张原图，原生正文、代码、表格已截屏，证据在小程序仓库 artifacts/cpp-notes/wechat-directory.png、wechat-code.png。使用当前模拟器会话的候选响应与模拟器图片缓存，未关闭域名校验，不是生产接口验收。重新编译恢复线上数据；小程序 artifacts/cpp-notes/load-preview.cjs 可再次装载。此前本地HTTP预览因域名校验未采用，临时进程已停止。未上传、未发布；手机真机、图片全屏与深色仍待验收。

## Git 交付补充（2026-11-18）

本次将编译脚本、审核后的内容 JSON、166 张 C++ 原图、6 张生存手册原图、网站指南页和相关测试提交到网站仓库 `main`。`content/cpp-notes.json` 仍是独立候选；生产快照只包含已审核的 15 篇生存手册扩展，正式上线 C++ 章节需重新合并当时的最新快照并部署图片与服务。Git 提交本身不触发生产部署。
