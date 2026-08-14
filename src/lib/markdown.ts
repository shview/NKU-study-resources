import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

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
