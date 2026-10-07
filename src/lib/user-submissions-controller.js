export class UserRequestError extends Error {
  constructor(message, status = 0, code = "") {
    super(message);
    this.name = "UserRequestError";
    this.status = status;
    this.code = code;
  }
}

export async function requestUserJson(url, options = {}, { fetch = globalThis.fetch, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      signal: controller.signal,
    });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new UserRequestError("服务器返回了无法读取的结果，请稍后重试。", response.status);
    }
    if (!response.ok || result?.ok === false || (typeof result?.code === "number" && result.code !== 0)) {
      throw new UserRequestError(result?.error || result?.message || "请求失败，请稍后重试。", response.status, result?.code || "");
    }
    return result;
  } catch (error) {
    if (error instanceof UserRequestError) throw error;
    if (controller.signal.aborted) throw new UserRequestError("请求超时，尚未确认结果，请稍后重试。");
    throw new UserRequestError("网络连接失败，尚未确认结果，请检查连接后重试。");
  } finally {
    clearTimeout(timer);
  }
}

export function reportReceipt(result) {
  if (result?.ok !== true || result.accepted !== true || result.private !== true || typeof result.receiptId !== "string" || !result.receiptId.trim()) {
    throw new UserRequestError(result?.accepted === false
      ? "本次请求未被受理，内容仍保留在表单中。请检查后再提交。"
      : "服务器尚未确认受理，内容仍保留在表单中。请稍后重试。");
  }
  return { receiptId: result.receiptId.trim(), replyAvailable: result.replyAvailable === true };
}

export function reviewSubmissionMessage(result) {
  if (result?.ok !== true || result.accepted !== true) {
    throw new UserRequestError("服务器尚未确认保存，评价内容已保留。请稍后重试。");
  }
  const publication = result.review?.publicationState || result.review?.status;
  if (publication === "approved") return "已提交并公开，可在我的评价查看状态。";
  if (publication === "pending") return "已提交，等待审核，可在我的评价查看状态。";
  if (result.pending === false) return "已提交并公开，可在我的评价查看状态。";
  if (result.pending === true) return "已提交，等待审核，可在我的评价查看状态。";
  return "已提交，可在我的评价查看处理结果。";
}

/**
 * @typedef {{ phase: string, items: unknown[], total: number, page: number, pageSize: number, error: string, authExpired: boolean }} OwnerListState
 */

// Only owner-scoped endpoints are accepted; this controller never accepts a user ID.
/**
 * @param {{ path: string, pageSize?: number, request?: typeof requestUserJson, onState?: (state: OwnerListState) => void }} options
 */
export function createOwnerListController({ path, pageSize = 10, request = requestUserJson, onState = () => {} }) {
  if (!/^\/api\/v1\/me\/(feedback|reviews|favorites)$/.test(path)) throw new Error("Unsupported owner list path");
  let generation = 0;
  let state = { phase: "idle", items: [], total: 0, page: 1, pageSize, error: "", authExpired: false };
  const emit = (next) => { state = { ...state, ...next }; onState({ ...state }); };

  async function load(page = state.page) {
    const requestedPage = Number.isSafeInteger(page) && page > 0 ? page : 1;
    const requestGeneration = ++generation;
    emit({ phase: "loading", page: requestedPage, error: "", authExpired: false });
    try {
      const result = await request(`${path}?page=${requestedPage}&page_size=${pageSize}`);
      if (requestGeneration !== generation) return;
      const data = result?.data;
      if (result?.code !== 0 || !Array.isArray(data?.items)
        || !Number.isSafeInteger(data.total) || data.total < 0
        || !Number.isSafeInteger(data.page) || data.page !== requestedPage
        || !Number.isSafeInteger(data.page_size) || data.page_size < 1) {
        throw new UserRequestError("列表返回结果不完整，请重试。");
      }
      const lastPage = Math.max(1, Math.ceil(data.total / data.page_size));
      if (requestedPage > lastPage) return load(lastPage);
      if (data.total > 0 && !data.items.length) throw new UserRequestError("本页数据未完整返回，请重试。");
      emit({ phase: "ready", items: data.items, total: data.total, page: data.page, pageSize: data.page_size });
    } catch (error) {
      if (requestGeneration !== generation) return;
      const authExpired = error?.status === 401;
      emit({ phase: "error", items: [], error: authExpired ? "登录已失效，请重新登录后重试。" : error?.message || "列表加载失败，请重试。", authExpired });
    }
  }

  return { load, retry: () => load(state.page), state: () => ({ ...state }) };
}
