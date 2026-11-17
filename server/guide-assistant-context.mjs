// Retrieval intent is reconstructed from USER messages only. Previous model
// answers help the reader, but never manufacture knowledge or routing hints.
const STOP = new Set("什么 怎么 如何 是否 可以 需要 应该 哪个 哪里 时候 办理 申请 我的 学校 课程 同学 老师 我们 请问 一下 还是 以及 对于 这个 那个 如果 已经 没有 大学 具体 步骤 材料 要求 不同 哪些 信息 确认 规定 本科 本科生 南开 相关 问题 请列 列出 帮我 告诉 解释 说明".split(" "));
const FOLLOW_UP = /^(那|那么|还有|然后|所以|其中|这|它|上述|刚才|继续|再|我是|我在|我们是|我想转|想转入|目标是)|具体|需要.{0,5}材料|哪些.{0,18}(要求|信息|变化|确认)|因年级|总结|步骤|详细|补充/;
const SHORT_FOLLOW_UP = /^(请问)?(多久|多长时间|什么时候(交|提交|申请|截止)?|几号(截止)?|有(什么|啥|哪些)限制|有什么要求|要(什么|哪些)材料|怎么(办|操作|申请)|可以吗|为什么|为什么不行)(呢|啊|吗)?[？?。!！]*$/;
const SYNONYMS = [[/挂科|没过|不及格/g, "不合格 重修"], [/绩点|gpa|abcdf|abcd|等级制/gi, "成绩 GPA 等级"], [/复查|查分/g, "成绩复核"], [/转系|换专业/g, "转专业"], [/大物/g, "大学物理"], [/\bai\b|人工智能工具/gi, "AI 人工智能 工具"]];
const normalize = value => String(value || "").normalize("NFKC").toLowerCase();
// Vocabulary aliases describe search intent, not policy. Avoid treating fragments
// such as 计算 (inside 计算机学院) or 业不 (inside 专业不同) as a new topic.
const TOPICS = {
  "ai-coursework": /作业|\bai\b|人工智能工具/i,
  "grade-review": /复核|复查|查分|成绩.{0,5}异议/,
  "course-grade-and-gpa": /gpa|绩点|abcdf|abcd|等级制|总评|成绩.{0,5}计算/i,
  "required-course-registration-and-retake": /重修|挂科|不及格|漏选|补登/,
  "transfer-major-2026": /转专业|转系|换专业|(?:想转入|转到|转去).{1,20}学院/,
  "resume-study": /复学/,
  "student-status-rules": /休学|退学|学业警示|注册/,
  "micro-major-2026": /微专业/,
  "minor-study-2026": /辅修/,
  "exam-attendance-and-exceptions": /缓考|缺考|无法.{0,5}考试|参加考试/,
  "credit-recognition-and-exchange": /学分认定|学分.{0,5}认定|校际交流|国际小学期/,
  "student-rights-discipline-appeals": /申诉|处分.{0,6}权利/,
  "academic-integrity-and-exam-violations": /作弊|学术不端|考试违纪/,
  "graduation-timing-and-outcomes": /毕业|结业/,
  "bachelor-degree-application": /学士学位|学位.{0,5}异议/,
  "course-selection-2026-fall": /选课时间|选课.{0,5}安排/,
  "course-selection-rules-2026-fall": /选课系统|跨专业选课|学分上限/,
  "undergraduate-internship-rules": /实习/
};

function expand(value) {
  let text = normalize(value);
  for (const [pattern, replacement] of SYNONYMS) text = text.replace(pattern, match => `${match} ${replacement}`);
  return text;
}

export function keywords(value) {
  const words = new Set();
  for (const run of expand(value).match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) || []) {
    if (/^[a-z0-9]+$/.test(run)) { if (run.length >= 2) words.add(run); continue; }
    for (let i = 0; i + 2 <= run.length; i++) {
      const word = run.slice(i, i + 2);
      if (!STOP.has(word)) words.add(word);
    }
  }
  return [...words];
}

function guidesOf(chunks) {
  return [...new Map(chunks.map(chunk => [chunk.guide_id, chunk])).values()];
}

function guideScores(query, guides) {
  const explicit = guides.filter(guide => TOPICS[guide.guide_id]?.test(query));
  const isGeneric = isFollowUp(query) && !explicit.length;
  if (isGeneric) return [];
  const terms = keywords(query).filter(term => !["专业", "年级", "学院", "使用", "规范"].includes(term) && !/^\d+$/.test(term));
  return guides.map(guide => {
    const title = normalize([guide.guide_title, ...(guide.aliases || [])].join(" "));
    return { guide, score: (explicit.includes(guide) ? 100 : explicit.length ? -100 : 0)
      + terms.reduce((score, term) => score + (title.includes(term) ? term.length >= 3 ? 8 : 5 : 0), 0) };
  }).sort((a, b) => b.score - a.score);
}

function isFollowUp(question) {
  return FOLLOW_UP.test(question) || /^(目标|目前|现在|当前)/.test(question) || SHORT_FOLLOW_UP.test(question.trim()) || /学院|20\d{2}级/.test(question);
}

