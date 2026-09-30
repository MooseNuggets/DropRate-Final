// lib/nativerent.js — developer-offered game rentals.
//
// A rental is time on the play gate, nothing more. No copy is minted, nothing
// moves on-chain, no supply is consumed: the player pays, we record a window,
// and every place that asks "may this wallet play?" (web ticket, launcher
// ticket, downloads, the play page) says yes until the window closes. Because
// the SDK keys saves and achievements to the wallet, a renter's progress
// outlives the rental — which is what makes rent-to-own work.
//
// Money: same split as a new sale. Flat 5% platform fee, developer keeps 95%,
// paid into the same earnings balance they withdraw from the portal.
//
// Rent-to-own (developer opt-in): rental fees this wallet paid for this game in
// the last 30 days come off the purchase price. If they cover it, the copy is
// minted with no payment at all.
//
// Actions (all "native-rent-*", dispatched from nativemarket.js):
//   quote    public   price for N days, limits, rent-to-own flag
//   open     buyer    lock a price in USDC or SOL (15 min), open the rental
//   buildpay buyer    unsigned payment tx to the treasury
//   confirm  anyone   find the payment on-chain, activate the rental
//   mine     signed   this wallet's rentals (active first)

import { sql } from "./db.js";
import { verifyWalletSignature } from "./vault.js";
import { currentSolUsd, buildDirectPaymentMulti, findDirectPayment, resolveUsdcAta } from "./paymulti.js";
import { buyHelpers } from "./nativebuy.js";

const { loadProduct, quoteRaw, ccyDecimals, makeReference, requireTreasury, feeBpsFor, httpErr, CCY, QUOTE_TTL_SEC } = buyHelpers;

export const RENT_MAX_DAYS_CAP = 90;      // no developer may offer longer than this
export const RENT_TO_OWN_WINDOW_DAYS = 30; // rental fees count toward a purchase for this long
const SIG_TTL = 300;

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

// ---------------------------------------------------------------------------
let _migrated = null;
export function migrateRent() { return _migrated || (_migrated = runMigrate().catch((e) => { _migrated = null; throw e; })); }
async function runMigrate() {
  await sql`ALTER TABLE dev_native_products ADD COLUMN IF NOT EXISTS rent_enabled boolean NOT NULL DEFAULT false`;
  await sql`ALTER TABLE dev_native_products ADD COLUMN IF NOT EXISTS rent_cents_per_day int NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE dev_native_products ADD COLUMN IF NOT EXISTS rent_min_days int NOT NULL DEFAULT 1`;
  await sql`ALTER TABLE dev_native_products ADD COLUMN IF NOT EXISTS rent_max_days int NOT NULL DEFAULT 14`;
  await sql`ALTER TABLE dev_native_products ADD COLUMN IF NOT EXISTS rent_to_own boolean NOT NULL DEFAULT false`;
  await sql`ALTER TABLE dev_native_orders ADD COLUMN IF NOT EXISTS credit_cents int NOT NULL DEFAULT 0`;
  await sql`CREATE TABLE IF NOT EXISTS dev_native_rentals (
    id serial PRIMARY KEY,
    product_id int NOT NULL,
    seller_id int NOT NULL,
    wallet text NOT NULL,
    days int NOT NULL,
    price_cents int NOT NULL,                 -- USD total for the term
    pay_currency text NOT NULL,
    pay_decimals int NOT NULL,
    pay_amount_raw text NOT NULL,
    payout_amount_raw text NOT NULL,
    fee_bps int NOT NULL,
    reference text NOT NULL UNIQUE,
    status text NOT NULL DEFAULT 'created',   -- created | active | expired(derived) | abandoned
    paid_sig text UNIQUE,
    quote_expires_at timestamptz NOT NULL,
    starts_at timestamptz,
    expires_at timestamptz,
    applied_order_id int,                     -- rent-to-own: the purchase this fee was credited to
    created_at timestamptz NOT NULL DEFAULT now(),
    paid_at timestamptz
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_rent_wallet ON dev_native_rentals(wallet, product_id, status)`;
}

