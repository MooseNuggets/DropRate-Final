// ============================ HOLD-STREAK REWARDS ============================
// Diamond-hands loyalty bonus. A wallet's CURRENT clean-hold streak is measured
// exactly like eligibility (see eligibility.js): starting from the newest
// snapshot and walking back, the run continues while
//   1. the wallet is present with tickets >= 1 in every snapshot (no gap), and
//   2. its ADJUSTED balance (on-chain + cumulative gacha spend) never decreases
//      as time moves forward.
// Spending $DROP on crates is added back, so using the product never breaks the
// streak; a real dump / transfer out does.
//
// The streak LENGTH is a duration in time — (newest.taken_at - oldest-in-run's
// taken_at) — not a raw snapshot count, so a single missed hourly snapshot
// (cron blip) can't unfairly reset a multi-day streak.
//
// Reward: once the streak reaches BONUS_START_DAYS, the wallet earns
// BONUS bonus raffle entries on top of its balance tickets:
//   bonus = holdDays < START ? 0 : 1 + floor((holdDays - START) / STEP_DAYS)
// i.e. +1 at day 10, then +1 every 2 days, uncapped.

export const STREAK = {
  BONUS_START_DAYS: 10,   // clean-hold days before the first bonus entry
  STEP_DAYS: 2,           // +1 bonus entry per this many additional days
  CAP: null,              // null = uncapped
};

const DAY_MS = 86400000;
const toBig = (x) => BigInt(String(x).split(".")[0]);

// Bonus entries for a given clean-hold duration (in days).
export function bonusFor(holdDays) {
  if (holdDays < STREAK.BONUS_START_DAYS) return 0;
  let b = 1 + Math.floor((holdDays - STREAK.BONUS_START_DAYS) / STREAK.STEP_DAYS);
  if (STREAK.CAP != null && b > STREAK.CAP) b = STREAK.CAP;
  return b;
}

// Milliseconds until this wallet's NEXT bonus entry (for UI countdowns).
export function msToNextBonus(holdDays) {
  if (holdDays < STREAK.BONUS_START_DAYS) return (STREAK.BONUS_START_DAYS - holdDays) * DAY_MS;
  if (STREAK.CAP != null && bonusFor(holdDays) >= STREAK.CAP) return null; // maxed
  const stepsDone = Math.floor((holdDays - STREAK.BONUS_START_DAYS) / STREAK.STEP_DAYS);
  const nextThresholdDays = STREAK.BONUS_START_DAYS + (stepsDone + 1) * STREAK.STEP_DAYS;
  return (nextThresholdDays - holdDays) * DAY_MS;
}

// ---- Diamond-hands TIERS (display only) ----
// A wallet's tier is purely a function of clean-hold days. Single source of
// truth — the checker and the win share cards both read this via /api/check.
export const TIERS = [
  { key: "paper",   name: "Paper",   min: 0,   color: "#9AA6C7" },
  { key: "bronze",  name: "Bronze",  min: 10,  color: "#CD7F32" },
  { key: "silver",  name: "Silver",  min: 25,  color: "#C0C7D4" },
  { key: "gold",    name: "Gold",    min: 50,  color: "#F6AC29" },
  { key: "diamond", name: "Diamond", min: 100, color: "#5AD8F0" },
];

export function tierFor(holdDays) {
  const d = Number(holdDays) || 0;
  let idx = 0;
  for (let i = 0; i < TIERS.length; i++) if (d >= TIERS[i].min) idx = i;
  const cur = TIERS[idx];
  const nx = TIERS[idx + 1] || null;
  return {
    key: cur.key,
    name: cur.name,
    label: cur.name + " hands",
    color: cur.color,
    minDays: cur.min,
    nextName: nx ? nx.name : null,
    nextAtDays: nx ? nx.min : null,
    daysToNext: nx ? Math.max(0, nx.min - d) : null,
  };
}