function collegeConstraint(question, variants) {
  // Match the longest name at each position (e.g. 留学本科 vs 中国本科).
  const mentions = [];
  for (const variant of variants) {
    const title = variant.variant_title.normalize("NFKC");
    const names = [...new Set([title, title.replace(/学院.*$/, "")])].filter(name => name.length >= 2);
    for (const name of names) {
      let start = question.indexOf(name);
      while (start >= 0) {
        mentions.push({ id: variant.variant_id, start, end: start + name.length });
        start = question.indexOf(name, start + name.length);
      }
    }
  }
  const matches = mentions.filter(item => !mentions.some(other => other.start <= item.start && other.end >= item.end && other.end - other.start > item.end - item.start));
  const targets = new Set(), neutral = new Set();
  let hasSource = false;
  for (const mention of matches) {
    const previousEnd = Math.max(0, ...matches.filter(item => item.end <= mention.start).map(item => item.end));
    const prefix = question.slice(previousEnd, mention.start).split(/[，,。；;：:\n]/).at(-1);
    const suffix = question.slice(mention.end).split(/[，,。；;：:\n]/)[0];
    if (/(不转|不去|不是|不考虑)\s*$/.test(prefix)) continue;
    if (/(目标(?:学院|专业)?|转入|转到|转去|想转|申请去|申请转入)(?:是|为|到|去|改为|改成)?\s*$/.test(prefix)
        || /^(?:学院)?(?:是|为)(?:我的)?(?:目标|转入学院)/.test(suffix)) targets.add(mention.id);
    else if (/(目前|现在|当前|就读|所在|来自|我在|我是|从)(?:是|在|于|就读于|就读)?\s*$/.test(prefix)
        || /^(?:学院)?(?:是|为)(?:我的)?(?:当前|原|现在的|所在)学院/.test(suffix)) hasSource = true;
    else neutral.add(mention.id);
  }
  const compared = /比较|对比|区别/.test(question) ? new Set(matches.map(item => item.id)) : new Set();
  const ids = [...(compared.size > 1 ? compared : targets.size ? targets : neutral)];
  return { ids, hasSource };
}

export function resolveIntent(question, history, chunks) {
  const guides = guidesOf(chunks);
  const users = history.map((message, index) => ({ ...message, index })).filter(message => message.role === "user");
  let topic = "", segment = [];
  for (const user of [...users, { content: question, index: history.length }]) {
    const ranked = guideScores(user.content, guides);
    let nextTopic = ranked[0]?.score > 0 ? ranked[0].guide.guide_id : "";
    if (!nextTopic && topic) {
      const priorVariants = [...new Map(chunks.filter(chunk => chunk.guide_id === topic && chunk.variant_id).map(chunk => [chunk.variant_id, chunk])).values()];
      const constraint = collegeConstraint(user.content.normalize("NFKC"), priorVariants);
      if (constraint.ids.length || constraint.hasSource) nextTopic = topic;
    }
    // A thesis is a refinement of the AI-use question, unless the user names
    // another rule (graduation requirements / degree / internship, etc.).
    if (topic === "ai-coursework" && /毕业论文|毕业设计/.test(user.content)
        && isFollowUp(user.content) && (!nextTopic || nextTopic === "graduation-timing-and-outcomes")
        && !/毕业条件|毕业要求|结业/.test(user.content)) nextTopic = topic;
    if (nextTopic && nextTopic !== topic) {
      topic = nextTopic;
      segment = [];
    } else if (!nextTopic && !isFollowUp(user.content)) {
      topic = "";
      segment = [];
    }
    segment.push(user);
  }
  // The latest explicit condition replaces that field only. Naming the same
  // topic does not erase the preceding college/year; a new topic does.
  const variants = [...new Map(chunks.filter(chunk => chunk.guide_id === topic && chunk.variant_id).map(chunk => [chunk.variant_id, chunk])).values()];
  let variantId = "", needsCollegeClarification = false, years = [];
  for (const user of segment) {
    const content = user.content.normalize("NFKC");
    const requestedYears = [...content.matchAll(/(20\d{2})年(?!级|入学|入校)/g)].map(match => match[1]);
    if (requestedYears.length) years = [...new Set(requestedYears)];
    const { ids, hasSource } = collegeConstraint(content, variants);
    if (ids.length) {
      variantId = ids.length === 1 ? ids[0] : "";
      needsCollegeClarification = ids.length > 1;
    } else if (hasSource && !variantId) needsCollegeClarification = true;
    if (/只看校级|只问校级|不限定学院/.test(content)) { variantId = ""; needsCollegeClarification = false; }
  }
  return { query: segment.map(user => user.content).join("\n"), topic, variantId, years, needsCollegeClarification,
    history: history.slice(segment[0]?.index ?? history.length) };
}