// ---------------------------------------------------------------------------
/** The live rental for this wallet+game, or null. */
export async function activeRental(productId, wallet) {
  await migrateRent();
  const r = await sql`
    SELECT id, expires_at, days, starts_at FROM dev_native_rentals
    WHERE product_id = ${Number(productId)} AND wallet = ${String(wallet)} AND status = 'active' AND expires_at > now()
    ORDER BY expires_at DESC LIMIT 1`;
  return r.rows[0] || null;
}

/** Rent-to-own credit in cents: paid rentals in the window that haven't been
    consumed by a purchase that actually went through. */
export async function rentalCredit(productId, wallet) {
  await migrateRent();
  const r = await sql`
    SELECT COALESCE(SUM(r.price_cents), 0)::int AS cents, array_agg(r.id) AS ids
    FROM dev_native_rentals r
    WHERE r.product_id = ${Number(productId)} AND r.wallet = ${String(wallet)}
      AND r.status = 'active' AND r.paid_at > now() - (${RENT_TO_OWN_WINDOW_DAYS} || ' days')::interval
      AND NOT EXISTS (SELECT 1 FROM dev_native_orders o WHERE o.id = r.applied_order_id
                        AND (o.status IN ('paid','minting','complete')
                             OR (o.status = 'created' AND o.quote_expires_at > now())))`;
  const row = r.rows[0] || { cents: 0, ids: null };
  return { cents: Number(row.cents || 0), ids: (row.ids || []).filter((x) => x != null) };
}

/** Bind the credited rentals to a purchase order so they can't be spent twice.
    A pending order reserves them until its quote expires; a paid one keeps them. */
export async function applyRentalCredit(rentalIds, orderId) {
  if (!rentalIds || !rentalIds.length) return;
  await sql`UPDATE dev_native_rentals SET applied_order_id = ${Number(orderId)} WHERE id = ANY(${rentalIds.map(Number)})`;
}

/** Before a credited order is marked paid: are its rentals still its own? A
    late payment on an order whose credit has since gone to another, completed
    purchase must not get the discount twice. */
export async function creditStillHeld(orderId) {
  const lost = await sql`
    SELECT count(*)::int AS n FROM dev_native_orders me
    JOIN dev_native_orders other ON other.buyer = me.buyer AND other.product_id = me.product_id AND other.id <> me.id
    WHERE me.id = ${Number(orderId)} AND me.credit_cents > 0 AND other.credit_cents > 0
      AND other.status IN ('paid','minting','complete') AND other.created_at > me.created_at`;
  return Number(lost.rows[0]?.n || 0) === 0;
}

/* Developer's 95% into the same earnings balance a sale goes to. Keyed by the
   rental's reference so it is written exactly once however many times confirm runs. */
async function ensureEarnings(r, paidSig) {
  const already = await sql`SELECT id FROM dev_native_orders WHERE kind = 'rental' AND reference = ${r.reference}`;
  if (already.rows.length) return;
  try {
    await sql`INSERT INTO dev_native_orders(product_id, seller_id, buyer, pay_currency, price_cents, pay_amount_raw, pay_decimals,
                payout_amount_raw, fee_bps, reference, status, copy_number, paid_sig, quote_expires_at, paid_at, minted_at, kind)
              VALUES (${r.product_id}, ${r.seller_id}, ${r.wallet}, ${r.pay_currency}, ${r.price_cents}, ${r.pay_amount_raw}, ${r.pay_decimals},
                ${r.payout_amount_raw}, ${r.fee_bps}, ${r.reference}, 'complete', 0, ${paidSig}, now(), now(), now(), 'rental')`;
  } catch (e) {
    // a duplicate here means this exact payment already funded an earnings row;
    // never fail the renter's confirm over bookkeeping — log it loudly instead
    console.error("rental earnings row failed:", r.id, r.reference, e.message);
  }
}

function rentTerms(p) {
  const perDay = Number(p.rent_cents_per_day || 0);
  const min = Math.max(1, Number(p.rent_min_days || 1));
  const max = Math.max(min, Math.min(RENT_MAX_DAYS_CAP, Number(p.rent_max_days || 14)));
  return { enabled: !!p.rent_enabled && perDay > 0, per_day_cents: perDay, min_days: min, max_days: max, rent_to_own: !!p.rent_to_own };
}

