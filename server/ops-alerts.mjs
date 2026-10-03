const ALERTS = Object.freeze({
  "log-user": { label: "用户安全日志", action: "请检查日志存储健康、待重放队列与磁盘状态。" },
  "log-admin": { label: "管理员审计日志", action: "请检查日志存储健康、待重放队列与磁盘状态。" },
  "log-law": { label: "依法调取日志", action: "请检查日志存储健康、待重放队列与磁盘状态。" },
  backup: { label: "完整备份", action: "请在后台检查最近备份状态及备份目标配置，修复后重新执行备份并验证。" },
});

export const OPS_ALERT_KEYS = Object.freeze(Object.keys(ALERTS));

// Keep state per subsystem, never per user, event ID, object path or error text.
export function createOpsAlerts({ send, now = Date.now, cooldownMs = 30 * 60_000, retryMs = 60_000, log = () => {} } = {}) {
  if (typeof send !== "function" || typeof now !== "function" || typeof log !== "function") {
    throw new TypeError("Ops alerts require send, now and log functions.");
  }
  if (![cooldownMs, retryMs].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new TypeError("Ops alert intervals must be non-negative finite numbers.");
  }
  const states = new Map(OPS_ALERT_KEYS.map((key) => [key, { unhealthy: false, cycle: 0, nextAt: 0, sending: null }]));

  function time() {
    try {
      const value = now();
      if (Number.isFinite(value)) return value;
    } catch {}
    return Date.now();
  }

  function record(key, sent) {
    try { log({ key, status: sent ? "sent" : "failed" }); } catch {}
  }

  function schedule(key, state) {
    if (!state.unhealthy || state.sending || time() < state.nextAt) return;
    const cycle = state.cycle;
    const observedAt = time();
    // Start on a microtask so callers never wait on a webhook or receive its errors.
    state.sending = Promise.resolve().then(async () => {
      if (state.cycle !== cycle || !state.unhealthy) return;
      let sent = false;
      try {
        const definition = ALERTS[key];
        const result = await send({
          title: "NKUStudy 运行告警",
          lines: [`**异常模块**：${definition.label}`, `**检测时间（UTC）**：${new Date(observedAt).toISOString()}`, "**状态**：检测到异常，需要管理员检查。", definition.action],
          template: "red",
        }, { purpose: "ops" });
        // Retry partial deliveries too: one successful recipient must not mask another's failure.
        sent = result?.sent === true && (!Array.isArray(result.results) || result.results.every((item) => item?.sent === true));
      } catch {}
      record(key, sent);
      if (state.cycle === cycle && state.unhealthy) state.nextAt = time() + (sent ? cooldownMs : retryMs);
    }).finally(() => {
      state.sending = null;
      // A recovery followed by a new failure may occur while the old send is in flight.
      if (state.cycle !== cycle && state.unhealthy) schedule(key, state);
    });
  }

  function report(key, unhealthy, _details) {
    const state = states.get(key);
    if (!state) return false;
    const next = unhealthy === true;
    if (state.unhealthy !== next) {
      state.unhealthy = next;
      state.cycle += 1;
      state.nextAt = 0;
    }
    if (next) schedule(key, state);
    return true;
  }

  async function flush() {
    let pending;
    while ((pending = [...states.values()].map((state) => state.sending).filter(Boolean)).length) {
      await Promise.all(pending);
    }
  }

  return Object.freeze({ report, flush });
}
