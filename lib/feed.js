// ============================================================================
// DROPRATE — public live-feed + gacha stats (ADDITIVE, read-only)
//
// Pure read queries over the gacha tables (pulls / settlements / crate_keys).
// No writes, no auth, no PII: wallets are truncated, keys are never touched.
// Consumed by the public stats endpoint so the homepage/crates can show a live
// win feed and headline counters. Every function soft-fails to a safe empty
// value so a cold or empty gacha DB never breaks the page.
// ============================================================================

import { sql } from "./db.js";

const short = (w) => {
  const s = String(w || "");
  return s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
};

// Only finalized keeps count as a "win" — a pull the owner claimed (revealed)
// or that auto-kept when its window closed. In-window (sealed), sold_back,
// owed and awaiting_payment are all excluded so nothing that can still be
// returned ever shows as a win.
const WON_STATES = ["kept", "revealed"];

// Headline counters for the dashboard.
export async function gachaStats() {
  const opened = await sql`SELECT count(*)::int AS n FROM pulls WHERE paid = true`;
  // The 10% burn happens IN the buyer's payment tx (a burnChecked leg of the
  // at-source split), not as a settlement row — so we can't sum settlements.
  // Every paid open burned exactly floor(paid_raw / 10) on-chain; sum that.
  const burned = await sql`
    SELECT COALESCE(sum(floor(paid_raw / 10)), 0)::text AS raw
    FROM pulls WHERE paid = true`;
  const kept = await sql`
    SELECT count(*)::int AS n FROM pulls
    WHERE state IN ('kept', 'revealed')`;
  return {
    crates_opened: opened.rows[0].n,
    drop_burned_raw: burned.rows[0].raw,   // base units; UI divides by 10^decimals
    games_kept: kept.rows[0].n,            // crate keys claimed (draws counted separately)
  };
}

// Recent wins for the live ticker. Newest first, game art + rarity + truncated
// wallet + when. No wallet is ever returned in full.
export async function recentFeed(limit = 20) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const r = await sql`
    SELECT p.rarity, p.crate, p.owner,
           COALESCE(p.resolved_at, p.created_at) AS at,
           k.game_title, k.image
    FROM pulls p
    LEFT JOIN crate_keys k ON k.id = p.key_id
    WHERE p.state IN ('kept', 'revealed')
    ORDER BY COALESCE(p.resolved_at, p.created_at) DESC
    LIMIT ${n}`;
  return r.rows.map((row) => ({
    game: row.game_title || "Mystery game",
    image: row.image || null,
    rarity: row.rarity,
    crate: row.crate,
    wallet: short(row.owner),
    at: row.at,
  }));
}

// The flex: highest-MSRP game anyone has pulled and kept.
export async function biggestPull() {
  const r = await sql`
    SELECT k.game_title, k.image, p.rarity, p.owner, k.msrp_cents
    FROM pulls p
    JOIN crate_keys k ON k.id = p.key_id
    WHERE p.state IN ('kept', 'revealed') AND k.msrp_cents IS NOT NULL
    ORDER BY k.msrp_cents DESC
    LIMIT 1`;
  if (!r.rows.length) return null;
  const b = r.rows[0];
  return {
    game: b.game_title || "Mystery game",
    image: b.image || null,
    rarity: b.rarity,
    wallet: short(b.owner),
    msrp_cents: b.msrp_cents,
  };
}

// One call for the endpoint: everything the dashboard needs, each part guarded
// so a single failing query can't take down the rest.
export async function feedPayload(limit = 20) {
  const [stats, feed, biggest] = await Promise.all([
    gachaStats().catch(() => ({ crates_opened: 0, drop_burned_raw: "0", games_kept: 0 })),
    recentFeed(limit).catch(() => []),
    biggestPull().catch(() => null),
  ]);
  return { ...stats, biggest, feed };
}
