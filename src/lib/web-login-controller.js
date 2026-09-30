// A ticket is consumed when status first returns confirmed. Keep requests serial,
// and verify the resulting HttpOnly session before declaring browser login done.
export function createWebLoginController({
  fetch: request = globalThis.fetch,
  onState = (_state) => {},
  onLogin = (_user) => {},
  now = Date.now,
  nonce = () => globalThis.crypto.randomUUID(),
  schedule = setTimeout,
  unschedule = clearTimeout,
} = {}) {
  let current = null;
  function stop() {
    if (!current) return;
    unschedule(current.timer);
    current.abort.abort();
    current = null;
  }
  const active = (flow) => current === flow && !flow.done;
  function publish(flow, phase, message) {
    if (active(flow)) onState({ phase, message, ticket: flow.ticket, qr: flow.qr });
  }
  function finish(flow, phase, message) {
    publish(flow, phase, message);
    flow.done = true;
    unschedule(flow.timer);
  }
  async function json(flow, url, method = "GET") {
    const response = await request(url, {
      method,
      cache: "no-store",
      credentials: "same-origin",
      signal: AbortSignal.any([flow.abort.signal, AbortSignal.timeout(12000)]),
      ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}),
    });
    const result = await response.json();
    if (!response.ok || result.code !== 0 || !result.data) {
      const error = new Error("WEB_LOGIN_REQUEST_FAILED");
      error.status = response.status;
      throw error;
    }
    return result.data;
  }
  function later(flow) {
    if (active(flow)) flow.timer = schedule(() => check(), 2000);
  }
  async function start() {
    stop();
    const flow = { abort: new AbortController(), ticket: "", qr: "", busy: true, done: false, timer: null };
    current = flow;
    publish(flow, "starting", "正在获取网页登录码…");
    try {
      const data = await json(flow, "/api/v1/auth/web-login/start", "POST");
      if (!active(flow)) return;
      if (typeof data.ticket !== "string" || !/^[A-Za-z0-9_-]{10,64}$/.test(data.ticket)) throw new Error("INVALID_TICKET");
      flow.ticket = data.ticket;
      flow.qr = data.qr_available && data.qr_image ? data.qr_image : "";
      flow.expiresAt = now() + Math.min(300, Math.max(1, Number(data.expires_in) || 300)) * 1000;
      publish(flow, "pending", "等待手机确认。请保持此窗口打开；手机确认后，这里会自动登录。");
    } catch {
      if (active(flow)) finish(flow, "error", "登录码获取失败，请检查网络后点击刷新登录码。");
    } finally {
      flow.busy = false;
      later(flow);
    }
  }
  async function check() {
    const flow = current;
    if (!flow || !active(flow) || flow.busy || !flow.ticket) return;
    unschedule(flow.timer);
    if (now() >= flow.expiresAt) {
      finish(flow, "expired", "登录码已过期，请刷新登录码，并在手机重新确认。");
      return;
    }
    flow.busy = true;
    publish(flow, "checking", "正在检查手机确认结果…");
    try {
      if (!flow.confirmedUser) {
        // Unique URL also avoids stale intermediary responses created by older releases.
        const url = `/api/v1/auth/web-login/status?ticket=${encodeURIComponent(flow.ticket)}&_=${encodeURIComponent(nonce())}`;
        const data = await json(flow, url);
        if (!active(flow)) return;
        if (data.status === "pending") {
          publish(flow, "pending", "仍在等待手机确认；若手机已确认，请核对是否使用本窗口的最新登录码。");
          return;
        }
        if (data.status === "expired" || data.status === "used") {
          finish(flow, "expired", data.status === "used"
            ? "登录码已被使用，本窗口未完成登录。请刷新登录码，并在手机重新确认。"
            : "登录码已过期，请刷新登录码，并在手机重新确认。");
          return;
        }
        if (data.status !== "confirmed" || data.user?.id == null) throw new Error("INVALID_STATUS");
        flow.confirmedUser = data.user.id;
      }
      publish(flow, "checking", "手机已确认，正在检查浏览器登录状态…");
      const session = await json(flow, "/api/v1/auth/web-login", "POST");
      if (!active(flow)) return;
      if (!session.user || session.user.id !== flow.confirmedUser) {
        finish(flow, "error", "手机已确认，但浏览器未保存对应账号的登录状态。请允许本站 Cookie，再刷新登录码重试。");
        return;
      }
      finish(flow, "success", "登录成功，正在进入我的页面…");
      onLogin(session.user);
    } catch (error) {
      if (active(flow) && flow.confirmedUser && error.status === 401) {
        finish(flow, "error", "手机已确认，但浏览器未保存登录状态。请允许本站 Cookie，再刷新登录码重试。");
      } else if (active(flow) && error.status === 403) {
        finish(flow, "error", "服务器拒绝了本次登录，请联系网站管理员核对账号状态。");
      } else if (active(flow)) publish(flow, "retry", flow.confirmedUser
        ? "手机已确认，暂时无法核验浏览器会话；将自动重试，也可点击检查登录。"
        : "暂时无法查询登录结果；将自动重试，也可点击检查登录。");
    } finally {
      flow.busy = false;
      later(flow);
    }
  }
  return { start, check, stop };
}
