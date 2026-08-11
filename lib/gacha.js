// ============================================================================
// DROPRATE — Gacha / Crate engine (ADDITIVE MODULE)
//
// HARD CONSTRAINT: this file is NEW. It does not import or modify the raffle
// (snapshot-tick, draw-tick, draws, claim, eligibility). It reuses drand-style
// seeded randomness and the vault only as libraries. The live raffle is untouched.
//
// Everything here is pure + deterministic so it can be exhaustively tested and
// so any pull is reproducible from (seed, nonce) — the "provably fair" story.
// ============================================================================

import { createHash } from "node:crypto";

// Rarity order is fixed low -> high. Index doubles as rank.
export const RARITIES = ["common", "rare", "epic", "legendary"];
export const rankOf = (r) => RARITIES.indexOf(r);

// --- Locked config (design spec v0.1) -------------------------------------
// odds arrays are in RARITIES order and must each sum to 1.
// pityFloor = the rarity pity guarantees within PITY_PULLS pulls. It scales with
// crate price: a $5 crate can't afford to hand out Epics on a timer, so it floors
// at Rare. Set per-crate so every crate stays solvent (proven in test/gacha.test.js).
export const CRATES = {
  common:    { priceUsdCents: 500,  odds: [0.90, 0.08, 0.018, 0.002], pityFloor: "rare" },
  rare:      { priceUsdCents: 1500, odds: [0.40, 0.45, 0.12,  0.03],  pityFloor: "epic" },
  epic:      { priceUsdCents: 2500, odds: [0.20, 0.38, 0.32,  0.10],  pityFloor: "epic" },
  legendary: { priceUsdCents: 4000, odds: [0.00, 0.10, 0.50,  0.40],  pityFloor: "legendary" },
};

export const BUYBACK_BPS = 7000;   // sell back for 70% of tokens paid
export const PITY_PULLS = 10;      // guaranteed epic-or-better within every 10 pulls
export const GAME_PRICE_CEILING_CENTS = 7000; // no crate may exceed a top game (~$70)

// MSRP -> rarity tier (cents). Uses list price, not sale price.
export const TIER_CENTS = { common: 1000, rare: 2500, epic: 5000 }; // legendary = above epic

// Validate config at load — a bad odds table should never ship.
(function assertConfig() {
  for (const [key, c] of Object.entries(CRATES)) {
    if (c.odds.length !== RARITIES.length) throw new Error(`gacha: ${key} odds length`);
    const sum = c.odds.reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 1e-9) throw new Error(`gacha: ${key} odds sum ${sum} != 1`);
    if (c.odds.some((p) => p < 0)) throw new Error(`gacha: ${key} negative odds`);
    if (c.priceUsdCents > GAME_PRICE_CEILING_CENTS)
      throw new Error(`gacha: ${key} price exceeds game ceiling`);
  }
})();

// --- Deterministic randomness ---------------------------------------------
// uniform in [0,1) from a public seed (drand round value) + a per-pull nonce.
// Reproducible by anyone: hash(seed:nonce) -> first 52 bits -> /2^52.
export function uniform(seed, nonce) {
  const h = createHash("sha256").update(`${seed}:${nonce}`).digest();
  // 52 bits keeps us inside JS's exact-integer range (Number.MAX_SAFE_INTEGER).
  const hi = h.readUInt32BE(0) & 0xfffff;      // top 20 bits
  const lo = h.readUInt32BE(4);                // next 32 bits
  const val = hi * 2 ** 32 + lo;               // 52-bit integer
  return val / 2 ** 52;                         // [0,1)
}

// inverse-CDF: map a uniform to a rarity using an odds array.
export function mapUniformToRarity(odds, u) {
  let acc = 0;
  for (let i = 0; i < odds.length; i++) {
    acc += odds[i];
    if (u < acc) return RARITIES[i];
  }
  return RARITIES[RARITIES.length - 1]; // float safety: last bucket
}

// --- Pity ------------------------------------------------------------------
// misses = count of consecutive pulls that were BELOW the crate's pity floor.
// Guarantee: never more than PITY_PULLS-1 misses in a row -> at least one
// floor-or-better in every window of PITY_PULLS pulls.
export function applyPity(natural, misses, floor = "epic", pity = true) {
  let rarity = natural;
  let forced = false;
  if (pity && misses >= PITY_PULLS - 1 && rankOf(natural) < rankOf(floor)) {
    rarity = floor;
    forced = true;
  }
  const metFloor = rankOf(rarity) >= rankOf(floor);
  const nextMisses = metFloor ? 0 : misses + 1;
  return { rarity, forced, missesSinceEpic: nextMisses };
}

