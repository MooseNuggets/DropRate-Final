// ============================================================================
// DROPRATE — Crate open/resolve/reveal API (NEW ROUTE)
//
// The player-facing gacha endpoint. Does NOT touch raffle tables — only
// crate_keys / pulls / pity. Reuses the raffle's drand + vault libraries.
//
// On-chain payment verification + refunds are WIRED (lib/oracle.js for price,
// lib/solana.js for the 4-leg confirm and the treasury refund). A GATE seals the
// whole route until GACHA_ENABLED=1, and to an allowlist while GACHA_ALLOWLIST is
// set — so it runs live but only for you until you flip it public.
//
// Actions (POST JSON):
//   { action:"open",    owner, crate }          -> quote a USD-pegged price
//   { action:"confirm", pullId }                -> verify 4-leg payment, commit round
//   { action:"resolve", pullId }                -> fetch drand, roll rarity, assign key
//   { action:"reveal",  pullId, owner }         -> decrypt + return the code ONCE
//   { action:"sellback",pullId, owner }         -> 70% refund, key back to pool
//   { action:"sweep" }                          -> cron: auto-keep expired pulls
//   { action:"verify",  pullId }                -> public reproduction data
// ============================================================================

import { randomUUID } from "node:crypto";
import { sql } from "../lib/db.js";
import { migrateGacha, bucketCounts } from "../lib/gacha-db.js";
import { CRATES, buybackRaw, CLAIM_WINDOW_SEC } from "../lib/gacha.js";
import { commitRound, roundReadyAt, canOpen, resolveRarity, claimDeadlineSec, withinClaimWindow } from "../lib/crate.js";
import { quoteCrate, splitPayment, validateTransfer, verifySplitLegs } from "../lib/payment.js";
import { fetchRandomness } from "../lib/draw.js";
import { decryptCode } from "../lib/vault.js";
import { currentDropUsd } from "../lib/oracle.js";

const nowUnix = () => Math.floor(Date.now() / 1000);
const DECIMALS = Number(process.env.DROP_DECIMALS || 6);

