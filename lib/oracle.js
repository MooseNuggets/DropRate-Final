// ============================================================================
// DROPRATE — $DROP/USD price oracle (wires currentDropUsd for the gacha route)
//
// Crates are priced in USD, paid in $DROP, so every quote needs a $DROP/USD
// price. This module does the NETWORK part (fetch spot from Jupiter, keep a
// rolling sample history for the TWAP) and hands it to lib/price.safePrice(),
// which is the pure, tested manipulation guard (median of sources, TWAP compare,
// deviation clamp). Nothing here is called by the raffle — gacha only.
//
// Testing override: set DROP_USD to a fixed number and this returns it directly,
// skipping the network entirely. That's what the hidden test deploy uses until
// you're ready to point it at the live market.
// ============================================================================

import { sql } from "./db.js";
import { safePrice } from "./price.js";

const MINT = () => process.env.DROP_MINT;
const SAMPLE_WINDOW_MIN = Number(process.env.PRICE_TWAP_MIN || 30); // TWAP lookback
const MAX_DEV_BPS = Number(process.env.PRICE_MAX_DEV_BPS || 1500); // 15% default

// Jupiter public price API. Format has drifted across versions, so parse both the
// v3 ({ <mint>: { usdPrice } }) and v2 ({ data: { <mint>: { price } } }) shapes.
async function jupiterSpot(mint, fetchJson = defaultFetch) {
  const urls = [
    `https://lite-api.jup.ag/price/v3?ids=${mint}`,
    `https://api.jup.ag/price/v2?ids=${mint}`,
  ];
  for (const url of urls) {
    try {
      const j = await fetchJson(url);
      const node = j?.[mint] ?? j?.data?.[mint];
      const p = Number(node?.usdPrice ?? node?.price);
      if (Number.isFinite(p) && p > 0) return p;
    } catch { /* try next */ }
  }
  return null;
}

async function defaultFetch(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`oracle: ${url} -> ${res.status}`);
  return res.json();
}

async function ensureSamplesTable() {
  await sql`CREATE TABLE IF NOT EXISTS price_samples(
    id serial PRIMARY KEY,
    price double precision NOT NULL,
    taken_at timestamptz NOT NULL DEFAULT now()
  )`;
}

// Record one spot sample and return the recent history for the TWAP.
async function recordAndLoadHistory(spot) {
  await ensureSamplesTable();
  await sql`INSERT INTO price_samples(price) VALUES (${spot})`;
  const r = await sql`
    SELECT price, extract(epoch from taken_at) * 1000 AS t
    FROM price_samples
    WHERE taken_at > now() - (${SAMPLE_WINDOW_MIN} || ' minutes')::interval
    ORDER BY taken_at ASC`;
  return r.rows.map((row) => ({ t: Number(row.t), price: Number(row.price) }));
}

// The seam api/crate.js calls. Returns a plain number (USD per 1 $DROP).
//   - DROP_USD set            -> return it (test/dev override, no network)
//   - otherwise               -> Jupiter spot -> safePrice guard against TWAP
export async function currentDropUsd(opts = {}) {
  if (process.env.DROP_USD) {
    const p = Number(process.env.DROP_USD);
    if (!Number.isFinite(p) || p <= 0) throw new Error("oracle: DROP_USD is not a positive number");
    return p;
  }
  const mint = MINT();
  if (!mint) throw new Error("oracle: DROP_MINT not set (or set DROP_USD to override)");

  const fetchJson = opts.fetchJson || defaultFetch;
  const spot = await jupiterSpot(mint, fetchJson);
  if (spot == null) throw new Error("oracle: no live $DROP price from any source");

  // Build history from persisted samples; if we don't have enough yet, seed the
  // TWAP with the current spot so the first quotes still work (deviation = 0).
  let history;
  try {
    history = await recordAndLoadHistory(spot);
  } catch {
    history = [];
  }
  if (history.length < 2) history = [{ t: Date.now() - 1000, price: spot }, { t: Date.now(), price: spot }];

  const guarded = safePrice([spot], history, { maxDeviationBps: MAX_DEV_BPS });
  return guarded.price;
}
