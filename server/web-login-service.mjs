import { randomBytes } from "node:crypto";

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_TICKETS = 10_000;

/**
 * 网页扫码登录票据（内存态，5 分钟有效）：
 * - start 创建 pending 票据并把 id 编进小程序码 scene；
 * - 小程序端 confirm（需登录+手机号已验证）置为 confirmed；
 * - 网页轮询 status，首次读到 confirmed 时兑换 httpOnly 会话并置 used（一次性）。
 * 票据 id 为 120 位随机数，仅发起方浏览器与扫码者持有。
 */
export function createWebLoginService({ now = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  const tickets = new Map();

  function prune() {
    const current = now();
    for (const [id, ticket] of tickets) {
      if (ticket.expiresAt <= current) tickets.delete(id);
    }
    while (tickets.size > MAX_TICKETS) tickets.delete(tickets.keys().next().value);
  }

  function get(id) {
    const ticket = tickets.get(String(id || ""));
    if (!ticket) return null;
    if (ticket.expiresAt <= now()) {
      tickets.delete(ticket.id);
      return null;
    }
    return ticket;
  }

  return {
    create() {
      prune();
      const id = randomBytes(15).toString("base64url");
      const ticket = { id, status: "pending", createdAt: now(), expiresAt: now() + ttlMs, userId: null, confirmedAt: null };
      tickets.set(id, ticket);
      return ticket;
    },
    get,
    confirm(id, userId) {
      const ticket = get(id);
      if (!ticket || ticket.status !== "pending") return false;
      ticket.status = "confirmed";
      ticket.userId = Number(userId);
      ticket.confirmedAt = now();
      return true;
    },
    markUsed(id) {
      const ticket = get(id);
      if (ticket) ticket.status = "used";
      return ticket;
    },
  };
}
