// ============================================================================
// DROPRATE — paying developers for native game sales.
//
// Before this existed, a completed sale recorded `payout_amount_raw` on the
// order and then nothing happened. The money sat in the treasury with no route
// out. Fine while DropRate is its own only seller; indefensible the moment a
// third party ships a game.
//
// THE MODEL
//   Earned the instant the copy mints. A native game is delivered on-chain and
//   provably owned — there is no "the key didn't work" failure a dispute window
//   would protect against, so there is no dispute window. You sold it, it's
//   yours.
//
//   Paid when the developer asks. A balance sits in the portal and they press
//   Withdraw. That means no automated outbound transfers from the treasury, no
//   transaction fee burned on a $1 sale, and the developer chooses the moment.
//
//   Same currency throughout: paid in USDC, withdraws USDC. The treasury never
//   carries FX risk on money it owes someone else.
//
// THE THING THAT MUST NOT BREAK
//   A developer double-clicking Withdraw must not be paid twice. The claim is
//   therefore an atomic UPDATE that stamps a payout id onto every unpaid order —
//   an order can only ever be claimed once, because the second UPDATE matches no
//   rows. The amount sent is the sum of what that UPDATE actually returned, not
//   a figure computed beforehand and hoped to still be true.
//
// Dispatched from lib/nativemarket.js for actions starting "native-payout-".
// ============================================================================

import { sql } from "./db.js";
import { verifyWalletSignature } from "./vault.js";
import { sendTreasuryTransfer } from "./solana.js";
import { sendTreasuryMulti, USDC_DECIMALS, SOL_DECIMALS } from "./paymulti.js";

const CCY = ["DROP", "USDC", "SOL"];
const DROP_DECIMALS = Number(process.env.DROP_DECIMALS || 6);
const SIG_TTL = Number(process.env.DEV_SIG_TTL_SEC || 300);
const decimalsFor = (c) => (c === "SOL" ? SOL_DECIMALS : c === "USDC" ? USDC_DECIMALS : DROP_DECIMALS);

/* A floor on withdrawals, per currency, in base units. Not to be stingy — it
   stops someone burning a transaction fee to move a fraction of a cent, which
   costs them more than they receive. Overridable if these are wrong for you. */
const MIN_WITHDRAW = {
  DROP: BigInt(process.env.NATIVE_MIN_WITHDRAW_DROP || 1_000_000),        // 1 $DROP
  USDC: BigInt(process.env.NATIVE_MIN_WITHDRAW_USDC || 500_000),          // $0.50
  SOL: BigInt(process.env.NATIVE_MIN_WITHDRAW_SOL || 5_000_000),          // 0.005 SOL
};

const httpErr = (code, msg) => { const e = new Error(msg); e.status = code; throw e; };

function assertSig(b) {
  const { wallet, message, signature } = b;
  if (!wallet || !message || !signature) httpErr(400, "wallet, message, signature required");
  if (!message.includes(`wallet:${wallet}`)) httpErr(401, "message/wallet mismatch");
  const m = /ts:(\d+)/.exec(message);
  const ts = m ? Number(m[1]) : 0;
  if (!ts || Math.abs(Date.now() / 1000 - ts) > SIG_TTL) httpErr(401, "signature expired — retry");
  let ok = false;
  try { ok = verifyWalletSignature(message, String(signature), wallet); } catch { ok = false; }
  if (!ok) httpErr(401, "signature verification failed");
  return wallet;
}

async function sellerFor(b) {
  const wallet = assertSig(b);
  const r = await sql`SELECT * FROM dev_sellers WHERE wallet = ${wallet}`;
  const s = r.rows[0];
  if (!s) httpErr(403, "no seller profile");
  return s;
}

// ---- schema ----------------------------------------------------------------
let migrated = false;
async function migratePayout() {
  if (migrated) return;
  await sql`CREATE TABLE IF NOT EXISTS dev_native_payouts(
    id serial PRIMARY KEY,
    seller_id int NOT NULL,
    wallet text NOT NULL,                      -- where it was sent, frozen at request time
    currency text NOT NULL,
    amount_raw text NOT NULL DEFAULT '0',
    decimals int NOT NULL,
    status text NOT NULL DEFAULT 'requested',  -- requested | sent | failed
    tx_sig text,
    error text,
    order_count int NOT NULL DEFAULT 0,
    requested_at timestamptz NOT NULL DEFAULT now(),
    sent_at timestamptz
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_npay_seller ON dev_native_payouts(seller_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_npay_status ON dev_native_payouts(status)`;
  /* The link that makes double-payment impossible: an order carries the id of
     the payout that claimed it, and can only be claimed while this is null. */
  await sql`ALTER TABLE dev_native_orders ADD COLUMN IF NOT EXISTS payout_id int`;
  await sql`CREATE INDEX IF NOT EXISTS idx_nord_payout ON dev_native_orders(payout_id)`;
  migrated = true;
}

