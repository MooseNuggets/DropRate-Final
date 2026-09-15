// ============================================================================
// DROPRATE — Payment rail brain (ADDITIVE, gacha only)
//
// Everything about money EXCEPT the two things that must live on-chain (reading
// the ledger and signing transfers), which are injected at the route edge:
//   - quote:   USD-pegged crate price -> locked $DROP amount + expiry
//   - split:   70/10/10/10 treasury/burn/LP/marketing — exact integer math
//   - validate: does a parsed on-chain transfer actually match what we asked for
//   - verifySplitLegs: did all four public wallets get their exact share, one tx
//   - refund:  70% buyback amount for a sellback
//
// Pure/deterministic -> fully unit-testable offline.
// ============================================================================

import { randomBytes } from "node:crypto";
import { CRATES } from "./gacha.js";
import { tokensForCrate } from "./gacha.js";

// Locked split (spec v0.2). Every rip fans out four ways to PUBLIC wallets:
//   70% treasury (funds prizes + buybacks/refunds)
//   10% burn      -> incinerator, never a controlled wallet
//   10% LP        -> liquidity wallet
//   10% marketing -> marketing wallet
// Each leg's destination is a fresh, publicly-viewable address (env-configured).
export const SPLIT = { treasuryBps: 7000, burnBps: 1000, lpBps: 1000, marketingBps: 1000 };
export const BUYBACK_BPS = 7000; // sellback returns 70% of tokens paid

/* Crates paid in SOL or USDC split three ways instead of four. There is nothing
   to burn — burning is a $DROP supply mechanic and means nothing for SOL — and
   no LP leg, because that wallet exists to deepen $DROP liquidity. So:
     70% treasury  (funds refunds; anything left over is buybacks, LP, whatever)
     15% marketing
     15% owner
   Same no-dust rule: the two smaller legs floor, the treasury takes the exact
   remainder, and the three always re-sum to the input. */
export const SPLIT_FIAT = { treasuryBps: 7000, marketingBps: 1500, ownerBps: 1500 };

/* Holding $DROP earns 10% off a crate — but ONLY when the crate is paid for in
   $DROP. SOL and USDC crate purchases get no discount regardless of holdings,
   and no game purchase ever does. The token's perks are the raffles and this. */
export const DROP_HOLDER_DISCOUNT_BPS = 1000;
export const DROP_HOLDER_MIN_TOKENS = 100_000n;   // whole tokens, decimals applied by caller

export function holderDiscountBps(balanceRaw, decimals = 6) {
  const min = DROP_HOLDER_MIN_TOKENS * 10n ** BigInt(decimals);
  return BigInt(balanceRaw ?? 0) >= min ? DROP_HOLDER_DISCOUNT_BPS : 0;
}

export function splitPaymentFiat(amountRaw, split = SPLIT_FIAT) {
  const amt = BigInt(amountRaw);
  if (amt < 0n) throw new Error("payment: negative amount");
  const marketingRaw = (amt * BigInt(split.marketingBps)) / 10000n;
  const ownerRaw = (amt * BigInt(split.ownerBps)) / 10000n;
  const treasuryRaw = amt - marketingRaw - ownerRaw;
  return { treasuryRaw, marketingRaw, ownerRaw };
}

/* Three-leg counterpart of verifySplitLegs. `legs` are the SOL or USDC transfers
   parsed off-chain; `expected` names the three destinations and the quoted total.
   Overpay tolerant, underpay rejected, per leg. */
export function verifySplitLegsFiat(legs, expected, split = SPLIT_FIAT) {
  const want = splitPaymentFiat(expected.totalRaw, split);
  const received = (dest) =>
    legs.filter((l) => String(l.destination) === String(dest))
        .reduce((a, l) => a + BigInt(l.amountRaw), 0n);
  const tre = received(expected.treasury);
  const mkt = received(expected.marketing);
  const own = received(expected.owner);
  const reasons = [];
  if (tre < want.treasuryRaw) reasons.push(`treasury short: got ${tre} want >= ${want.treasuryRaw}`);
  if (mkt < want.marketingRaw) reasons.push(`marketing short: got ${mkt} want >= ${want.marketingRaw}`);
  if (own < want.ownerRaw) reasons.push(`owner short: got ${own} want >= ${want.ownerRaw}`);
  const totalRaw = (tre + mkt + own).toString();
  return { ok: reasons.length === 0, reasons, totalRaw,
           legs: { treasuryRaw: tre.toString(), marketingRaw: mkt.toString(), ownerRaw: own.toString() } };
}

