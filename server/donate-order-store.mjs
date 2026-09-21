import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/** 捐助订单：金额以分为单位；状态 pending → paid（回调幂等）。 */
export class DonateOrderStore {
  constructor({ dbPath }) {
    if (!dbPath) throw new Error("DonateOrderStore requires dbPath.");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath);
    fs.chmodSync(dbPath, 0o600);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS donate_orders (
        out_trade_no TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        amount_total INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        transaction_id TEXT,
        created_at INTEGER NOT NULL,
        paid_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS donate_orders_user_idx ON donate_orders(user_id, created_at);
    `);
    this.insertOrder = this.db.prepare(
      "INSERT INTO donate_orders (out_trade_no, user_id, amount_total, status, created_at) VALUES (?, ?, ?, 'pending', ?)"
    );
    this.selectOrder = this.db.prepare("SELECT * FROM donate_orders WHERE out_trade_no = ?");
    this.markPaidStmt = this.db.prepare(
      "UPDATE donate_orders SET status = 'paid', transaction_id = COALESCE(?, transaction_id), paid_at = COALESCE(paid_at, ?) WHERE out_trade_no = ? AND status = 'pending'"
    );
  }

  create({ outTradeNo, userId, amountTotal, now = Date.now() }) {
    this.insertOrder.run(outTradeNo, Number(userId), Math.round(amountTotal), now);
    return this.selectOrder.get(outTradeNo);
  }

  get(outTradeNo) {
    return this.selectOrder.get(outTradeNo) || null;
  }

  /** 幂等：已 paid 直接返回 true；金额不符返回 false。 */
  markPaid({ outTradeNo, amountTotal, transactionId, now = Date.now() }) {
    const order = this.get(outTradeNo);
    if (!order) return false;
    if (order.amount_total !== Math.round(amountTotal)) return false;
    if (order.status === "paid") return true;
    this.markPaidStmt.run(transactionId || null, now, outTradeNo);
    return true;
  }

  listRecent(limit = 50) {
    return this.db.prepare("SELECT * FROM donate_orders ORDER BY created_at DESC LIMIT ?").all(Math.min(500, Math.max(1, Number(limit) || 50)));
  }

  summary() {
    const paid = this.db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(amount_total), 0) AS total FROM donate_orders WHERE status = 'paid'").get();
    return { paid_count: paid.count, paid_total_fen: paid.total };
  }

  close() {
    this.db.close();
  }
}
