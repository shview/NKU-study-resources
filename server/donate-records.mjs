import { AtomicJsonStore } from "./atomic-json-store.mjs";

const RECORD_LIMIT = 500;

/** 捐赠记录行（公开表：时间/昵称/去向），追加到 donate.json 的 records 数组。 */
export function normalizeRecords(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => ({
      date: String(row?.date || "").slice(0, 10),
      nickname: String(row?.nickname || "").trim().slice(0, 32) || "好心人",
      usage: String(row?.usage || "").trim().slice(0, 40) || "待定",
    }))
    .filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date))
    .slice(-RECORD_LIMIT);
}

/** 北京时区年月日（支付入账时间）。 */
export function beijingDateLabel(timestampMs) {
  const shifted = new Date(Number(timestampMs) + 8 * 60 * 60 * 1000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 支付成功后把一条记录追加进 donate.json（仅记录数据，不触发静态重建——
 * 网页与小程序的记录表都走 API 实时渲染）。追加失败不影响入账结果。
 */
export async function appendDonateRecord({ store, filePath, nickname, paidAtMs }) {
  const next = normalizeRecords([
    ...(() => {
      try {
        const current = store.readSync(filePath);
        return Array.isArray(current?.records) ? current.records : [];
      } catch {
        return [];
      }
    })(),
    { date: beijingDateLabel(paidAtMs), nickname, usage: "待定" },
  ]);
  await store.update(filePath, (current) => {
    current.records = next;
    return current;
  }, { initialize: { version: 1, title: "", content: "", amounts: [5, 10, 15], records: [] }, mode: 0o600 });
  return next[next.length - 1] || null;
}
