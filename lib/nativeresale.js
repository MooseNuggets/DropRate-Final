// ============================================================================
// DROPRATE — Pre-owned game resale (player → player, on-platform).
//
// "Sell it like a disc." An owner lists a copy at a USD price. The copy moves
// into DropRate's escrow wallet (the chain authority) so the listing can't be
// pulled out from under a buyer mid-checkout, and so the seller can't play it
// while it's for sale — same as an item leaving your inventory on a market.
// A buyer pays USDC or SOL to the treasury; the copy is transferred to them
// and the money splits three ways in the buyer's currency:
//
//     seller        100% − royalty − 5%      (70% at the default royalty)
//     developer     royalty (dev-set, ≤ 25%, default 25%)  → their earnings ledger
//     platform      5%                       → stays in the treasury
//
// Delisting returns the copy to the seller. Nothing here can touch a copy
// that isn't in escrow: the authority only moves what it holds.
//
// Dispatched from lib/nativemarket.js for actions starting "native-resale-".
// ============================================================================

import { randomBytes } from "node:crypto";
import { sql } from "./db.js";
import { verifyWalletSignature } from "./vault.js";

export const RESALE_FEE_BPS = Number(process.env.RESALE_FEE_BPS || 500);   // platform 5%
const SIG_TTL = Number(process.env.DEV_SIG_TTL_SEC || 300);
const QUOTE_TTL_MS = 2 * 60 * 1000;
const CCY = ["USDC", "SOL"];
const DEC = { USDC: 6, SOL: 9 };
const httpErr = (code, msg) => { const e = new Error(msg); e.status = code; throw e; };

function assertSig(b) {
  const { wallet, message, signature } = b;
  if (!wallet || !message || !signature) httpErr(400, "wallet, message, signature required");
  if (!message.includes(`wallet:${wallet}`)) httpErr(401, "message/wallet mismatch");
  const m = /ts:(\d+)/.exec(message); const ts = m ? Number(m[1]) : 0;
  if (!ts || Math.abs(Date.now() / 1000 - ts) > SIG_TTL) httpErr(401, "signature expired — retry");
  let ok = false; try { ok = verifyWalletSignature(message, String(signature), wallet); } catch { ok = false; }
  if (!ok) httpErr(401, "signature verification failed");
  return wallet;
}
// base58 32-byte Solana-Pay reference (same as api/crate.js)
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function makeReference() {
  const bytes = randomBytes(32); let zeros = 0; while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [0];
  for (let i = zeros; i < bytes.length; i++) { let carry = bytes[i]; for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; } while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; } }
  let out = "1".repeat(zeros); for (let k = digits.length - 1; k >= 0; k--) out += B58[digits[k]]; return out;
}

/* Money split, no dust: dev and platform legs floored, seller takes the remainder. */
export function splitResale(amountRaw, royaltyBps, feeBps = RESALE_FEE_BPS) {
  const amt = BigInt(amountRaw);
  const devRaw = (amt * BigInt(royaltyBps)) / 10000n;
  const feeRaw = (amt * BigInt(feeBps)) / 10000n;
  return { sellerRaw: amt - devRaw - feeRaw, devRaw, feeRaw };
}
export function amountFor(priceCents, currency, solUsd) {
  if (currency === "USDC") return String(BigInt(priceCents) * 10_000n);
  if (!(solUsd > 0)) httpErr(503, "SOL price unavailable — try again");
  return String(BigInt(Math.round((priceCents / 100 / solUsd) * 1e9)));
}
export function minPriceCents(product) {
  return Math.ceil(Number(product.price_cents || 0) * Number(product.resale_floor_bps || 0) / 10000);
}

