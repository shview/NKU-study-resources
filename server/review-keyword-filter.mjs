const DEFAULT_PATTERNS = [
  /1[3-9]\d{9}/,
  /\d{3,4}-\d{7,8}/,
  /[A-Za-z][A-Za-z0-9_-]{5,19}\s*(加|➕|十)\s*个?\s*(微信|vx|wx|V信|威信|企鹅|qq|QQ)/,
  /(微信|vx|wx|V信|威信|企鹅|QQ|qq)[:：\s]*[A-Za-z][A-Za-z0-9_-]{5,19}/,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
];

const BLOCK_WORDS = [" fuck ", " 傻逼 ", " 脑残 ", " 滚蛋 ", " 废物 "];

export function reviewKeywordMatch(content, customWords = []) {
  const text = ` ${String(content ?? "").replace(/\s+/g, " ")} `;
  const hits = [];
  for (const pattern of DEFAULT_PATTERNS) {
    if (pattern.test(text)) {
      hits.push(pattern.source.slice(0, 40));
      break;
    }
  }
  const normalized = text.toLowerCase();
  for (const word of [...BLOCK_WORDS, ...customWords.map((item) => String(item || "").trim().toLowerCase())]) {
    const trimmed = String(word || "").trim().toLowerCase();
    if (trimmed && normalized.includes(trimmed)) {
      hits.push(trimmed.slice(0, 20));
      break;
    }
  }
  return hits.slice(0, 2);
}