// Split a received payment with NO rounding leak: each outbound leg is floored,
// treasury takes the exact remainder, so the four always re-sum to the input.
export function splitPayment(amountRaw, split = SPLIT) {
  const amt = BigInt(amountRaw);
  if (amt < 0n) throw new Error("payment: negative amount");
  const burnRaw = (amt * BigInt(split.burnBps)) / 10000n;
  const lpRaw = (amt * BigInt(split.lpBps)) / 10000n;
  const marketingRaw = (amt * BigInt(split.marketingBps)) / 10000n;
  const treasuryRaw = amt - burnRaw - lpRaw - marketingRaw; // remainder -> zero dust
  return { treasuryRaw, burnRaw, lpRaw, marketingRaw };
}

export function refundRaw(paidRaw) {
  const p = BigInt(paidRaw);
  if (p < 0n) throw new Error("payment: negative paid");
  return (p * BigInt(BUYBACK_BPS)) / 10000n;
}

// Verify a payment that fanned out four ways AT SOURCE actually paid each public
// wallet its exact split share, in ONE tx. `legs` are the $DROP-mint transfers
// parsed off-chain: [{ destination, amountRaw }] (destination = token account /
// ATA that received tokens). `expected` names the four destination ATAs and the
// total quote. We compute the required per-leg amounts with the SAME splitPayment
// math the ledger uses, then require each leg to have received AT LEAST its share
// (overpay tolerant, underpay rejected). Pure -> unit-testable; the actual chain
// parse lives in lib/solana.js and just feeds this the legs.
export function verifySplitLegs(legs, burnedRaw, expected, split = SPLIT) {
  const want = splitPayment(expected.totalRaw, split);
  const received = (dest) =>
    legs
      .filter((l) => String(l.destination) === String(dest))
      .reduce((a, l) => a + BigInt(l.amountRaw), 0n);
  const tre = received(expected.treasury);
  const lp = received(expected.lp);
  const mkt = received(expected.marketing);
  const bur = BigInt(burnedRaw || 0); // REAL burn (supply reduction), not a transfer
  const reasons = [];
  if (tre < want.treasuryRaw) reasons.push(`treasury short: got ${tre} want >= ${want.treasuryRaw}`);
  if (bur < want.burnRaw) reasons.push(`burn short: got ${bur} want >= ${want.burnRaw}`);
  if (lp < want.lpRaw) reasons.push(`lp short: got ${lp} want >= ${want.lpRaw}`);
  if (mkt < want.marketingRaw) reasons.push(`marketing short: got ${mkt} want >= ${want.marketingRaw}`);
  const totalRaw = (tre + bur + lp + mkt).toString();
  return { ok: reasons.length === 0, reasons, totalRaw, legs: { treasuryRaw: tre.toString(), burnRaw: bur.toString(), lpRaw: lp.toString(), marketingRaw: mkt.toString() } };
}

// A unique Solana-Pay `reference`: 32 random bytes, base58-encoded so it's a valid
// pubkey the client attaches to the payment transfer and the server locates the tx
// by (findReference). Unguessable so nobody can hijack a pull's quote.
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = "1".repeat(zeros);
  for (let k = digits.length - 1; k >= 0; k--) out += B58_ALPHABET[digits[k]];
  return out;
}
export function makeReference() {
  return base58encode(randomBytes(32));
}