let mig = null;
function migrate() { if (!mig) mig = run().catch((e) => { mig = null; throw e; }); return mig; }
async function run() {
  // listings table is created in nativebuy.js's migration (shared); orders here
  await sql`CREATE TABLE IF NOT EXISTS dev_native_resale_orders(
    id serial PRIMARY KEY,
    listing_id int NOT NULL REFERENCES dev_native_listings(id),
    product_id int NOT NULL,
    buyer text NOT NULL,
    seller text NOT NULL,
    pay_currency text NOT NULL,
    pay_decimals int NOT NULL,
    price_cents int NOT NULL,
    amount_raw text NOT NULL,
    seller_raw text NOT NULL,
    dev_raw text NOT NULL,
    fee_raw text NOT NULL,
    royalty_bps int NOT NULL,
    reference text NOT NULL,
    status text NOT NULL DEFAULT 'awaiting_payment',  -- awaiting_payment|paid|delivered|settled|refund_pending|refunded|expired
    paid_sig text,
    transfer_sig text,
    payout_sig text,
    refund_sig text,
    quote_expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    settled_at timestamptz
  )`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_nresale_paid_sig ON dev_native_resale_orders(paid_sig) WHERE paid_sig IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS idx_nresale_listing ON dev_native_resale_orders(listing_id, status)`;
}

async function productFor(pid) {
  const r = await sql`SELECT p.*, s.wallet AS seller_wallet FROM dev_native_products p JOIN dev_sellers s ON s.id = p.seller_id WHERE p.id = ${pid} AND p.deleted = false`;
  if (!r.rows[0]) httpErr(404, "game not found");
  return r.rows[0];
}
async function escrowAddress() {
  const { authorityAddress } = await import("./chain.js");
  return authorityAddress();
}
/* Settle a paid order: copy → buyer, money → seller (now) + dev (ledger).
   Idempotent by status so a retry after a half-failure finishes the job. */
async function settle(o) {
  const l = (await sql`SELECT * FROM dev_native_listings WHERE id = ${o.listing_id}`).rows[0];
  const p = await productFor(o.product_id);
  // 1. deliver the copy
  if (!o.transfer_sig) {
    const { transferFromEscrow, ownerOf } = await import("./chain.js");
    const holder = await ownerOf(l.asset_address);
    let sig = null;
    if (holder === o.buyer) sig = "already-owned";           // a retry after the transfer landed
    else sig = await transferFromEscrow({ assetAddress: l.asset_address, collectionAddress: l.collection_address, toWallet: o.buyer });
    await sql`UPDATE dev_native_resale_orders SET transfer_sig = ${sig}, status = 'delivered' WHERE id = ${o.id}`;
    await sql`UPDATE dev_native_copies SET current_owner = ${o.buyer} WHERE asset_address = ${l.asset_address}`;
    await sql`UPDATE dev_native_listings SET status = 'sold', closed_at = now() WHERE id = ${l.id}`;
    o.transfer_sig = sig;
  }
  // 2. developer's royalty into their earnings (withdrawn from the portal like any sale)
  const already = await sql`SELECT id FROM dev_native_orders WHERE kind = 'resale' AND reference = ${o.reference}`;
  if (!already.rows.length && BigInt(o.dev_raw) > 0n) {
    await sql`INSERT INTO dev_native_orders(product_id, seller_id, buyer, pay_currency, price_cents, pay_amount_raw, pay_decimals,
                payout_amount_raw, fee_bps, reference, status, copy_number, paid_sig, asset_address, quote_expires_at, paid_at, minted_at, kind)
              VALUES (${o.product_id}, ${p.seller_id}, ${o.buyer}, ${o.pay_currency}, ${o.price_cents}, ${o.amount_raw}, ${o.pay_decimals},
                ${o.dev_raw}, ${o.royalty_bps}, ${o.reference}, 'complete', 0, ${o.paid_sig}, ${l.asset_address}, now(), now(), now(), 'resale')`;
  }
  // 3. seller's share, sent now
  if (!o.payout_sig) {
    const { sendTreasuryMulti } = await import("./paymulti.js");
    try {
      const sig = await sendTreasuryMulti(o.seller, o.seller_raw, o.pay_currency);
      await sql`UPDATE dev_native_resale_orders SET payout_sig = ${sig}, status = 'settled', settled_at = now() WHERE id = ${o.id}`;
      return { state: "settled", payout_sig: sig };
    } catch (e) {
      console.error("resale seller payout deferred:", e.message);
      return { state: "delivered", payout_pending: true };
    }
  }
  return { state: "settled", payout_sig: o.payout_sig };
}

// ---------------------------------------------------------------------------
export async function nativeresale(req, res, action, b) {
  await migrate();
  const a = action.replace(/^native-resale-/, "");

  /* ---- what would listing this copy look like? -------------------------- */
  if (a === "quote-list") {
    const wallet = assertSig(b);
    const p = await productFor(Number(b.product_id));
    const c = (await sql`SELECT * FROM dev_native_copies WHERE asset_address = ${String(b.asset_address)} AND product_id = ${p.id}`).rows[0];
    if (!c) httpErr(404, "that copy isn't one we minted for this game");
    const { ownerOf } = await import("./chain.js");
    if ((await ownerOf(c.asset_address)) !== wallet) httpErr(403, "this wallet doesn't hold that copy");
    const cooldownMs = Number(p.resale_cooldown_hours || 0) * 3600e3;
    const since = new Date(c.minted_at).getTime();
    const lastSale = (await sql`SELECT settled_at FROM dev_native_resale_orders WHERE listing_id IN (SELECT id FROM dev_native_listings WHERE asset_address = ${c.asset_address}) AND status = 'settled' ORDER BY id DESC LIMIT 1`).rows[0];
    const held = Math.max(since, lastSale ? new Date(lastSale.settled_at).getTime() : 0);
    const readyAt = held + cooldownMs;
    const royalty = Number(p.royalty_bps || 0);
    return res.status(200).json({
      ok: true, min_price_cents: minPriceCents(p), list_price_cents: p.price_cents,
      royalty_bps: royalty, fee_bps: RESALE_FEE_BPS, seller_bps: 10000 - royalty - RESALE_FEE_BPS,
      cooldown_ok: Date.now() >= readyAt, ready_at: readyAt, escrow: await escrowAddress(),
    });
  }

  /* ---- list: create the listing, hand back the escrow transfer to sign ---- */
  if (a === "list") {
    const wallet = assertSig(b);
    const p = await productFor(Number(b.product_id));
    const c = (await sql`SELECT * FROM dev_native_copies WHERE asset_address = ${String(b.asset_address)} AND product_id = ${p.id}`).rows[0];
    if (!c) httpErr(404, "that copy isn't one we minted for this game");
    const { ownerOf, buildTransferTransaction } = await import("./chain.js");
    if ((await ownerOf(c.asset_address)) !== wallet) httpErr(403, "this wallet doesn't hold that copy");
    const live = await sql`SELECT id FROM dev_native_listings WHERE asset_address = ${c.asset_address} AND status IN ('escrow_pending','active')`;
    if (live.rows.length) httpErr(409, "this copy is already listed");
    const cents = Math.round(Number(b.price_cents));
    if (!Number.isFinite(cents) || cents < 1 || cents > 100_000_00) httpErr(400, "price_cents must be a positive USD-cents amount");
    const floor = minPriceCents(p);
    if (cents < floor) httpErr(400, `the developer's minimum resale price for this game is $${(floor / 100).toFixed(2)}`);
    const cooldownMs = Number(p.resale_cooldown_hours || 0) * 3600e3;
    if (Date.now() < new Date(c.minted_at).getTime() + cooldownMs) httpErr(409, `this copy can be resold after ${new Date(new Date(c.minted_at).getTime() + cooldownMs).toISOString()}`);
    const escrow = await escrowAddress();
    const ins = await sql`INSERT INTO dev_native_listings(product_id, asset_address, collection_address, seller, price_cents, status)
                          VALUES (${p.id}, ${c.asset_address}, ${c.collection_address}, ${wallet}, ${cents}, 'escrow_pending') RETURNING id`;
    const built = await buildTransferTransaction({ assetAddress: c.asset_address, collectionAddress: c.collection_address, fromWallet: wallet, toWallet: escrow });
    return res.status(200).json({ ok: true, listing_id: ins.rows[0].id, escrow, ...built });
  }

  /* ---- list-confirm: seller signed; submit and verify the copy is in escrow */
  if (a === "list-confirm") {
    const l = (await sql`SELECT * FROM dev_native_listings WHERE id = ${Number(b.listing_id)}`).rows[0];
    if (!l) httpErr(404, "listing not found");
    if (l.status === "active") return res.status(200).json({ ok: true, state: "active", already: true });
    if (l.status !== "escrow_pending") httpErr(409, `listing is ${l.status}`);
    const { ownerOf } = await import("./chain.js");
    const escrow = await escrowAddress();
    let sig = l.escrow_sig;
    if (b.signed_tx && !sig) {
      const { submitSignedTransaction } = await import("./solana.js");
      try { sig = await submitSignedTransaction(b.signed_tx); } catch (e) { return res.status(400).json({ error: String(e.message || e) }); }
      await sql`UPDATE dev_native_listings SET escrow_sig = ${sig} WHERE id = ${l.id}`;
    }
    const holder = await ownerOf(l.asset_address);
    if (holder !== escrow) return res.status(202).json({ ok: false, state: "escrow_pending", holder });
    await sql`UPDATE dev_native_listings SET status = 'active', listed_at = now() WHERE id = ${l.id} AND status = 'escrow_pending'`;
    return res.status(200).json({ ok: true, state: "active", escrow_sig: sig });
  }

  /* ---- delist: give the copy back ---------------------------------------- */
  if (a === "delist") {
    const wallet = assertSig(b);
    const l = (await sql`SELECT * FROM dev_native_listings WHERE id = ${Number(b.listing_id)}`).rows[0];
    if (!l) httpErr(404, "listing not found");
    if (l.seller !== wallet) httpErr(403, "not your listing");
    if (!["active", "escrow_pending"].includes(l.status)) httpErr(409, `listing is ${l.status}`);
    const live = await sql`SELECT id FROM dev_native_resale_orders WHERE listing_id = ${l.id} AND status IN ('awaiting_payment','paid','delivered') AND quote_expires_at > now() - interval '10 minutes'`;
    if (live.rows.length) httpErr(409, "a buyer is checking out — try again in a couple of minutes");
    const { ownerOf, transferFromEscrow } = await import("./chain.js");
    // The listing is only closed once the copy is verifiably back with the
    // seller. A null owner read (RPC hiccup) must never turn into "cancelled
    // but still in escrow" — that strands the copy with no listing pointing at it.
    let sig = null;
    let holder = await ownerOf(l.asset_address);
    if (holder !== wallet) {
      try {
        sig = await transferFromEscrow({ assetAddress: l.asset_address, collectionAddress: l.collection_address, toWallet: wallet });
      } catch (e) {
        holder = await ownerOf(l.asset_address);
        if (holder !== wallet) httpErr(502, `couldn't return the copy from escrow: ${String(e.message || e)} — the listing is still open, try again`);
      }
    }
    await sql`UPDATE dev_native_listings SET status = 'cancelled', return_sig = ${sig}, closed_at = now() WHERE id = ${l.id}`;
    return res.status(200).json({ ok: true, state: "cancelled", return_sig: sig });
  }

  /* ---- browse: pre-owned copies for a game (public) ---------------------- */
  if (a === "browse") {
    const pid = Number(b.product_id);
    const p = await productFor(pid);
    const { currentSolUsd } = await import("./paymulti.js");
    const solUsd = await currentSolUsd();
    const rows = await sql`
      SELECT l.id, l.seller, l.price_cents, l.listed_at, c.copy_number
      FROM dev_native_listings l JOIN dev_native_copies c ON c.asset_address = l.asset_address
      WHERE l.product_id = ${pid} AND l.status = 'active'
      ORDER BY l.price_cents ASC, l.id ASC LIMIT 100`;
    const seller = (await sql`SELECT accepted_currencies FROM dev_sellers WHERE id = ${p.seller_id}`).rows[0];
    let accepted = CCY; try { const ac = seller && seller.accepted_currencies; if (Array.isArray(ac) && ac.length) accepted = ac.filter((c) => CCY.includes(c)); } catch {}
    const listings = rows.rows.map((r) => ({
      id: r.id, seller: r.seller, copy_number: r.copy_number, price_cents: r.price_cents, listed_at: r.listed_at,
      usdc_raw: amountFor(r.price_cents, "USDC"), sol_raw: solUsd > 0 ? amountFor(r.price_cents, "SOL", solUsd) : null,
    }));
    return res.status(200).json({ ok: true, listings, accepted_currencies: accepted, solUsd, fee_bps: RESALE_FEE_BPS, royalty_bps: p.royalty_bps, list_price_cents: p.price_cents });
  }

  /* ---- my listings ------------------------------------------------------- */
  if (a === "mine") {
    const wallet = assertSig(b);
    const rows = await sql`SELECT l.*, p.title, p.image FROM dev_native_listings l JOIN dev_native_products p ON p.id = l.product_id WHERE l.seller = ${wallet} ORDER BY l.id DESC LIMIT 100`;
    return res.status(200).json({ ok: true, listings: rows.rows });
  }

  /* ---- buy-open: lock a price in the buyer's currency -------------------- */
  if (a === "buy-open") {
    if (!b.buyer) httpErr(400, "buyer required");
    const l = (await sql`SELECT * FROM dev_native_listings WHERE id = ${Number(b.listing_id)}`).rows[0];
    if (!l || l.status !== "active") httpErr(409, "listing is not active");
    if (l.seller === b.buyer) httpErr(400, "you can't buy your own listing");
    const cur = String(b.pay_currency || "USDC").toUpperCase();
    if (!CCY.includes(cur)) httpErr(400, "pay in USDC or SOL");
    const p = await productFor(l.product_id);
    const live = await sql`SELECT id FROM dev_native_resale_orders WHERE listing_id = ${l.id} AND status = 'awaiting_payment' AND quote_expires_at > now()`;
    if (live.rows.length) httpErr(409, "another buyer is checking out — try again shortly");
    let solUsd = null;
    if (cur === "SOL") { const { currentSolUsd } = await import("./paymulti.js"); solUsd = await currentSolUsd(); }
    const amountRaw = amountFor(l.price_cents, cur, solUsd);
    const royalty = Number(p.royalty_bps || 0);
    const s = splitResale(amountRaw, royalty);
    const reference = makeReference();
    const ins = await sql`INSERT INTO dev_native_resale_orders(listing_id, product_id, buyer, seller, pay_currency, pay_decimals, price_cents, amount_raw, seller_raw, dev_raw, fee_raw, royalty_bps, reference, quote_expires_at)
      VALUES (${l.id}, ${l.product_id}, ${b.buyer}, ${l.seller}, ${cur}, ${DEC[cur]}, ${l.price_cents}, ${amountRaw}, ${s.sellerRaw.toString()}, ${s.devRaw.toString()}, ${s.feeRaw.toString()}, ${royalty}, ${reference}, to_timestamp(${(Date.now() + QUOTE_TTL_MS) / 1000})) RETURNING id`;
    return res.status(200).json({ ok: true, order_id: ins.rows[0].id, reference, currency: cur, decimals: DEC[cur], amount_raw: amountRaw, price_cents: l.price_cents, expires_at: Date.now() + QUOTE_TTL_MS,
      split: { seller_raw: s.sellerRaw.toString(), dev_raw: s.devRaw.toString(), fee_raw: s.feeRaw.toString(), royalty_bps: royalty, fee_bps: RESALE_FEE_BPS } });
  }

  /* ---- buy-buildpay: buyer pays the treasury; reference on the transfer --- */
  if (a === "buy-buildpay") {
    const o = (await sql`SELECT * FROM dev_native_resale_orders WHERE id = ${Number(b.order_id)}`).rows[0];
    if (!o) httpErr(404, "order not found");
    if (o.buyer !== b.payer) httpErr(403, "not your order");
    if (o.status !== "awaiting_payment") httpErr(409, `order is ${o.status}`);
    if (new Date(o.quote_expires_at).getTime() < Date.now()) httpErr(409, "quote expired — start again");
    const { buildDirectPaymentMulti } = await import("./paymulti.js");
    const built = await buildDirectPaymentMulti(o.buyer, o.reference, process.env.TREASURY_WALLET, o.amount_raw, o.pay_currency);
    return res.status(200).json({ ok: true, order_id: o.id, currency: o.pay_currency, amount_raw: o.amount_raw, ...built });
  }

  /* ---- buy-confirm: verify payment, deliver the copy, split the money ---- */
  if (a === "buy-confirm") {
    const o = (await sql`SELECT * FROM dev_native_resale_orders WHERE id = ${Number(b.order_id)}`).rows[0];
    if (!o) httpErr(404, "order not found");
    if (o.status === "settled") return res.status(200).json({ ok: true, state: "settled", already: true });
    if (o.status === "refunded") return res.status(200).json({ ok: false, state: "refunded", already: true });
    if (o.status === "paid" || o.status === "delivered") { const r = await settle(o); return res.status(200).json({ ok: true, ...r }); }
    if (o.status !== "awaiting_payment") httpErr(409, `order is ${o.status}`);
    const { findDirectPayment, resolveUsdcAta } = await import("./paymulti.js");
    const found = await findDirectPayment(o.reference, o.pay_currency);
    if (!found) return res.status(402).json({ error: "payment-not-found" });
    const dest = o.pay_currency === "SOL" ? process.env.TREASURY_WALLET : await resolveUsdcAta(process.env.TREASURY_WALLET);
    const got = (found.legs || []).filter((x) => String(x.destination) === String(dest)).reduce((acc, x) => acc + BigInt(x.amountRaw), 0n);
    if (got < BigInt(o.amount_raw)) return res.status(400).json({ error: `underpaid: got ${got} want ${o.amount_raw}` });
    if (new Date(o.quote_expires_at).getTime() + 10 * 60e3 < Date.now()) { /* late but paid: still honour it */ }
    try { await sql`UPDATE dev_native_resale_orders SET paid_sig = ${found.signature}, status = 'paid' WHERE id = ${o.id} AND status = 'awaiting_payment'`; }
    catch { return res.status(409).json({ error: "payment-already-used" }); }
    o.paid_sig = found.signature; o.status = "paid";
    // The listing might have been cancelled between quote and payment. Refund.
    const l = (await sql`SELECT status FROM dev_native_listings WHERE id = ${o.listing_id}`).rows[0];
    if (!l || l.status !== "active") {
      const { sendTreasuryMulti } = await import("./paymulti.js");
      try { const sig = await sendTreasuryMulti(o.buyer, o.amount_raw, o.pay_currency); await sql`UPDATE dev_native_resale_orders SET status = 'refunded', refund_sig = ${sig}, settled_at = now() WHERE id = ${o.id}`; }
      catch { await sql`UPDATE dev_native_resale_orders SET status = 'refund_pending' WHERE id = ${o.id}`; }
      return res.status(200).json({ ok: false, state: "refunded", reason: "that copy was no longer for sale — you've been refunded" });
    }
    const r = await settle(o);
    return res.status(200).json({ ok: true, ...r });
  }

  /* ---- sweep (cron): retry stuck payouts / refunds, expire stale escrows --- */
  if (a === "sweep") {
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: "unauthorized" });
    let settled = 0, refunded = 0, expired = 0;
    for (const o of (await sql`SELECT * FROM dev_native_resale_orders WHERE status IN ('paid','delivered') AND created_at < now() - interval '2 minutes' ORDER BY id LIMIT 20`).rows) {
      try { const r = await settle(o); if (r.state === "settled") settled++; } catch (e) { console.error("resale sweep settle:", e.message); }
    }
    for (const o of (await sql`SELECT * FROM dev_native_resale_orders WHERE status = 'refund_pending' ORDER BY id LIMIT 20`).rows) {
      try { const { sendTreasuryMulti } = await import("./paymulti.js"); const sig = await sendTreasuryMulti(o.buyer, o.amount_raw, o.pay_currency);
        await sql`UPDATE dev_native_resale_orders SET status = 'refunded', refund_sig = ${sig}, settled_at = now() WHERE id = ${o.id}`; refunded++; } catch (e) { console.error("resale sweep refund:", e.message); }
    }
    // a listing whose escrow transfer never landed within an hour is dead
    const ex = await sql`UPDATE dev_native_listings SET status = 'expired', closed_at = now() WHERE status = 'escrow_pending' AND created_at < now() - interval '1 hour'`;
    expired = ex.rowCount || 0;
    return res.status(200).json({ ok: true, settled, refunded, expired });
  }

  return res.status(400).json({ error: `unknown resale action "${a}"` });
}