// --- HIDDEN-DEPLOY GATE -----------------------------------------------------
// Master kill-switch + wallet allowlist. Every MUTATING action calls gateOrDie()
// first, so the whole gacha is live-but-sealed: until GACHA_ENABLED=1 nothing
// runs, and while GACHA_ALLOWLIST is set ONLY those wallets can pull. Public
// launch = set GACHA_ENABLED=1 and clear the allowlist (one env change).
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
// currentDropUsd is imported above. The two chain seams delegate to lib/solana.js
// (all @solana/* imports live there, loaded lazily at runtime).
async function fetchPaidTransfer(reference, expected) {
  const { findPaymentByReference, resolveSplitAtas } = await import("../lib/solana.js");
  const found = await findPaymentByReference(reference);
  if (!found) return null; // not on-chain yet -> client retries
  const atas = await resolveSplitAtas();
  // confirm each PUBLIC wallet received its exact split share, in this one tx.
  const split = verifySplitLegs(found.legs, { ...atas, totalRaw: expected.amountRaw });
  return {
    mint: process.env.DROP_MINT,
    destination: atas.treasury,
    amountRaw: split.ok ? split.totalRaw : "0", // "0" -> validateTransfer underpay-rejects
    reference,
    sender: found.sender,
    signature: found.signature,
    splitOk: split.ok,
    splitReasons: split.reasons,
  };
}
async function dispatchRefund(toWallet, amountRaw) {
  const { sendTreasuryTransfer } = await import("../lib/solana.js");
  return sendTreasuryTransfer(toWallet, amountRaw); // treasury -> toWallet, returns sig
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    await migrateGacha();
    const b = req.body ?? {};

    // ---- OPEN: quote a USD-pegged price ----------------------------------
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
        expiresAt: q.expiresAt, // after which the quote is dead and must be re-opened
      });
    }

    // ---- CONFIRM: validate the on-chain payment -> commit drand round -----
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

      // Replay guard: paid_sig is uniquely indexed, so one signature backs one pull.
      try {
        await sql`UPDATE pulls SET paid = true, paid_sig = ${transfer.signature}, paid_raw = ${v.amountRaw} WHERE id = ${pull.id}`;
      } catch {
        return res.status(409).json({ error: "payment-already-used" });
      }
      // The payment tx itself fans out four ways to PUBLIC wallets in one signed
      // transfer (validated above): treasury, incinerator (burn goes payer ->
      // incinerator DIRECTLY, never a controlled wallet), LP, marketing. So all
      // four legs are already on-chain here — we just ledger them for the audit
      // trail. No distribution worker; only refunds use the treasury signer.
      const { treasuryRaw, burnRaw, lpRaw, marketingRaw } = splitPayment(v.amountRaw);
      for (const [type, amt] of [["treasury", treasuryRaw], ["burn", burnRaw], ["lp", lpRaw], ["marketing", marketingRaw]]) {
        await sql`INSERT INTO settlements(pull_id, type, amount_raw, status, sig, sent_at)
                  VALUES (${pull.id}, ${type}, ${amt.toString()}, 'confirmed', ${transfer.signature}, now()) ON CONFLICT DO NOTHING`;
      }

      // Payment is in -> NOW commit the strictly-future drand round.
      const round = commitRound(nowUnix());
      await sql`UPDATE pulls SET drand_round = ${round}, state = 'committing' WHERE id = ${pull.id}`;
      return res.status(200).json({ ok: true, state: "committing", round, readyAt: roundReadyAt(round) });
    }

    // ---- RESOLVE: fetch drand -> rarity -> assign a real key --------------
    if (b.action === "resolve") {
      const q = await sql`SELECT * FROM pulls WHERE id = ${Number(b.pullId)}`;
      const pull = q.rows[0];
      if (!pull) return res.status(404).json({ error: "no such pull" });
      gateOrDie(pull.owner);
      if (pull.state !== "committing") return res.status(200).json({ state: pull.state, rarity: pull.rarity });
      if (nowUnix() < roundReadyAt(Number(pull.drand_round))) {
        return res.status(425).json({ error: "too-early", readyAt: roundReadyAt(Number(pull.drand_round)) });
      }
      const seed = await fetchRandomness(Number(pull.drand_round)); // multi-relay agreement

      const pityRow = await sql`SELECT misses FROM pity WHERE owner = ${pull.owner} AND crate = ${pull.crate}`;
      const misses = pityRow.rows[0]?.misses ?? 0;
      const roll = resolveRarity(pull.crate, seed, pull.nonce, misses);

      // atomically claim the oldest available key in that bucket (race-safe)
      const claim = await sql`
        UPDATE crate_keys SET status = 'sealed'
        WHERE id = (SELECT id FROM crate_keys WHERE rarity = ${roll.rarity} AND status = 'available'
                    ORDER BY id ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id, game_title, image, msrp_cents`;

      // update the owner's pity counter regardless of stock
      await sql`
        INSERT INTO pity(owner, crate, misses) VALUES (${pull.owner}, ${pull.crate}, ${roll.missesSinceEpic})
        ON CONFLICT (owner, crate) DO UPDATE SET misses = ${roll.missesSinceEpic}`;

      if (!claim.rows.length) {
        // bucket emptied out from under us -> owe the player a key of this rarity
        await sql`UPDATE pulls SET rarity = ${roll.rarity}, seed = ${seed}, state = 'owed', resolved_at = now() WHERE id = ${pull.id}`;
        return res.status(200).json({ state: "owed", rarity: roll.rarity });
      }
      const key = claim.rows[0];
      const deadlineSec = claimDeadlineSec(nowUnix()); // research/sell-back window
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

    // ---- SWEEP: finalize pulls whose research window elapsed (cron) -------
    if (b.action === "sweep") {
      if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: "unauthorized" });
      }
      // sealed + past deadline -> kept (sell-back closes; key still claimable)
      const r = await sql`UPDATE pulls SET state = 'kept' WHERE state = 'sealed' AND decision_deadline < now()`;
      return res.status(200).json({ ok: true, finalized: r.rowCount ?? 0 });
    }

    // ---- reveal-gate actions ---------------------------------------------
    if (b.action === "reveal" || b.action === "sellback") {
      const q = await sql`SELECT * FROM pulls WHERE id = ${Number(b.pullId)}`;
      const pull = q.rows[0];
      if (!pull) return res.status(404).json({ error: "no such pull" });
      if (pull.owner !== b.owner) return res.status(403).json({ error: "not your pull" });
      gateOrDie(b.owner);

      if (b.action === "reveal") {
        // claim the key — allowed while sealed OR after auto-keep (kept)
        if (pull.state !== "sealed" && pull.state !== "kept") {
          return res.status(409).json({ error: `cannot reveal (${pull.state})` });
        }
        const kq = await sql`SELECT code_encrypted FROM crate_keys WHERE id = ${pull.key_id}`;
        const code = decryptCode(kq.rows[0].code_encrypted, process.env.CODE_VAULT_KEY);
        await sql`UPDATE crate_keys SET status = 'revealed' WHERE id = ${pull.key_id}`;
        await sql`UPDATE pulls SET state = 'revealed', resolved_at = now() WHERE id = ${pull.id}`;
        return res.status(200).json({ ok: true, code }); // returned exactly once
      }

      // sellback — ONLY inside the research window
      if (pull.state !== "sealed") {
        return res.status(409).json({ error: `cannot sell back (${pull.state})` });
      }
      const deadlineMs = pull.decision_deadline ? new Date(pull.decision_deadline).getTime() : 0;
      if (!withinClaimWindow(deadlineMs, Date.now())) {
        return res.status(409).json({ error: "window-closed", note: "research window elapsed; key is yours to claim" });
      }
      const refund = buybackRaw(pull.paid_raw); // 70% of TOKENS paid (not USD)
      // key re-enters the pool immediately for a future pull
      await sql`UPDATE crate_keys SET status = 'available' WHERE id = ${pull.key_id}`;
      await sql`UPDATE pulls SET state = 'sold_back', refund_raw = ${refund.toString()}, resolved_at = now() WHERE id = ${pull.id}`;
      await sql`INSERT INTO settlements(pull_id, type, amount_raw) VALUES (${pull.id}, 'refund', ${refund.toString()}) ON CONFLICT DO NOTHING`;
      // AUTO-SEND the refund right now; if the signer isn't wired the row stays
      // 'pending' and the worker sends it — the refund is never lost.
      try {
        const sig = await dispatchRefund(pull.owner, refund.toString());
        await sql`UPDATE settlements SET status = 'sent', sig = ${sig}, sent_at = now() WHERE pull_id = ${pull.id} AND type = 'refund'`;
        return res.status(200).json({ ok: true, refundRaw: refund.toString(), sent: true, sig });
      } catch (e) {
        console.error("refund dispatch deferred to signer worker:", e.message);
        return res.status(200).json({ ok: true, refundRaw: refund.toString(), sent: false, queued: true });
      }
    }

    // ---- VERIFY: public reproduction data --------------------------------
    if (b.action === "verify") {
      const q = await sql`SELECT crate, drand_round, nonce, seed, rarity, misses_since_floor, state FROM pulls WHERE id = ${Number(b.pullId)}`;
      if (!q.rows.length) return res.status(404).json({ error: "no such pull" });
      return res.status(200).json(q.rows[0]);
    }

    return res.status(400).json({ error: `unknown action ${b.action}` });
  } catch (err) {
    if (err && err.http) return res.status(err.http).json({ error: String(err.message) });
    console.error("crate:", err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