// ---- balances ---------------------------------------------------------------
/* What a seller has earned, split into what they can take now and what is
   already on its way out. Computed from orders, not from a running total — a
   stored balance is a number that can drift; a sum over immutable rows cannot. */
async function balancesFor(sellerId) {
  const earned = await sql`
    SELECT pay_currency AS currency,
           SUM(payout_amount_raw::numeric) FILTER (WHERE payout_id IS NULL) AS available,
           SUM(payout_amount_raw::numeric) AS lifetime,
           COUNT(*) FILTER (WHERE payout_id IS NULL) AS unpaid_sales,
           COUNT(*) AS sales
    FROM dev_native_orders
    WHERE seller_id = ${sellerId} AND status = 'complete'
    GROUP BY pay_currency`;

  const pending = await sql`
    SELECT currency, SUM(amount_raw::numeric) AS amount
    FROM dev_native_payouts
    WHERE seller_id = ${sellerId} AND status = 'requested'
    GROUP BY currency`;
  const paid = await sql`
    SELECT currency, SUM(amount_raw::numeric) AS amount
    FROM dev_native_payouts
    WHERE seller_id = ${sellerId} AND status = 'sent'
    GROUP BY currency`;

  const byCcy = {};
  for (const c of CCY) {
    byCcy[c] = {
      currency: c, decimals: decimalsFor(c),
      available: "0", lifetime: "0", withdrawn: "0", in_flight: "0",
      sales: 0, unpaid_sales: 0,
      min_withdraw: MIN_WITHDRAW[c].toString(),
    };
  }
  for (const r of earned.rows) {
    const b = byCcy[r.currency]; if (!b) continue;
    b.available = String(r.available ?? "0").split(".")[0];
    b.lifetime = String(r.lifetime ?? "0").split(".")[0];
    b.sales = Number(r.sales || 0);
    b.unpaid_sales = Number(r.unpaid_sales || 0);
  }
  for (const r of pending.rows) if (byCcy[r.currency]) byCcy[r.currency].in_flight = String(r.amount ?? "0").split(".")[0];
  for (const r of paid.rows) if (byCcy[r.currency]) byCcy[r.currency].withdrawn = String(r.amount ?? "0").split(".")[0];

  for (const c of CCY) {
    const b = byCcy[c];
    b.can_withdraw = BigInt(b.available) >= MIN_WITHDRAW[c];
  }
  return Object.values(byCcy);
}

// ---- sending ----------------------------------------------------------------
async function sendPayout(currency, wallet, amountRaw) {
  return currency === "DROP"
    ? sendTreasuryTransfer(wallet, amountRaw)
    : sendTreasuryMulti(wallet, amountRaw, currency);
}

/* Push a requested payout out of the treasury. Kept separate from the request
   so an admin can retry one that failed without re-claiming any orders — the
   money is already owed and already accounted for. */
async function settle(payout) {
  try {
    const sig = await sendPayout(payout.currency, payout.wallet, String(payout.amount_raw));
    await sql`UPDATE dev_native_payouts
      SET status = 'sent', tx_sig = ${sig}, sent_at = now(), error = NULL
      WHERE id = ${payout.id}`;
    return { ok: true, sig };
  } catch (e) {
    /* Deliberately NOT releasing the orders. They stay claimed by this payout,
       so the amount owed can never be double-claimed while a retry is pending.
       Admin retries the send; nobody has to reconstruct what was owed. */
    await sql`UPDATE dev_native_payouts
      SET status = 'failed', error = ${String(e.message || e).slice(0, 400)}
      WHERE id = ${payout.id}`;
    return { ok: false, error: String(e.message || e) };
  }
}

