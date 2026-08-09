# DROPRATE — Gacha / Crate System Spec (v0.1)

Status: design locked except where marked OPEN. Legal review deferred (owner decision).

## Concept
Holders spend $DROP to open crates and to enter the 8-hour draws. Crates pull a
random game key by rarity, with published odds and drand-verified randomness —
the first provably-fair gacha. Same encrypted vault as the raffle.

## Currency & split
- Currency: $DROP for crates AND draws.
- Every spend splits: 70% treasury (funds prizes + buybacks), 30% burn.
- Pricing: USD-pegged (see Tokenomics) — crate costs a fixed USD value, paid in
  the equivalent $DROP at open time. Buyback is a fixed % of TOKENS paid (below).

## Crates (published loot table)
| Crate | Price | Common | Rare | Epic | Legendary |
|---|---|---|---|---|---|
| Common | $5 | 90% | 8% | 1.8% | 0.2% |
| Rare | $15 | 40% | 45% | 12% | 3% |
| Epic | $25 | 20% | 38% | 32% | 10% |
| Legendary | $50 | 3% | 15% | 47% | 35% |

No crate exceeds the ~$70 top-game ceiling. Every crate keeps a live Legendary tail.
Odds are PUBLISHED (paid product = transparency, unlike the free raffle's mystery).

## Rarity tiering
- By MSRP (Steam storefront API `initial` field), NOT quality.
  - Common ≤ $10 · Rare $10–25 · Epic $25–50 · Legendary $50+
- Steam API auto-fetches MSRP + current price + cover art; auto-suggests tier.
- Operator confirms or one-click overrides. Cost (G2A spend) is the only manual field.

## Pull flow (the anti-fuckery gate)
1. Pay → 2. Open crate → 3. Presents the GAME TITLE (key still sealed/encrypted) →
4. Choose:
   - REVEAL key → locked to you, non-transferable, NO buyback.
   - Don't reveal → SELL BACK for 70% of tokens paid, OR list sealed on marketplace.
- Key only decrypts (cost realized) on REVEAL. Sell-back returns the key to the pool.

## Buyback
- Flat 70% of the $DROP you paid (token-denominated, not USD, no oracle at sell-time).
- Walk-away cost is a clean 30% — that 30% is the house's baseline margin + burn.

## Pity
- Guaranteed Epic-or-better every 10 pulls on a given crate.

## Randomness
- Each pull commits a future drand round before opening; result reproducible.
- Published odds + verifiable pulls = the brand differentiator.

## Economics / solvency
- Margin comes from the gap between RETAIL (what the player feels) and YOUR COST
  (G2A), plus the 30% kept on every buyback — NOT from fleecing players.
- Rule: keep each rarity bucket's average sourcing cost below the crate price.
  Sensitive inputs: Epic + Legendary bucket costs (keep Legendary avg ≤ ~$40).
- Solvent under realistic G2A costs even at 35% Legendary; verified via stress test.

## Marketplace (PHASE 2)
- Trade SEALED (unrevealed) pulls for $DROP. Reveal locks/untradeable.
- Small marketplace fee → burned (extra sink).
- Escrow/atomic swap so neither side can rug.

## OPEN ITEMS
- Real per-bucket G2A costs (to stamp final margins).
- Dead-key policy: G2A revoked keys → treasury-funded instant replacement; buy only
  guarantee-backed sellers. Critical before marketplace.
- Burn-control / deflation governor — SEE tokenomics, being decided now.
- USD price oracle source for a micro-cap (pool TWAP vs Jupiter/Pyth).

## Build order
1. Key-loader (Steam price-fetch + tier auto-suggest + vault encryption).
2. Crate open + reveal-gate + buyback.
3. $DROP integration into the 8-hour draws.
4. Marketplace.
