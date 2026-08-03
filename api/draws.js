import { sql, migrate } from "../lib/db.js";

export default async function handler(req, res) {
  try {
    await migrate();
    const draws = await sql`
      SELECT d.id, d.scheduled_at, d.prize_title, d.n_winners, d.drand_round,
             d.seed, d.status, d.snapshot_id, s.merkle_root
      FROM draws d LEFT JOIN snapshots s ON s.id = d.snapshot_id
      ORDER BY d.scheduled_at DESC LIMIT 60`;
    const ids = draws.rows.map((d) => d.id);
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