function rentable(p) {
  return p && p.active && !p.deleted && p.review_status === "approved" && p.seller_status === "approved";
}

// ---------------------------------------------------------------------------
export async function nativerent(req, res, action, b) {
  await migrateRent();
  const a = action.replace(/^native-rent-/, "");

  /* ---- quote: what does N days cost? ------------------------------------- */
  if (a === "quote") {
    const p = await loadProduct(Number(b.product_id));
    if (!rentable(p)) httpErr(404, "not available");
    const t = rentTerms(p);
    if (!t.enabled) return res.status(200).json({ ok: true, enabled: false });
    const days = Math.max(t.min_days, Math.min(t.max_days, Math.round(Number(b.days) || t.min_days)));
    const total = days * t.per_day_cents;
    const accepted = (p.accepted_currencies || CCY).filter((c) => CCY.includes(c));
    const solUsd = await currentSolUsd().catch(() => null);
    const out = { ok: true, enabled: true, ...t, days, total_cents: total, list_price_cents: p.price_cents, accepted_currencies: accepted,
      usdc_raw: quoteRaw(total / 100, "USDC", {}).toString(), sol_raw: solUsd ? quoteRaw(total / 100, "SOL", { sol: solUsd }).toString() : null, solUsd };
    // a signed caller also learns their rent-to-own credit and any live rental
    if (b.wallet && b.signature) {
      try {
        const w = assertSig(b);
        const live = await activeRental(p.id, w);
        out.active = live ? { expires_at: live.expires_at, days: live.days } : null;
        if (t.rent_to_own) out.credit_cents = Math.min(p.price_cents, (await rentalCredit(p.id, w)).cents);
      } catch {}
    }
    return res.status(200).json(out);
  }

  /* ---- open: lock a price, open the rental -------------------------------- */
  if (a === "open") {
    const wallet = String(b.renter || b.wallet || "").trim();
    if (!wallet) httpErr(400, "renter wallet required");
    const cur = b.pay_currency;
    if (!CCY.includes(cur)) httpErr(400, "rentals are paid for in USDC or SOL");
    const p = await loadProduct(Number(b.product_id));
    if (!rentable(p)) httpErr(404, "not available");
    const t = rentTerms(p);
    if (!t.enabled) httpErr(409, "this game isn't offered for rent");
    const accepted = (p.accepted_currencies || CCY).filter((c) => CCY.includes(c));
    if (!accepted.includes(cur)) httpErr(400, `this developer doesn't accept ${cur}`);
    const days = Math.round(Number(b.days));
    if (!Number.isFinite(days) || days < t.min_days || days > t.max_days) httpErr(400, `rent for ${t.min_days}–${t.max_days} days`);
    const total = days * t.per_day_cents;
    const solUsd = cur === "SOL" ? await currentSolUsd().catch(() => null) : null;
    if (cur === "SOL" && !solUsd) httpErr(503, "SOL price feed unavailable — try again");
    const grossRaw = quoteRaw(total / 100, cur, { sol: solUsd });
    if (grossRaw == null || grossRaw <= 0n) httpErr(503, "could not price this rental — try again");
    const feeBps = feeBpsFor(cur);
    const netRaw = grossRaw - (grossRaw * BigInt(feeBps)) / 10000n;
    const reference = makeReference();
    const expires = new Date(Date.now() + QUOTE_TTL_SEC * 1000).toISOString();
    const ins = await sql`
      INSERT INTO dev_native_rentals(product_id, seller_id, wallet, days, price_cents, pay_currency, pay_decimals,
        pay_amount_raw, payout_amount_raw, fee_bps, reference, status, quote_expires_at)
      VALUES (${p.id}, ${p.seller_id}, ${wallet}, ${days}, ${total}, ${cur}, ${ccyDecimals(cur)},
        ${grossRaw.toString()}, ${netRaw.toString()}, ${feeBps}, ${reference}, 'created', ${expires})
      RETURNING id`;
    return res.status(200).json({ ok: true, rental_id: ins.rows[0].id, reference, treasury: requireTreasury(),
      pay_currency: cur, pay_amount_raw: grossRaw.toString(), decimals: ccyDecimals(cur), days, total_cents: total, expires_at: expires, title: p.title });
  }

  /* ---- buildpay: the renter-signed transfer to the treasury -------------- */
  if (a === "buildpay") {
    const r = (await sql`SELECT * FROM dev_native_rentals WHERE id = ${Number(b.rental_id)}`).rows[0];
    if (!r) httpErr(404, "rental not found");
    if (r.status !== "created") httpErr(409, `rental is ${r.status}`);
    if (new Date(r.quote_expires_at).getTime() < Date.now()) httpErr(410, "quote expired — start again");
    const payer = String(b.payer || r.wallet);
    const built = await buildDirectPaymentMulti(payer, r.reference, requireTreasury(), r.pay_amount_raw, r.pay_currency);
    return res.status(200).json({ ok: true, ...built });
  }

  /* ---- confirm: payment found → rental active, developer credited --------- */
  if (a === "confirm") {
    const r = (await sql`SELECT * FROM dev_native_rentals WHERE id = ${Number(b.rental_id)}`).rows[0];
    if (!r) httpErr(404, "rental not found");
    if (r.status === "active") {
      // idempotent: a retry after a crash between activation and the earnings
      // row must still leave the developer paid
      await ensureEarnings(r, r.paid_sig);
      return res.status(200).json({ ok: true, state: "active", expires_at: r.expires_at, starts_at: r.starts_at, days: r.days });
    }
    if (r.status !== "created") httpErr(409, `rental is ${r.status}`);
    const found = await findDirectPayment(r.reference, r.pay_currency);
    if (!found) return res.status(402).json({ error: "payment-not-found" });
    const dest = r.pay_currency === "SOL" ? requireTreasury() : await resolveUsdcAta(requireTreasury());
    const paid = (found.legs || []).filter((l) => String(l.destination) === String(dest)).reduce((s, l) => s + BigInt(l.amountRaw), 0n);
    if (paid < BigInt(r.pay_amount_raw)) return res.status(400).json({ error: "invalid-payment", reasons: ["underpaid or wrong destination"] });

    // A live rental extends rather than overlaps: new time starts when the old runs out.
    const live = await activeRental(r.product_id, r.wallet);
    const startMs = Math.max(Date.now(), live ? new Date(live.expires_at).getTime() : 0);
    const starts = new Date(startMs).toISOString();
    const ends = new Date(startMs + r.days * 86400e3).toISOString();
    let bound;
    try {
      bound = await sql`UPDATE dev_native_rentals SET status = 'active', paid_sig = ${found.signature}, paid_at = now(),
        starts_at = ${starts}, expires_at = ${ends} WHERE id = ${r.id} AND paid_sig IS NULL RETURNING id`;
    } catch { httpErr(409, "payment-already-used"); }
    if (!bound.rows.length) httpErr(409, "rental already settled");

    await ensureEarnings(r, found.signature);
    return res.status(200).json({ ok: true, state: "active", starts_at: starts, expires_at: ends, days: r.days });
  }

  /* ---- mine: this wallet's rentals ---------------------------------------- */
  if (a === "mine") {
    const wallet = assertSig(b);
    const rows = await sql`
      SELECT r.id, r.product_id, r.days, r.price_cents, r.starts_at, r.expires_at, r.paid_at,
             (r.status = 'active' AND r.expires_at > now()) AS live,
             p.title, p.slug, p.image, p.runtime, p.price_cents AS list_price_cents, p.rent_to_own
      FROM dev_native_rentals r JOIN dev_native_products p ON p.id = r.product_id
      WHERE r.wallet = ${wallet} AND r.status = 'active'
      ORDER BY (r.expires_at > now()) DESC, r.expires_at DESC LIMIT 100`;
    return res.status(200).json({ ok: true, rentals: rows.rows });
  }

  httpErr(400, `unknown rental action ${action}`);
}
