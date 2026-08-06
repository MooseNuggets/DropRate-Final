import { CONFIG } from "./config.js";

// Shared eligibility engine used by the draw tick AND the public checker,
// so both always agree.
//
// A wallet is eligible when, over the last SELL_LOOKBACK taken snapshots:
//   1. it appears (tickets >= 1) in ALL of the most recent K_CONSECUTIVE, and
//   2. from its FIRST appearance inside the lookback onward it is present in
//      every snapshot (no exit-and-return), and
//   3. its balance NEVER DECREASES between consecutive appearances.
// Any sell — partial or full — restarts the clock: the wallet only becomes
// eligible again once a clean, non-decreasing streak covers the requirement.

export function evaluateWallets(orderedSnapshotIds, entryRows) {
  // orderedSnapshotIds: newest -> oldest, taken snapshots only
  // entryRows: [{snapshot_id, wallet, balance_raw, tickets}]
  const idIndex = new Map(orderedSnapshotIds.map((id, i) => [id, i])); // 0 = newest
  const byWallet = new Map();
  for (const r of entryRows) {
    if (!idIndex.has(r.snapshot_id)) continue;
    if (!byWallet.has(r.wallet)) byWallet.set(r.wallet, new Map());
    byWallet.get(r.wallet).set(idIndex.get(r.snapshot_id), r);
  }
  const K = CONFIG.K_CONSECUTIVE;
  const results = new Map();
  for (const [wallet, perIdx] of byWallet) {
    // rule 1: present in the newest K snapshots
    let streakOk = orderedSnapshotIds.length >= K;
    for (let i = 0; i < K && streakOk; i++) {
      const row = perIdx.get(i);
      if (!row || row.tickets < 1) streakOk = false;
    }
    // rules 2+3: within the lookback, from oldest appearance forward:
    // contiguous presence and non-decreasing balance
    let soldRecently = false;
    const indices = [...perIdx.keys()].sort((a, b) => b - a); // oldest -> newest
    for (let j = 0; j < indices.length; j++) {
      if (j > 0) {
        if (indices[j] !== indices[j - 1] - 1) { soldRecently = true; break; } // gap = exited & returned
        const prev = BigInt(String(perIdx.get(indices[j - 1]).balance_raw).split(".")[0]);
        const cur  = BigInt(String(perIdx.get(indices[j]).balance_raw).split(".")[0]);
        if (cur < prev) { soldRecently = true; break; } // balance dropped = sold
      }
    }
    // an exit at the newest end (absent from latest snapshots) is caught by rule 1
    const eligible = streakOk && !soldRecently;
    const latest = perIdx.get(0);
    results.set(wallet, {
      eligible,
      soldRecently,
      streakOk,
      tickets: eligible && latest ? latest.tickets : 0,
    });
  }
  return results;
}

export async function loadEligibility() {
  const { sql } = await import("./db.js");
  const snaps = await sql`
    SELECT id FROM snapshots WHERE status = 'taken'
    ORDER BY window_start DESC LIMIT ${CONFIG.SELL_LOOKBACK}`;
  const ids = snaps.rows.map((s) => s.id);
  if (ids.length < CONFIG.K_CONSECUTIVE) return { ids, results: new Map() };
  const rows = await sql.query(
    `SELECT snapshot_id, wallet, balance_raw, tickets FROM snapshot_entries
     WHERE snapshot_id = ANY($1::int[])`, [ids]);
  return { ids, results: evaluateWallets(ids, rows.rows) };
}