export function retrieveEvidence(intent, chunks, maxChunks = 6, maxChars = 24000) {
  if (intent.needsCollegeClarification) return [];
  const terms = keywords(intent.query);
  const candidates = chunks.filter(chunk => (!intent.topic || chunk.guide_id === intent.topic)
    && (!chunk.variant_id || chunk.variant_id === intent.variantId));
  const scored = candidates.map(chunk => {
    const text = normalize(chunk.text), location = normalize(chunk.location);
    const score = terms.reduce((total, term) => total + (text.includes(term) ? 2 : 0) + (location.includes(term) ? 4 : 0), 0)
      + (intent.topic && chunk.guide_id === intent.topic ? 5 : 0);
    return { chunk, score };
  }).filter(item => item.score >= 3).sort((a, b) => b.score - a.score);
  const selected = [], seen = new Set();
  let used = 0;
  for (const { chunk } of scored) {
    // The same verbatim source block may belong to multiple public guides.
    const id = `${chunk.source_file_id}:${chunk.chunk_id}`;
    if (seen.has(id) || used + chunk.text.length > maxChars) continue;
    seen.add(id); selected.push(chunk); used += chunk.text.length;
    if (selected.length >= maxChunks) break;
  }
  return selected;
}

export function conversationReply(question, history) {
  const compact = question.replace(/[\s，。？！?!]/g, "");
  if (/^(请)?(你是谁|你能做什么|你能帮我做什么|你可以做什么|你是干什么的|自我介绍一下|介绍一下你自己|介绍你自己|你是什么助手)$/.test(compact)) {
    return { answer_kind: "assistant_info", answer: "我是学习指南针助手，可以依据已收录指南回答学习制度问题、查看来源，也可以回顾当前对话。涉及具体学院和年份，请补充条件；资料不足时会明确说明。" };
  }
  if (/^(请|帮我|麻烦|能不能|可以|你能|你可以|能否|给我)?(再)?(总结|回顾|概括|梳理)(一下|下)?(上文|上述内容|上面的内容|前面的内容|前面的对话|这段对话|当前对话|我们的对话|刚才的内容|刚才聊的内容|(我们|咱们)?(刚才|之前|前面|本次)?的?(对话|聊天|聊天内容))(内容)?(吗|么)?$/.test(compact)
      || /^(请|帮我|给我|麻烦|你能|能不能)?(再)?(总结|回顾|概括|梳理)(一下|下)?((我们|咱们)?(刚才|之前|前面)(都)?(聊了什么|聊过什么|说了什么)|(我|我们)?(刚才|之前|前面)?问过你的问题)(吗|么)?$/.test(compact)
      || /^(我们|刚才)(都)?(聊了什么|说了什么)$/.test(compact)) {
    const lines = history.map((message, index) => `${index + 1}. ${message.role === "user" ? "你问" : "此前回答"}：${message.content.slice(0, 500).replace(/REFUSE_[A-Z_]+/g, "（内部状态已省略）")}${message.content.length > 500 ? "（节选）" : ""}`);
    return { answer_kind: "conversation_summary", answer: lines.length ? `以下回顾本次对话，引用此前消息，不代表重新核验校内规定：\n\n${lines.join("\n\n")}` : "这段对话还没有已完成的问答。你可以先提出一个问题。" };
  }
  return null;
}

export function supportedFollowUps(selected) {
  const questions = [];
  for (const chunk of selected) {
    const question = `关于“${chunk.guide_title}”，请解释“${chunk.location}”中的规定。`;
    if (question.length <= 160 && !questions.includes(question)) questions.push(question);
    if (questions.length === 3) break;
  }
  return questions;
}

const REASONS = new Set(["INSUFFICIENT_EVIDENCE", "SOURCE_CONFLICT", "OUT_OF_SCOPE"]);
export function parseProviderAnswer(value) {
  if (typeof value !== "string") throw new Error("invalid answer type");
  const text = value.trim();
  // Old prompts/models can emit this marker after a seemingly normal answer.
  // Refusal is terminal: discard the whole body, never display both outcomes.
  const marker = /REFUSE_([A-Z_]+)/i.exec(text);
  if (marker) return { refused: true, reason: /CONFLICT/i.test(marker[1]) ? "SOURCE_CONFLICT" : /OUT_OF_SCOPE/i.test(marker[1]) ? "OUT_OF_SCOPE" : "INSUFFICIENT_EVIDENCE" };
  const json = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (/^[{[]/.test(json)) {
    const raw = JSON.parse(json);
    if (!raw || Array.isArray(raw) || typeof raw.refused !== "boolean") throw new Error("invalid answer outcome");
    if (raw.refused) return { refused: true, reason: REASONS.has(raw.reason) ? raw.reason : "INSUFFICIENT_EVIDENCE" };
    if (raw.reason || typeof raw.answer !== "string" || !raw.answer.trim()) throw new Error("invalid answer body");
    return parseProviderAnswer(raw.answer);
  }
  if (!text) throw new Error("empty answer");
  if (/没有足够依据|资料不足.{0,12}(无法|不能)回答|无法依据.{0,12}(回答|结论)|不敢瞎说|(?:没有|缺少)(?:相关|足够|可靠)?(?:资料|依据|信息)[\s\S]{0,20}(?:不能|无法)(?:回答|作答)|(?:资料库|知识库).{0,10}(?:没有|未收录|找不到)/.test(text)) return { refused: true, reason: "INSUFFICIENT_EVIDENCE" };
  return { refused: false, answer: text.normalize("NFKC") };
}
