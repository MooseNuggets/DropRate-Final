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
export function verifySplitLegs(legs, expected, split = SPLIT) {
  const want = splitPayment(expected.totalRaw, split);
  const received = (dest) =>
    legs
      .filter((l) => String(l.destination) === String(dest))
      .reduce((a, l) => a + BigInt(l.amountRaw), 0n);
  const tre = received(expected.treasury);
  const bur = received(expected.burn);
  const lp = received(expected.lp);
  const mkt = received(expected.marketing);
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
  const amountRaw = tokensForCrate(crate.priceUsdCents, dropUsd, opts.decimals ?? 6);
  return {
    crate: crateKey,
    priceUsdCents: crate.priceUsdCents,
    dropUsd,
    amountRaw: amountRaw.toString(),
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
