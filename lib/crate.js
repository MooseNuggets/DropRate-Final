// ============================================================================
// DROPRATE — Crate open/resolve/reveal API (NEW ROUTE)
//
// On-chain payment verification + refunds are WIRED (lib/oracle.js for price,
// lib/solana.js for the 4-leg confirm and the treasury refund). A GATE seals the
// whole route until GACHA_ENABLED=1, and to an allowlist while GACHA_ALLOWLIST is
// set — so it runs live but only for you until you flip it public.
// ============================================================================
import { randomUUID } from "node:crypto";
import { sql } from "../lib/db.js";
import { migrateGacha, bucketCounts } from "../lib/gacha-db.js";
import { CRATES, buybackRaw, CLAIM_WINDOW_SEC, tokensForCrate } from "../lib/gacha.js";
import { commitRound, roundReadyAt, canOpen, resolveRarity, claimDeadlineSec, withinClaimWindow } from "../lib/crate.js";
import { quoteCrate, splitPayment, validateTransfer, verifySplitLegs, makeReference } from "../lib/payment.js";
import { fetchRandomness } from "../lib/draw.js";
import { decryptCode, verifyWalletSignature } from "../lib/vault.js";
import { currentDropUsd } from "../lib/oracle.js";
const nowUnix = () => Math.floor(Date.now() / 1000);
const DECIMALS = Number(process.env.DROP_DECIMALS || 6);
// --- HIDDEN-DEPLOY GATE -----------------------------------------------------
const ALLOWLIST = (process.env.GACHA_ALLOWLIST || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
function gateOrDie(owner) {
  const on = /^(1|true|yes|on)$/i.test(String(process.env.GACHA_ENABLED || ""));
  if (!on) { const e = new Error("gacha-disabled"); e.http = 403; throw e; }
  if (ALLOWLIST.length && !ALLOWLIST.includes(String(owner))) {
    const e = new Error("not-on-allowlist"); e.http = 403; throw e;
  }
}
// --- on-chain / oracle SEAMS (wired to lib/oracle.js + lib/solana.js) --------
async function fetchPaidTransfer(reference, expected) {
  const { findPaymentByReference, resolveSplitAtas } = await import("../lib/solana.js");
  const found = await findPaymentByReference(reference);
  if (!found) return null; // not on-chain yet -> client retries
  const atas = await resolveSplitAtas();
  const split = verifySplitLegs(found.legs, found.burnedRaw, {
      treasury: atas.treasury, lp: atas.lp, marketing: atas.marketing, totalRaw: expected.amountRaw,
    });
  return {
    mint: process.env.DROP_MINT,
    destination: atas.treasury,
    amountRaw: split.ok ? split.totalRaw : "0",
    reference,
    sender: found.sender,
    signature: found.signature,
    splitOk: split.ok,
    splitReasons: split.reasons,
  };
}
async function dispatchRefund(toWallet, amountRaw) {
  const { sendTreasuryTransfer } = await import("../lib/solana.js");
  return sendTreasuryTransfer(toWallet, amountRaw);
}
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    await migrateGacha();
    // --- MARKETPLACE columns (idempotent; additive on top of migrateGacha) ---
    // `listed` boolean already exists on pulls; add the seller's asking price
    // (USD cents) and when it was listed. No new table — a listing is just a
    // sealed/kept pull flagged listed=true with a price.
    await sql`ALTER TABLE pulls ADD COLUMN IF NOT EXISTS list_price_cents int`;
    await sql`ALTER TABLE pulls ADD COLUMN IF NOT EXISTS listed_at timestamptz`;
    // ripped_by preserves the ORIGINAL puller after a resale flips owner -> buyer
    // (provenance + verify stay intact). purchases is the escrow ledger for P2P
    // sales: buyer pays treasury, treasury forwards to seller once the key flips.
    await sql`ALTER TABLE pulls ADD COLUMN IF NOT EXISTS ripped_by text`;
    await sql`CREATE TABLE IF NOT EXISTS purchases(
      id serial PRIMARY KEY,
      pull_id int NOT NULL REFERENCES pulls(id),
      buyer text NOT NULL,
      seller text NOT NULL,
      reference text NOT NULL,
      amount_quoted_raw numeric NOT NULL,
      price_cents int NOT NULL,
      quote_expires_at timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'awaiting_payment',
      paid_sig text,
      payout_sig text,
      refund_sig text,
      created_at timestamptz NOT NULL DEFAULT now(),
      settled_at timestamptz
    )`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_purchase_paid_sig ON purchases(paid_sig) WHERE paid_sig IS NOT NULL`;
    const b = req.body ?? {};
   // ---- PRICE: public live $DROP price + per-crate token amounts ---------
    if (b.action === "price") {
      const dropUsd = await currentDropUsd();
      const crates = {};
      for (const [k, c] of Object.entries(CRATES)) {
        crates[k] = { usdCents: c.priceUsdCents, dropRaw: tokensForCrate(c.priceUsdCents, dropUsd, DECIMALS).toString() };
      }
      return res.status(200).json({ ok: true, dropUsd, decimals: DECIMALS, crates });
    }

    // ---- OPEN ------------------------------------------------------------
    if (b.action === "open") {
      const crate = CRATES[b.crate];
      if (!crate) return res.status(400).json({ error: "unknown crate" });
      if (!b.owner) return res.status(400).json({ error: "owner required" });
      gateOrDie(b.owner);
      const stock = await bucketCounts();
      if (!canOpen(b.crate, stock)) return res.status(409).json({ error: "out-of-stock", stock });
      const dropUsd = await currentDropUsd();
      const q = quoteCrate(b.crate, dropUsd, { nowMs: Date.now(), decimals: DECIMALS });
      const ins = await sql`
        INSERT INTO pulls(owner, crate, rarity, paid_raw, reference, amount_quoted_raw, quote_expires_at, nonce, state)
        VALUES (${b.owner}, ${b.crate}, '', ${q.amountRaw}, ${q.reference}, ${q.amountRaw},
                to_timestamp(${q.expiresAt / 1000}), ${randomUUID()}, 'awaiting_payment')
        RETURNING id`;
      const pullId = ins.rows[0].id;
      return res.status(200).json({
        ok: true, pullId,
        pay: {
          splToken: process.env.DROP_MINT,
          amountRaw: q.amountRaw,
          reference: q.reference,
          memo: `DROPRATE crate:${b.crate} pull:${pullId}`,
        },
        expiresAt: q.expiresAt,
      });
    }
    // ---- CONFIRM ---------------------------------------------------------
    if (b.action === "confirm") {
      const qy = await sql`SELECT * FROM pulls WHERE id = ${Number(b.pullId)}`;
      const pull = qy.rows[0];
      if (!pull) return res.status(404).json({ error: "no such pull" });
      gateOrDie(pull.owner);
      if (pull.state !== "awaiting_payment") return res.status(200).json({ state: pull.state });
      const transfer = await fetchPaidTransfer(pull.reference, { amountRaw: pull.amount_quoted_raw });
      if (!transfer) return res.status(402).json({ error: "payment-not-found" });
      if (!transfer.splitOk) return res.status(400).json({ error: "invalid-payment", reasons: transfer.splitReasons });
      const v = validateTransfer(transfer, {
        mint: process.env.DROP_MINT, destination: transfer.destination,
        amountRaw: pull.amount_quoted_raw, reference: pull.reference,
        expiresAt: new Date(pull.quote_expires_at).getTime(),
      }, { nowMs: Date.now(), underpayToleranceBps: 0 });
      if (!v.ok) return res.status(400).json({ error: "invalid-payment", reasons: v.reasons });
      try {
        await sql`UPDATE pulls SET paid = true, paid_sig = ${transfer.signature}, paid_raw = ${v.amountRaw} WHERE id = ${pull.id}`;
      } catch {
        return res.status(409).json({ error: "payment-already-used" });
      }
      const { treasuryRaw, burnRaw, lpRaw, marketingRaw } = splitPayment(v.amountRaw);
      for (const [type, amt] of [["treasury", treasuryRaw], ["burn", burnRaw], ["lp", lpRaw], ["marketing", marketingRaw]]) {
        await sql`INSERT INTO settlements(pull_id, type, amount_raw, status, sig, sent_at)
                  VALUES (${pull.id}, ${type}, ${amt.toString()}, 'confirmed', ${transfer.signature}, now()) ON CONFLICT DO NOTHING`;
      }
      const round = commitRound(nowUnix());
      await sql`UPDATE pulls SET drand_round = ${round}, state = 'committing' WHERE id = ${pull.id}`;
      return res.status(200).json({ ok: true, state: "committing", round, readyAt: roundReadyAt(round) });
    }
    // ---- BUILDPAY: server-build the 4-way split tx for the buyer to sign ---
    if (b.action === "buildpay") {
      const qy = await sql`SELECT * FROM pulls WHERE id = ${Number(b.pullId)}`;
      const pull = qy.rows[0];
      if (!pull) return res.status(404).json({ error: "no such pull" });
      gateOrDie(pull.owner);
      if (pull.state !== "awaiting_payment") return res.status(409).json({ error: `not awaiting payment (${pull.state})` });
      if (!b.payer) return res.status(400).json({ error: "payer required" });
      const s = splitPayment(pull.amount_quoted_raw);
      const { buildSplitPaymentTx } = await import("../lib/solana.js");
      const built = await buildSplitPaymentTx(b.payer, pull.reference, {
        treasuryRaw: s.treasuryRaw.toString(), burnRaw: s.burnRaw.toString(),
        lpRaw: s.lpRaw.toString(), marketingRaw: s.marketingRaw.toString(),
      });
      return res.status(200).json({ ok: true, pullId: pull.id, amountRaw: pull.amount_quoted_raw, ...built });
    }
    // ---- RESOLVE ---------------------------------------------------------
    if (b.action === "resolve") {
      const q = await sql`SELECT * FROM pulls WHERE id = ${Number(b.pullId)}`;
      const pull = q.rows[0];
      if (!pull) return res.status(404).json({ error: "no such pull" });
      gateOrDie(pull.owner);
      if (pull.state !== "committing") return res.status(200).json({ state: pull.state, rarity: pull.rarity });
      if (nowUnix() < roundReadyAt(Number(pull.drand_round))) {
        return res.status(425).json({ error: "too-early", readyAt: roundReadyAt(Number(pull.drand_round)) });
      }
      const seed = await fetchRandomness(Number(pull.drand_round));
      const pityRow = await sql`SELECT misses FROM pity WHERE owner = ${pull.owner} AND crate = ${pull.crate}`;
      const misses = pityRow.rows[0]?.misses ?? 0;
      const roll = resolveRarity(pull.crate, seed, pull.nonce, misses);
      const claim = await sql`
        UPDATE crate_keys SET status = 'sealed'
        WHERE id = (SELECT id FROM crate_keys WHERE rarity = ${roll.rarity} AND status = 'available'
                    ORDER BY id ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id, game_title, image, msrp_cents`;
      await sql`
        INSERT INTO pity(owner, crate, misses) VALUES (${pull.owner}, ${pull.crate}, ${roll.missesSinceEpic})
        ON CONFLICT (owner, crate) DO UPDATE SET misses = ${roll.missesSinceEpic}`;
      if (!claim.rows.length) {
        await sql`UPDATE pulls SET rarity = ${roll.rarity}, seed = ${seed}, state = 'owed', resolved_at = now() WHERE id = ${pull.id}`;
        return res.status(200).json({ state: "owed", rarity: roll.rarity });
      }
      const key = claim.rows[0];
      const deadlineSec = claimDeadlineSec(nowUnix());
      await sql`
        UPDATE pulls SET rarity = ${roll.rarity}, seed = ${seed}, key_id = ${key.id},
          state = 'sealed', misses_since_floor = ${roll.missesSinceEpic},
          decision_deadline = to_timestamp(${deadlineSec}), resolved_at = now()
        WHERE id = ${pull.id}`;
      return res.status(200).json({
        state: "sealed", rarity: roll.rarity, forced: roll.forced,
        game_title: key.game_title, image: key.image, msrp_cents: key.msrp_cents,
        decision_deadline: deadlineSec * 1000, claim_window_sec: CLAIM_WINDOW_SEC,
      });
    }
// ---- SWEEP: finalize expired pulls + retry any stuck refunds (cron) ---
    if (b.action === "sweep") {
      if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: "unauthorized" });
      }
      // sealed + past deadline -> kept (sell-back closes; key still claimable)
      const r = await sql`UPDATE pulls SET state = 'kept' WHERE state = 'sealed' AND decision_deadline < now()`;
      // Self-healing refunds: any refund settlement still 'pending' after 2 minutes
      // (the immediate dispatch failed — e.g. treasury briefly out of SOL, RPC blip)
      // gets retried here. The 2-minute floor avoids racing a live sell-back request.
      let refundsSent = 0, refundsFailed = 0;
      const pend = await sql`
        SELECT s.id, s.amount_raw, p.owner
        FROM settlements s JOIN pulls p ON p.id = s.pull_id
        WHERE s.type = 'refund' AND s.status = 'pending' AND s.created_at < now() - interval '2 minutes'
        ORDER BY s.id ASC LIMIT 25`;
      for (const row of pend.rows) {
        try {
          const sig = await dispatchRefund(row.owner, String(row.amount_raw));
          await sql`UPDATE settlements SET status = 'sent', sig = ${sig}, sent_at = now() WHERE id = ${row.id}`;
          refundsSent++;
        } catch (e) {
          console.error("sweep refund retry failed:", e.message);
          refundsFailed++;
        }
      }
      // Marketplace escrow self-heal: retry stuck seller payouts + buyer refunds.
      let payoutsSent = 0, mktRefundsSent = 0;
      const pp = await sql`SELECT id, seller, amount_quoted_raw FROM purchases WHERE status = 'payout_pending' ORDER BY id ASC LIMIT 25`;
      for (const row of pp.rows) {
        try {
          const sig = await dispatchRefund(row.seller, String(row.amount_quoted_raw));
          await sql`UPDATE purchases SET status = 'settled', payout_sig = ${sig} WHERE id = ${row.id}`;
          payoutsSent++;
        } catch (e) { console.error("sweep payout retry failed:", e.message); }
      }
      const rp = await sql`SELECT id, buyer, amount_quoted_raw FROM purchases WHERE status = 'refund_pending' ORDER BY id ASC LIMIT 25`;
      for (const row of rp.rows) {
        try {
          const sig = await dispatchRefund(row.buyer, String(row.amount_quoted_raw));
          await sql`UPDATE purchases SET status = 'refunded', refund_sig = ${sig} WHERE id = ${row.id}`;
          mktRefundsSent++;
        } catch (e) { console.error("sweep mkt refund retry failed:", e.message); }
      }
      return res.status(200).json({ ok: true, finalized: r.rowCount ?? 0, refundsSent, refundsFailed, payoutsSent, mktRefundsSent });
    }
    // ---- reveal / sellback ----------------------------------------------
    if (b.action === "reveal" || b.action === "sellback") {
      const q = await sql`SELECT * FROM pulls WHERE id = ${Number(b.pullId)}`;
      const pull = q.rows[0];
      if (!pull) return res.status(404).json({ error: "no such pull" });
      if (pull.owner !== b.owner) return res.status(403).json({ error: "not your pull" });
      gateOrDie(b.owner);
      if (b.action === "reveal") {
        if (pull.state !== "sealed" && pull.state !== "kept") {
          return res.status(409).json({ error: `cannot reveal (${pull.state})` });
        }
        // Wallet-signature gate. A revealed code has cash value (resale), so we
        // require proof the caller controls the owning wallet — not just knowledge
        // of its (public) address. The signed message binds the wallet AND pull id.
        const { message, signature } = b;
        if (!message || !signature) return res.status(400).json({ error: "message + signature required to reveal" });
        if (!message.includes(`wallet:${b.owner}`) || !message.includes(`pull:${pull.id}`)) {
          return res.status(401).json({ error: "reveal message must bind wallet + pull id" });
        }
        const rm = /ts:(\d+)/.exec(message); const rts = rm ? Number(rm[1]) : 0;
        if (!rts || Math.abs(Date.now() / 1000 - rts) > 300) return res.status(401).json({ error: "signature expired — retry" });
        let rok = false; try { rok = verifyWalletSignature(message, String(signature), b.owner); } catch { rok = false; }
        if (!rok) return res.status(401).json({ error: "signature verification failed" });
        const kq = await sql`SELECT code_encrypted FROM crate_keys WHERE id = ${pull.key_id}`;
        const code = decryptCode(kq.rows[0].code_encrypted, process.env.CODE_VAULT_KEY);
        await sql`UPDATE crate_keys SET status = 'revealed' WHERE id = ${pull.key_id}`;
        // Revealing exposes the code to the owner -> the key can never be resold,
        // so it is auto-delisted from the marketplace here.
        await sql`UPDATE pulls SET state = 'revealed', listed = false, list_price_cents = NULL, listed_at = NULL, resolved_at = now() WHERE id = ${pull.id}`;
        return res.status(200).json({ ok: true, code });
      }
      if (pull.state !== "sealed") {
        return res.status(409).json({ error: `cannot sell back (${pull.state})` });
      }
      const deadlineMs = pull.decision_deadline ? new Date(pull.decision_deadline).getTime() : 0;
      if (!withinClaimWindow(deadlineMs, Date.now())) {
        return res.status(409).json({ error: "window-closed", note: "research window elapsed; key is yours to claim" });
      }
      const refund = buybackRaw(pull.paid_raw);
      await sql`UPDATE crate_keys SET status = 'available' WHERE id = ${pull.key_id}`;
      await sql`UPDATE pulls SET state = 'sold_back', listed = false, list_price_cents = NULL, listed_at = NULL, refund_raw = ${refund.toString()}, resolved_at = now() WHERE id = ${pull.id}`;
      await sql`INSERT INTO settlements(pull_id, type, amount_raw) VALUES (${pull.id}, 'refund', ${refund.toString()}) ON CONFLICT DO NOTHING`;
      try {
        const sig = await dispatchRefund(pull.owner, refund.toString());
        await sql`UPDATE settlements SET status = 'sent', sig = ${sig}, sent_at = now() WHERE pull_id = ${pull.id} AND type = 'refund'`;
        return res.status(200).json({ ok: true, refundRaw: refund.toString(), sent: true, sig });
      } catch (e) {
        console.error("refund dispatch deferred to signer worker:", e.message);
        return res.status(200).json({ ok: true, refundRaw: refund.toString(), sent: false, queued: true });
      }
    }
    // ---- MARKETPLACE: list a sealed/kept key for sale (owner-set USD price) ---
    if (b.action === "list") {
      const q = await sql`SELECT * FROM pulls WHERE id = ${Number(b.pullId)}`;
      const pull = q.rows[0];
      if (!pull) return res.status(404).json({ error: "no such pull" });
      if (pull.owner !== b.owner) return res.status(403).json({ error: "not your pull" });
      gateOrDie(b.owner);
      // Only an unrevealed key can be listed: sealed or kept, and the key itself
      // must still be sealed (never decrypted). Revealed/sold_back/owed can't list.
      if (pull.state !== "sealed" && pull.state !== "kept") {
        return res.status(409).json({ error: `cannot list (${pull.state})` });
      }
      if (!pull.key_id) return res.status(409).json({ error: "no key on this pull" });
      const ks = await sql`SELECT status FROM crate_keys WHERE id = ${pull.key_id}`;
      if (ks.rows[0]?.status !== "sealed") return res.status(409).json({ error: "key is not sealed" });
      const cents = Math.round(Number(b.price_cents));
      if (!Number.isFinite(cents) || cents < 1 || cents > 100000000) {
        return res.status(400).json({ error: "price_cents must be a positive USD-cents amount" });
      }
      await sql`UPDATE pulls SET listed = true, list_price_cents = ${cents}, listed_at = now() WHERE id = ${pull.id}`;
      return res.status(200).json({ ok: true, listed: true, price_cents: cents });
    }
    // ---- MARKETPLACE: pull your own listing --------------------------------
    if (b.action === "delist") {
      const q = await sql`SELECT owner, listed FROM pulls WHERE id = ${Number(b.pullId)}`;
      const pull = q.rows[0];
      if (!pull) return res.status(404).json({ error: "no such pull" });
      if (pull.owner !== b.owner) return res.status(403).json({ error: "not your pull" });
      gateOrDie(b.owner);
      await sql`UPDATE pulls SET listed = false, list_price_cents = NULL, listed_at = NULL WHERE id = ${Number(b.pullId)}`;
      return res.status(200).json({ ok: true, listed: false });
    }
    // ---- MARKETPLACE BUY (escrow): quote a purchase + lock a reference ------
    if (b.action === "buy-open") {
      if (!b.buyer) return res.status(400).json({ error: "buyer required" });
      gateOrDie(b.buyer);
      const q = await sql`SELECT * FROM pulls WHERE id = ${Number(b.pullId)}`;
      const pull = q.rows[0];
      if (!pull) return res.status(404).json({ error: "no such listing" });
      if (!pull.listed || !(pull.state === "sealed" || pull.state === "kept") || !pull.list_price_cents) {
        return res.status(409).json({ error: "listing is not active" });
      }
      if (pull.owner === b.buyer) return res.status(400).json({ error: "can't buy your own listing" });
      const ks = await sql`SELECT status FROM crate_keys WHERE id = ${pull.key_id}`;
      if (ks.rows[0]?.status !== "sealed") return res.status(409).json({ error: "key is not sealed" });
      // one live checkout per listing (soft lock; escrow refunds cover any race)
      const live = await sql`
        SELECT id FROM purchases WHERE pull_id = ${pull.id}
          AND status = 'awaiting_payment' AND quote_expires_at > now()`;
      if (live.rows.length) return res.status(409).json({ error: "another buyer is checking out — try again shortly" });
      const dropUsd = await currentDropUsd();
      const amountRaw = tokensForCrate(pull.list_price_cents, dropUsd, DECIMALS).toString();
      const reference = makeReference();
      const ttlMs = 120000;
      const ins = await sql`
        INSERT INTO purchases(pull_id, buyer, seller, reference, amount_quoted_raw, price_cents, quote_expires_at)
        VALUES (${pull.id}, ${b.buyer}, ${pull.owner}, ${reference}, ${amountRaw}, ${pull.list_price_cents},
                to_timestamp(${(Date.now() + ttlMs) / 1000}))
        RETURNING id`;
      return res.status(200).json({
        ok: true, purchaseId: ins.rows[0].id, reference, amountRaw,
        price_cents: pull.list_price_cents, seller: pull.owner, dropUsd, decimals: DECIMALS,
        expiresAt: Date.now() + ttlMs,
      });
    }
    // ---- MARKETPLACE BUY: build the buyer's escrow payment tx (to treasury) --
    if (b.action === "buy-buildpay") {
      if (!b.payer) return res.status(400).json({ error: "payer required" });
      const q = await sql`SELECT * FROM purchases WHERE reference = ${String(b.reference)}`;
      const pur = q.rows[0];
      if (!pur) return res.status(404).json({ error: "no such purchase" });
      gateOrDie(b.payer);
      if (pur.buyer !== b.payer) return res.status(403).json({ error: "not your purchase" });
      if (pur.status !== "awaiting_payment") return res.status(409).json({ error: `purchase ${pur.status}` });
      if (new Date(pur.quote_expires_at).getTime() < Date.now()) return res.status(409).json({ error: "quote expired — start again" });
      const { buildDirectPaymentTx } = await import("../lib/solana.js");
      const built = await buildDirectPaymentTx(b.payer, pur.reference, process.env.TREASURY_WALLET, String(pur.amount_quoted_raw));
      return res.status(200).json({ ok: true, purchaseId: pur.id, amountRaw: String(pur.amount_quoted_raw), ...built });
    }
    // ---- MARKETPLACE BUY: confirm escrow, flip owner, forward to seller ------
    if (b.action === "buy-confirm") {
      const q = await sql`SELECT * FROM purchases WHERE reference = ${String(b.reference)}`;
      const pur = q.rows[0];
      if (!pur) return res.status(404).json({ error: "no such purchase" });
      gateOrDie(pur.buyer);
      if (pur.status === "settled") return res.status(200).json({ ok: true, state: "settled", already: true, pullId: pur.pull_id });
      if (pur.status === "refunded") return res.status(200).json({ ok: false, state: "refunded", already: true });
      if (pur.status !== "awaiting_payment") return res.status(409).json({ error: `purchase ${pur.status}` });
      const { findPaymentByReference, resolveWalletAta } = await import("../lib/solana.js");
      const found = await findPaymentByReference(pur.reference);
      if (!found) return res.status(402).json({ error: "payment-not-found" });
      const treasuryAta = await resolveWalletAta(process.env.TREASURY_WALLET);
      const legToTreasury = (found.legs || [])
        .filter((l) => String(l.destination) === String(treasuryAta))
        .reduce((a, l) => a + BigInt(l.amountRaw), 0n);
      const v = validateTransfer(
        { mint: found.mint, destination: treasuryAta, amountRaw: legToTreasury.toString(), reference: pur.reference, sender: found.sender },
        { mint: process.env.DROP_MINT, destination: treasuryAta, amountRaw: String(pur.amount_quoted_raw),
          reference: pur.reference, expiresAt: new Date(pur.quote_expires_at).getTime() },
        { nowMs: Date.now(), underpayToleranceBps: 0 }
      );
      if (!v.ok) return res.status(400).json({ error: "invalid-payment", reasons: v.reasons });
      try {
        await sql`UPDATE purchases SET paid_sig = ${found.signature}, status = 'paid' WHERE id = ${pur.id} AND status = 'awaiting_payment'`;
      } catch {
        return res.status(409).json({ error: "payment-already-used" });
      }
      // ATOMIC delivery: flip owner ONLY if the listing is still deliverable.
      const deliver = await sql`
        UPDATE pulls SET owner = ${pur.buyer}, ripped_by = COALESCE(ripped_by, owner),
               listed = false, list_price_cents = NULL, listed_at = NULL
        WHERE id = ${pur.pull_id} AND listed = true AND state IN ('sealed','kept') AND owner = ${pur.seller}
        RETURNING id`;
      if (deliver.rows.length) {
        // the key is the buyer's now — forward the full escrow to the seller (no fee)
        try {
          const sig = await dispatchRefund(pur.seller, String(pur.amount_quoted_raw));
          await sql`UPDATE purchases SET status = 'settled', payout_sig = ${sig}, settled_at = now() WHERE id = ${pur.id}`;
        } catch (e) {
          console.error("seller payout deferred:", e.message);
          await sql`UPDATE purchases SET status = 'payout_pending', settled_at = now() WHERE id = ${pur.id}`;
        }
        return res.status(200).json({ ok: true, state: "settled", pullId: pur.pull_id });
      }
      // undeliverable (already sold / revealed / delisted) -> refund the buyer in full
      try {
        const sig = await dispatchRefund(pur.buyer, String(pur.amount_quoted_raw));
        await sql`UPDATE purchases SET status = 'refunded', refund_sig = ${sig}, settled_at = now() WHERE id = ${pur.id}`;
      } catch (e) {
        console.error("buyer refund deferred:", e.message);
        await sql`UPDATE purchases SET status = 'refund_pending', settled_at = now() WHERE id = ${pur.id}`;
      }
      return res.status(200).json({ ok: false, state: "refunded", reason: "listing was no longer available — you've been refunded" });
    }
    // ---- MARKETPLACE: public browse of active listings ---------------------
    if (b.action === "market") {
      const dropUsd = await currentDropUsd();
      const rows = await sql`
        SELECT p.id, p.owner, p.crate, p.rarity, p.list_price_cents, p.listed_at,
               k.game_title, k.image, k.msrp_cents
        FROM pulls p JOIN crate_keys k ON k.id = p.key_id
        WHERE p.listed = true AND p.state IN ('sealed','kept') AND k.status = 'sealed'
              AND p.list_price_cents IS NOT NULL
        ORDER BY p.listed_at DESC NULLS LAST, p.id DESC
        LIMIT 200`;
      const listings = rows.rows.map((r) => ({
        id: r.id,
        seller: r.owner,
        crate: r.crate,
        rarity: r.rarity,
        game: r.game_title || "Mystery game",
        image: r.image || null,
        msrp_cents: r.msrp_cents,
        price_cents: r.list_price_cents,
        drop_raw: tokensForCrate(r.list_price_cents, dropUsd, DECIMALS).toString(),
        listed_at: r.listed_at,
      }));
      return res.status(200).json({ ok: true, dropUsd, decimals: DECIMALS, listings });
    }
    // ---- VERIFY ----------------------------------------------------------
    if (b.action === "verify") {
      const q = await sql`SELECT crate, drand_round, nonce, seed, rarity, misses_since_floor, state FROM pulls WHERE id = ${Number(b.pullId)}`;
      if (!q.rows.length) return res.status(404).json({ error: "no such pull" });
      return res.status(200).json(q.rows[0]);
    }
 // ---- HISTORY: a wallet's own pulls, gated by a wallet SIGNATURE ---------
    if (b.action === "history") {
      const { owner, message, signature } = b;
      if (!owner || !message || !signature) return res.status(400).json({ error: "owner, message, signature required" });
      if (!message.includes(`wallet:${owner}`)) return res.status(401).json({ error: "message/wallet mismatch" });
      const m = /ts:(\d+)/.exec(message);
      const ts = m ? Number(m[1]) : 0;
      if (!ts || Math.abs(Date.now() / 1000 - ts) > 300) return res.status(401).json({ error: "signature expired — retry" });
      let ok = false;
      try { ok = verifyWalletSignature(message, String(signature), owner); } catch { ok = false; }
      if (!ok) return res.status(401).json({ error: "signature verification failed" });
      const rows = await sql`
        SELECT p.id, p.crate, p.rarity, p.state, p.resolved_at, p.created_at, p.refund_raw,
               p.listed, p.list_price_cents,
               k.game_title, k.image, k.msrp_cents, k.code_encrypted, k.status AS key_status
        FROM pulls p LEFT JOIN crate_keys k ON k.id = p.key_id
        WHERE p.owner = ${owner} AND p.state IN ('revealed','kept','sold_back','owed')
        ORDER BY COALESCE(p.resolved_at, p.created_at) DESC, p.id DESC
        LIMIT 200`;
      const items = rows.rows.map((r) => {
        // The plaintext code is returned ONLY once the key is explicitly REVEALED.
        // A 'kept' key is still sealed (never shown) so it stays resale-eligible —
        // returning its code here would let a seller extract it and still sell the
        // "sealed" key. So: code only for state === 'revealed'.
        let code = null;
        if (r.state === "revealed" && r.code_encrypted) {
          try { code = decryptCode(r.code_encrypted, process.env.CODE_VAULT_KEY); } catch { code = null; }
        }
        return {
          id: r.id, crate: r.crate, rarity: r.rarity, state: r.state,
          game: r.game_title, image: r.image, msrp_cents: r.msrp_cents,
          date: r.resolved_at || r.created_at,
          refund_raw: r.refund_raw ? String(r.refund_raw) : null,
          listed: !!r.listed, list_price_cents: r.list_price_cents ?? null,
          code,
        };
      });
      return res.status(200).json({ ok: true, items });
    }

    return res.status(400).json({ error: `unknown action ${b.action}` });
  } catch (err) {
    if (err && err.http) return res.status(err.http).json({ error: String(err.message) });
    console.error("crate:", err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
