import { sql, migrate } from "../lib/db.js";
import { loadEligibility } from "../lib/eligibility.js";
export default async function handler(req, res) {
  try {
    await migrate();

    // Single-draw lookup (?id=N) — returns the exact recorded pool (pool_json) so
    // the public verifier can reproduce winners with loyalty bonuses baked in.
    // Kept off the list response so the 60-draw payload stays small.
    const oneId = Number(req.query.id);
    if (req.query.id != null && Number.isFinite(oneId)) {
      // safe if the column predates the draw-tick that adds it
      await sql`ALTER TABLE draws ADD COLUMN IF NOT EXISTS pool_json text`;
      const r = await sql`
        SELECT d.id, d.scheduled_at, d.prize_title, d.n_winners, d.drand_round,
               d.seed, d.status, d.snapshot_id, s.merkle_root,
               d.pool_holders, d.pool_tickets, d.pool_free, d.pool_json
        FROM draws d LEFT JOIN snapshots s ON s.id = d.snapshot_id
        WHERE d.id = ${oneId}`;
      if (!r.rows.length) return res.status(404).json({ error: "draw not found" });
      const wq = await sql`
        SELECT wallet, sel_index, status FROM winners
        WHERE draw_id = ${oneId} ORDER BY sel_index`;
      const draw = {
        ...r.rows[0],
        winners: wq.rows.map((w) => ({ wallet: w.wallet, status: w.status })),
      };
      res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");
      return res.status(200).json({ draw });
    }

    const draws = await sql`
      SELECT d.id, d.scheduled_at, d.prize_title, d.n_winners, d.drand_round,
             d.seed, d.status, d.snapshot_id, s.merkle_root,
             d.pool_holders, d.pool_tickets, d.pool_free,
             (SELECT count(*)::int FROM free_entries f WHERE f.draw_id = d.id) AS live_free
      FROM draws d LEFT JOIN snapshots s ON s.id = d.snapshot_id
      ORDER BY d.scheduled_at DESC LIMIT 60`;
    const ids = draws.rows.map((d) => d.id);
    let liveHolders = 0, liveTickets = 0;
    try {
      const { results } = await loadEligibility();
      for (const [, r] of results) if (r.eligible && r.tickets >= 1) { liveHolders++; liveTickets += r.tickets; }
    } catch (e) { console.error("eligibility:", e); }
    let winners = [];
    if (ids.length) {
      const w = await sql.query(
        `SELECT draw_id, wallet, sel_index, status FROM winners
         WHERE draw_id = ANY($1::int[]) ORDER BY sel_index`,
        [ids]
      );
      winners = w.rows;
    }
    res.status(200).json({
      live_holders: liveHolders,
      live_tickets: liveTickets,
      draws: draws.rows.map((d) => ({
        ...d,
        winners: winners.filter((w) => w.draw_id === d.id)
          .map((w) => ({ wallet: w.wallet, status: w.status })),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}
