// ============================================================================
// DROPRATE — Crate open/resolve flow (ADDITIVE, gacha only)
//
// The provably-fair instant-gacha loop, reusing the SAME drand beacon the raffle
// uses (lib/draw.js) and the SAME pull engine (lib/gacha.js):
//
//   OPEN   -> commit a strictly-future drand round + a per-pull nonce (both fixed
//             before the round's randomness exists = the commitment)
//   RESOLVE-> ~6s later fetch that round, hash(seed:nonce) -> rarity (+ pity)
//   ASSIGN -> pull one real key out of that rarity's bucket (done in the route)
//   GATE   -> reveal | sellback | list  (lib/gacha.transition)
//
// This file is pure/deterministic (no DB, no network) so the whole flow is
// unit-testable; the route (api/crate.js) does the drand fetch + DB writes.
// ============================================================================

import { roundAt, roundTime } from "./draw.js";
import { CRATES, RARITIES, resolvePull, CLAIM_WINDOW_SEC } from "./gacha.js";

// Research/decision window: sell-back is allowed until this deadline; after it,
// the pull auto-finalizes to `kept` (key still claimable, no more refunds).
export function claimDeadlineSec(nowSec) {
  return nowSec + CLAIM_WINDOW_SEC;
}
export function withinClaimWindow(deadlineMs, nowMs) {
  return nowMs < deadlineMs;
}

// The commitment: at open time, pick the drand round whose randomness does not
// exist yet. roundAt() already returns a strictly-future round (+2 ≈ 6s out).
export function commitRound(nowUnix) {
  return roundAt(nowUnix);
}

// When that round's randomness becomes fetchable (unix seconds).
export function roundReadyAt(round) {
  return roundTime(round);
}

// Rarities a crate can produce at all (any odds > 0), plus its pity floor.
export function reachableRarities(crateKey) {
  const c = CRATES[crateKey];
  if (!c) throw new Error(`crate: unknown ${crateKey}`);
  const set = new Set();
  c.odds.forEach((p, i) => { if (p > 0) set.add(RARITIES[i]); });
  set.add(c.pityFloor);
  return [...set];
}

// Odds below this are a negligible "tail": a box stays purchasable even if that
// bucket is empty, and such a rare pull falls through to an 'owed' IOU (fulfilled
// on the next restock). Every bucket at/above this must be stocked to sell.
export const MATERIAL_ODDS = 0.01; // 1%

// Rarities a crate MATERIALLY offers (>= MATERIAL_ODDS) plus its pity floor.
export function requiredRarities(crateKey, threshold = MATERIAL_ODDS) {
  const c = CRATES[crateKey];
  if (!c) throw new Error(`crate: unknown ${crateKey}`);
  const set = new Set([c.pityFloor]);
  c.odds.forEach((p, i) => { if (p >= threshold) set.add(RARITIES[i]); });
  return [...set];
}

// Stock guard: a crate is off-limits for purchase unless every rarity it
// materially offers has an available key. Empty the legendary bucket and every
// box that features legendary (Legendary/Epic/Rare) locks until restocked; the
// $5 Common box keeps selling (its 0.2% legendary tail would just 'owe').
export function canOpen(crateKey, stock) {
  return requiredRarities(crateKey).every((r) => (stock[r] || 0) >= 1);
}

// Resolve a committed pull to its rarity. seedHex = drand randomness for the
// committed round; nonce = the per-pull nonce fixed at open time; pityMisses =
// the owner's running counter for this crate tier.
// Returns { crate, natural, rarity, forced, missesSinceEpic }.
export function resolveRarity(crateKey, seedHex, nonce, pityMisses = 0) {
  if (!seedHex) throw new Error("crate: missing drand seed");
  return resolvePull(crateKey, seedHex, nonce, pityMisses);
}

// Anyone can reproduce a pull from public data. This is the verification recipe
// we publish next to each pull (seed is the drand randomness for `round`).
export function verifyPull({ crate, seedHex, nonce, expectedRarity, pityMissesAtPull = 0 }) {
  const r = resolveRarity(crate, seedHex, nonce, pityMissesAtPull);
  return r.rarity === expectedRarity;
}
