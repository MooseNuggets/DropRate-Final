import { sql, migrate } from "../lib/db.js";

// Public site stats — safe aggregates only, cached at the edge for 60s.
export default async function handler(req, res) {
  try {
    await migrate();
    const claimed = await sql`
      SELECT count(*)::int AS n FROM winners WHERE status = 'claimed'`;
    const drawn = await sql`
      SELECT count(*)::int AS n FROM draws WHERE status = 'drawn'`;
    const holders = await sql`
      SELECT holder_count FROM snapshots WHERE status = 'taken'
      ORDER BY window_start DESC LIMIT 1`;
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    res.status(200).json({
      keys_claimed: claimed.rows[0].n,
      draws_run: drawn.rows[0].n,
      holders: holders.rows[0]?.holder_count ?? 0,
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}