// Full resolve: (crate, seed, nonce, pity counter) -> rarity outcome.
// The pity floor is read from the crate config.
export function resolvePull(crateKey, seed, nonce, misses = 0, opts = {}) {
  const crate = CRATES[crateKey];
  if (!crate) throw new Error(`gacha: unknown crate ${crateKey}`);
  const u = uniform(seed, nonce);
  const natural = mapUniformToRarity(crate.odds, u);
  const pitied = applyPity(natural, misses, crate.pityFloor, opts.pity !== false);
  return { crate: crateKey, natural, ...pitied };
}

// --- Buyback ---------------------------------------------------------------
// paidRaw: BigInt of $DROP base units the player paid. Returns 70% floored.
export function buybackRaw(paidRaw) {
  const p = BigInt(paidRaw);
  if (p < 0n) throw new Error("gacha: negative paid amount");
  return (p * BigInt(BUYBACK_BPS)) / 10000n;
}

// --- Reveal-gate state machine --------------------------------------------
// After a pull resolves it is `sealed` for a research window (CLAIM_WINDOW_SEC).
// Within the window the owner may sell it back for 70% (they've seen the game +
// Steam price but not the key). They may reveal (claim the key) at any time.
// When the window elapses the pull is `finalize`d to `kept` — no more sell-back,
// key still claimable whenever. Terminal states (revealed, sold_back) are frozen.
//
//   sealed --reveal--> revealed        (claim the key; anti-double-dip locks it)
//   sealed --sellback-> sold_back      (only while inside the window)
//   sealed --finalize-> kept           (window elapsed; key is theirs to claim)
//   kept   --reveal--> revealed
export const PULL_STATES = ["sealed", "kept", "revealed", "sold_back"];
export const CLAIM_WINDOW_SEC = 240; // 4-minute research window (3–5 min band)

export function newPull({ id, owner, crate, rarity, gameTitle, paidRaw }) {
  return {
    id, owner, crate, rarity, gameTitle,
    paidRaw: BigInt(paidRaw).toString(),
    state: "sealed",
  };
}

export function transition(pull, action, ctx = {}) {
  const s = pull.state;
  switch (action) {
    case "reveal": // claim the key — allowed while sealed or after auto-keep
      if (s !== "sealed" && s !== "kept") throw new Error(`gacha: pull ${pull.id} is ${s}; cannot reveal`);
      return { ...pull, state: "revealed", revealedAt: ctx.now ?? null };
    case "sellback": // 70% refund — ONLY inside the research window (sealed)
      if (s !== "sealed") throw new Error(`gacha: pull ${pull.id} is ${s}; cannot sell back`);
      return { ...pull, state: "sold_back", refundRaw: buybackRaw(pull.paidRaw).toString(), soldBackAt: ctx.now ?? null };
    case "finalize": // research window elapsed -> key is theirs, sell-back closes
      if (s !== "sealed") throw new Error(`gacha: pull ${pull.id} is ${s}; cannot finalize`);
      return { ...pull, state: "kept", keptAt: ctx.now ?? null };
    default:
      throw new Error(`gacha: unknown action ${action}`);
  }
}

// --- Tiering & pricing helpers --------------------------------------------
// MSRP (list price, cents) -> rarity bucket. Operator can override.
export function tierFromMsrpCents(cents) {
  if (cents <= TIER_CENTS.common) return "common";
  if (cents <= TIER_CENTS.rare) return "rare";
  if (cents <= TIER_CENTS.epic) return "epic";
  return "legendary";
}

// USD-pegged crate price -> $DROP base units, given a live $DROP price.
// priceUsdCents: crate price in cents; dropUsd: $ per 1 whole $DROP; decimals: token decimals.
export function tokensForCrate(priceUsdCents, dropUsd, decimals = 6) {
  if (!(dropUsd > 0)) throw new Error("gacha: bad $DROP price");
  const whole = priceUsdCents / 100 / dropUsd;          // whole tokens (float)
  return BigInt(Math.round(whole * 10 ** decimals));    // base units
}