// USD-pegged quote, LOCKED at request time so price drift between quote and pay
// can't break the order. dropUsd = safe $DROP price (from lib/price.js).
export function quoteCrate(crateKey, dropUsd, opts = {}) {
  const crate = CRATES[crateKey];
  if (!crate) throw new Error(`payment: unknown crate ${crateKey}`);
  const nowMs = opts.nowMs ?? 0;
  const ttlMs = opts.ttlMs ?? 120_000; // 2-minute quote window
  // The holder discount applies to the USD price BEFORE conversion, so the
  // token amount is simply "the discounted price in $DROP" — no second rounding.
  const discountBps = Number(opts.discountBps ?? 0);
  const effCents = Math.round(crate.priceUsdCents * (10000 - discountBps) / 10000);
  const amountRaw = tokensForCrate(effCents, dropUsd, opts.decimals ?? 6);
  return {
    crate: crateKey,
    currency: "DROP",
    priceUsdCents: crate.priceUsdCents,
    effectiveUsdCents: effCents,
    discountBps,
    dropUsd,
    amountRaw: amountRaw.toString(),
    reference: makeReference(),
    quotedAt: nowMs,
    expiresAt: nowMs + ttlMs,
  };
}

/* Same shape for a crate paid in SOL or USDC. USDC is 1:1 with USD at six
   decimals; SOL converts at the live price into nine-decimal lamports. Never a
   discount here — that is a $DROP-payer perk only. */
export const FIAT_DECIMALS = { USDC: 6, SOL: 9 };
export function quoteCrateFiat(crateKey, currency, solUsd, opts = {}) {
  const crate = CRATES[crateKey];
  if (!crate) throw new Error(`payment: unknown crate ${crateKey}`);
  if (!FIAT_DECIMALS[currency]) throw new Error(`payment: unsupported currency ${currency}`);
  if (currency === "SOL" && !(solUsd > 0)) throw new Error("payment: SOL price unavailable");
  const nowMs = opts.nowMs ?? 0;
  const ttlMs = opts.ttlMs ?? 120_000;
  const usd = crate.priceUsdCents / 100;
  const unit = currency === "USDC" ? 1 : solUsd;
  const amountRaw = BigInt(Math.round((usd / unit) * 10 ** FIAT_DECIMALS[currency]));
  return {
    crate: crateKey,
    currency,
    priceUsdCents: crate.priceUsdCents,
    effectiveUsdCents: crate.priceUsdCents,
    discountBps: 0,
    solUsd: currency === "SOL" ? solUsd : null,
    amountRaw: amountRaw.toString(),
    decimals: FIAT_DECIMALS[currency],
    reference: makeReference(),
    quotedAt: nowMs,
    expiresAt: nowMs + ttlMs,
  };
}

export function quoteValid(quote, nowMs) {
  return nowMs <= quote.expiresAt;
}

// THE security check. `parsed` is a normalized view of the on-chain transfer the
// edge fetched (mint, destination ATA, amount base units, reference, sender).
// `expected` = what we quoted. Underpayment, wrong mint, wrong destination, wrong
// reference, or an expired quote all reject. Overpayment is allowed (tolerant).
export function validateTransfer(parsed, expected, opts = {}) {
  const reasons = [];
  if (String(parsed.mint) !== String(expected.mint)) reasons.push("wrong mint");
  if (String(parsed.destination) !== String(expected.destination)) reasons.push("wrong destination");
  if (String(parsed.reference) !== String(expected.reference)) reasons.push("reference mismatch");

  const got = BigInt(parsed.amountRaw ?? 0);
  const want = BigInt(expected.amountRaw);
  // allow a tiny shortfall tolerance for rounding/fees if configured, else exact-or-more
  const tolBps = BigInt(opts.underpayToleranceBps ?? 0);
  const minAcceptable = want - (want * tolBps) / 10000n;
  if (got < minAcceptable) reasons.push(`underpaid: got ${got} want >= ${minAcceptable}`);

  if (expected.sender != null && parsed.sender != null && String(parsed.sender) !== String(expected.sender)) {
    reasons.push("sender mismatch");
  }
  if (opts.nowMs != null && expected.expiresAt != null && opts.nowMs > expected.expiresAt) {
    reasons.push("quote expired");
  }
  return { ok: reasons.length === 0, reasons, amountRaw: got.toString() };
}
