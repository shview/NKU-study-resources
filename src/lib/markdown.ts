import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

// 内容图片按需定宽：`![说明](url#w240)` 渲染为 width=240；片段不参与请求，不影响加载。
const defaultImageRender = markdown.renderer.rules.image;
markdown.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const srcIndex = token.attrIndex("src");
  if (srcIndex >= 0) {
    const src = String(token.attrs[srcIndex][1] || "");
    const match = src.match(/#w([1-9]\d{0,3})$/);
    if (match) {
      token.attrs[srcIndex][1] = src.slice(0, src.length - match[0].length);
      token.attrSet("width", match[1]);
    }
  }
  return defaultImageRender(tokens, idx, options, env, self);
};

export function normalizeMarkdown(value = "") {
  let inFence = false;
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line
        .replaceAll("＊＊", "**")
        .replace(/\*\*\s+([^*\n](?:.*?[^*\n])?)\s+\*\*/g, "**$1**");
    })
    .join("\n");
}

export function markdownToHtml(value = "") {
  return markdown.render(normalizeMarkdown(value));
}