// Core: compute each wallet's current clean-hold streak + bonus.
//   orderedSnaps : [{id, taken_at}] newest -> oldest (taken snapshots only)
//   entryRows    : [{snapshot_id, wallet, balance_raw, tickets}]
//   spentByWallet: Map(wallet -> Map(snapshot_id -> cumulative gacha spend raw))
//   nowMs        : reference "now" (defaults to newest snapshot's taken_at)
// Returns Map(wallet -> { holdMs, holdDays, bonus, msToNext, runReachesScanEdge })
// runReachesScanEdge = true means the clean run extends past the oldest snapshot
// we were given, so the true streak may be LONGER — callers should scan back far
// enough (e.g. to launch) that this stays false for correctness.
export function computeStreaks(orderedSnaps, entryRows, spentByWallet = new Map()) {
  const idIndex = new Map(orderedSnaps.map((s, i) => [s.id, i])); // 0 = newest
  const takenAt = orderedSnaps.map((s) => new Date(s.taken_at).getTime());
  const byWallet = new Map();
  for (const r of entryRows) {
    if (!idIndex.has(r.snapshot_id)) continue;
    if (!byWallet.has(r.wallet)) byWallet.set(r.wallet, new Map());
    byWallet.get(r.wallet).set(idIndex.get(r.snapshot_id), r);
  }
  const cumSpent = (wallet, snapshotId) => {
    const m = spentByWallet.get(wallet);
    const v = m && m.get(snapshotId);
    return v ? BigInt(v) : 0n;
  };
  const out = new Map();
  for (const [wallet, perIdx] of byWallet) {
    const head = perIdx.get(0);
    if (!head || head.tickets < 1) { // not currently holding at the newest snapshot
      out.set(wallet, { holdMs: 0, holdDays: 0, bonus: 0, msToNext: STREAK.BONUS_START_DAYS * DAY_MS, runReachesScanEdge: false });
      continue;
    }
    let oldestIdx = 0;
    for (let i = 1; i < orderedSnaps.length; i++) {
      const row = perIdx.get(i);
      if (!row || row.tickets < 1) break;                 // gap / dropped out
      const newer = perIdx.get(i - 1);
      const balOlder = toBig(row.balance_raw) + cumSpent(wallet, row.snapshot_id);
      const balNewer = toBig(newer.balance_raw) + cumSpent(wallet, newer.snapshot_id);
      if (balNewer < balOlder) break;                     // adjusted dropped going forward = a sell in the run
      oldestIdx = i;
    }
    const holdMs = takenAt[0] - takenAt[oldestIdx];
    const holdDays = holdMs / DAY_MS;
    out.set(wallet, {
      holdMs,
      holdDays,
      bonus: bonusFor(holdDays),
      msToNext: msToNextBonus(holdDays),
      runReachesScanEdge: oldestIdx === orderedSnaps.length - 1,
    });
  }
  return out;
}

// Cumulative gacha (crate) spend per wallet as of each snapshot's taken_at.
// Identical rule to eligibility.js so the crate exemption matches exactly.
// Safe if the `pulls` table doesn't exist yet -> returns an empty map.
export async function gachaSpendByWallet(sql, snapRows) {
  let spend;
  try {
    spend = await sql`SELECT owner, paid_raw, resolved_at FROM pulls WHERE paid = true AND resolved_at IS NOT NULL`;
  } catch {
    return new Map();
  }
  const snaps = snapRows
    .map((s) => ({ id: s.id, t: new Date(s.taken_at).getTime() }))
    .sort((a, b) => a.t - b.t);
  const byWallet = new Map();
  for (const r of spend.rows) {
    if (!byWallet.has(r.owner)) byWallet.set(r.owner, []);
    byWallet.get(r.owner).push({ amt: toBig(r.paid_raw), t: new Date(r.resolved_at).getTime() });
  }
  const out = new Map();
  for (const [wallet, evs] of byWallet) {
    evs.sort((a, b) => a.t - b.t);
    const m = new Map();
    let i = 0, cum = 0n;
    for (const s of snaps) {
      while (i < evs.length && evs[i].t <= s.t) { cum += evs[i].amt; i++; }
      m.set(s.id, cum);
    }
    out.set(wallet, m);
  }
  return out;
}

// Convenience loader mirroring loadEligibility(): scans taken snapshots back to
// `sinceIso` (default: everything) so streaks longer than SELL_LOOKBACK resolve.
// Self-contained — no dependency on eligibility.js internals.
export async function loadStreaks(sinceIso = null) {
  const { sql } = await import("./db.js");
  const snaps = sinceIso
    ? await sql`SELECT id, taken_at FROM snapshots WHERE status='taken' AND taken_at >= ${sinceIso} ORDER BY window_start DESC`
    : await sql`SELECT id, taken_at FROM snapshots WHERE status='taken' ORDER BY window_start DESC`;
  const ids = snaps.rows.map((s) => s.id);
  if (!ids.length) return { ids, streaks: new Map() };
  const rows = await sql.query(
    `SELECT snapshot_id, wallet, balance_raw, tickets FROM snapshot_entries
     WHERE snapshot_id = ANY($1::int[])`, [ids]);
  const spentByWallet = await gachaSpendByWallet(sql, snaps.rows);
  return { ids, streaks: computeStreaks(snaps.rows, rows.rows, spentByWallet) };
}

// Single-wallet streak, for the public eligibility checker (/api/check).
// Only scans that wallet's rows, so it's cheap to call per lookup.
export async function loadWalletStreak(wallet, sinceIso = null) {
  const DAY = 86400000;
  const empty = { holdMs: 0, holdDays: 0, bonus: 0, msToNext: STREAK.BONUS_START_DAYS * DAY, runReachesScanEdge: false };
  const { sql } = await import("./db.js");
  const snaps = sinceIso
    ? await sql`SELECT id, taken_at FROM snapshots WHERE status='taken' AND taken_at >= ${sinceIso} ORDER BY window_start DESC`
    : await sql`SELECT id, taken_at FROM snapshots WHERE status='taken' ORDER BY window_start DESC`;
  if (!snaps.rows.length) return empty;
  const ids = snaps.rows.map((s) => s.id);
  const er = await sql.query(
    `SELECT snapshot_id, wallet, balance_raw, tickets FROM snapshot_entries
     WHERE wallet = $1 AND snapshot_id = ANY($2::int[])`, [wallet, ids]);
  if (!er.rows.length) return empty;
  const spent = await gachaSpendByWallet(sql, snaps.rows);
  const streaks = computeStreaks(snaps.rows, er.rows, spent);
  return streaks.get(wallet) || empty;
}