// ---------------------------------------------------------------------------
export async function nativepayout(req, res, action, b) {
  await migratePayout();

  // ---- what am I owed? -----------------------------------------------------
  if (action === "native-payout-balance") {
    const seller = await sellerFor(b);
    const balances = await balancesFor(seller.id);
    const recent = await sql`
      SELECT id, currency, amount_raw, decimals, status, tx_sig, order_count, requested_at, sent_at, error
      FROM dev_native_payouts WHERE seller_id = ${seller.id}
      ORDER BY requested_at DESC LIMIT 25`;
    return res.status(200).json({
      ok: true, wallet: seller.wallet, balances, payouts: recent.rows,
    });
  }

  // ---- pay me --------------------------------------------------------------
  if (action === "native-payout-request") {
    const seller = await sellerFor(b);
    const currency = CCY.includes(b.currency) ? b.currency : null;
    if (!currency) return res.status(400).json({ error: "pick DROP, USDC or SOL" });

    /* Open the payout row FIRST, at zero. It becomes the claim ticket: orders
       are stamped with its id, and the amount is whatever that stamping
       actually captured. Doing it the other way round — total first, then
       claim — leaves a window where a second request sees the same orders. */
    const opened = await sql`
      INSERT INTO dev_native_payouts(seller_id, wallet, currency, decimals, status)
      VALUES (${seller.id}, ${seller.wallet}, ${currency}, ${decimalsFor(currency)}, 'requested')
      RETURNING id`;
    const payoutId = opened.rows[0].id;

    const claimed = await sql`
      UPDATE dev_native_orders SET payout_id = ${payoutId}
      WHERE seller_id = ${seller.id} AND pay_currency = ${currency}
        AND status = 'complete' AND payout_id IS NULL
      RETURNING payout_amount_raw`;

    const total = claimed.rows.reduce((a, r) => a + BigInt(r.payout_amount_raw), 0n);

    if (total < MIN_WITHDRAW[currency]) {
      // give the orders back and bin the empty ticket
      await sql`UPDATE dev_native_orders SET payout_id = NULL WHERE payout_id = ${payoutId}`;
      await sql`DELETE FROM dev_native_payouts WHERE id = ${payoutId}`;
      const min = Number(MIN_WITHDRAW[currency]) / Math.pow(10, decimalsFor(currency));
      return res.status(400).json({
        error: total === 0n
          ? `Nothing to withdraw in ${currency} yet.`
          : `You need at least ${min} ${currency} to withdraw — a smaller transfer costs more in fees than it pays out.`,
      });
    }

    await sql`UPDATE dev_native_payouts
      SET amount_raw = ${total.toString()}, order_count = ${claimed.rows.length}
      WHERE id = ${payoutId}`;

    const row = { id: payoutId, currency, wallet: seller.wallet, amount_raw: total.toString() };
    const result = await settle(row);

    if (!result.ok) {
      return res.status(502).json({
        ok: false, payout_id: payoutId, state: "failed",
        error: "The transfer did not go through. Your balance is safe and this payout will be retried — nothing was lost.",
        detail: result.error,
      });
    }
    return res.status(200).json({
      ok: true, payout_id: payoutId, state: "sent", tx_sig: result.sig,
      currency, amount_raw: total.toString(), decimals: decimalsFor(currency),
      sales: claimed.rows.length,
    });
  }

  // ---- history -------------------------------------------------------------
  if (action === "native-payout-history") {
    const seller = await sellerFor(b);
    const r = await sql`
      SELECT id, currency, amount_raw, decimals, status, tx_sig, order_count, requested_at, sent_at, error
      FROM dev_native_payouts WHERE seller_id = ${seller.id}
      ORDER BY requested_at DESC LIMIT 200`;
    return res.status(200).json({ ok: true, payouts: r.rows });
  }

  // ---- what does the platform owe, in total? (admin) ------------------------
  if (action === "native-payout-owed") {
    if (req.headers.authorization !== `Bearer ${process.env.ADMIN_SECRET}`) {
      return res.status(403).json({ error: "forbidden" });
    }
    const owed = await sql`
      SELECT o.seller_id, s.wallet, s.studio, o.pay_currency AS currency,
             SUM(o.payout_amount_raw::numeric) AS owed, COUNT(*) AS sales
      FROM dev_native_orders o JOIN dev_sellers s ON s.id = o.seller_id
      WHERE o.status = 'complete' AND o.payout_id IS NULL
      GROUP BY o.seller_id, s.wallet, s.studio, o.pay_currency
      ORDER BY owed DESC`;
    const stuck = await sql`
      SELECT id, seller_id, wallet, currency, amount_raw, decimals, error, requested_at
      FROM dev_native_payouts WHERE status = 'failed' ORDER BY requested_at DESC`;
    return res.status(200).json({ ok: true, owed: owed.rows, failed: stuck.rows });
  }

  // ---- retry a failed send (admin) -----------------------------------------
  if (action === "native-payout-retry") {
    if (req.headers.authorization !== `Bearer ${process.env.ADMIN_SECRET}`) {
      return res.status(403).json({ error: "forbidden" });
    }
    const r = await sql`SELECT * FROM dev_native_payouts WHERE id = ${Number(b.payout_id)}`;
    const p = r.rows[0];
    if (!p) return res.status(404).json({ error: "payout not found" });
    if (p.status === "sent") return res.status(200).json({ ok: true, state: "sent", tx_sig: p.tx_sig });
    await sql`UPDATE dev_native_payouts SET status = 'requested', error = NULL WHERE id = ${p.id}`;
    const result = await settle(p);
    return res.status(result.ok ? 200 : 502).json(
      result.ok ? { ok: true, state: "sent", tx_sig: result.sig }
                : { ok: false, state: "failed", error: result.error });
  }

  return res.status(400).json({ error: `unknown action ${action}` });
}
