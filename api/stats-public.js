import { sql, migrate } from "../lib/db.js";

// Public site stats + live win feed — SELF-CONTAINED (no external lib beyond db).
// Raffle numbers compute first and always return; the gacha dashboard + live feed
// are layered on inside their own guard so one bad query can never blank the page.
const short = (w) => {
  const s = String(w || "");
  return s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
};

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

    // --- gacha dashboard + live feed (guarded; kept/revealed only) ---
    let cratesOpened = 0, burnedRaw = "0", cratesKept = 0, feed = [];
    try {
      const opened = await sql`SELECT count(*)::int AS n FROM pulls WHERE paid = true`;
      const burned = await sql`
        SELECT COALESCE(sum(floor(paid_raw / 10)), 0)::text AS raw
        FROM pulls WHERE paid = true`;
      const kept = await sql`
        SELECT count(*)::int AS n FROM pulls WHERE state IN ('kept', 'revealed')`;
      const rows = await sql`
        SELECT p.id, p.rarity, p.crate, p.owner,
               COALESCE(p.resolved_at, p.created_at) AS at,
               k.game_title, k.image
        FROM pulls p
        LEFT JOIN crate_keys k ON k.id = p.key_id
        WHERE p.state IN ('kept', 'revealed')
        ORDER BY COALESCE(p.resolved_at, p.created_at) DESC
        LIMIT 20`;
      cratesOpened = opened.rows[0].n;
      burnedRaw = burned.rows[0].raw;
      cratesKept = kept.rows[0].n;
      feed = rows.rows.map((r) => ({
        id: r.id,                          // pull id — lets anyone re-verify at /verify.html?pull=<id>
        game: r.game_title || "Mystery game",
        image: r.image || null,
        rarity: r.rarity,
        crate: r.crate,
        wallet: short(r.owner),
        at: r.at,
      }));
    } catch (e) {
      console.error("gacha stats:", e.message);
    }

    res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=40");
    res.status(200).json({
      keys_claimed: claimed.rows[0].n,          // raffle keys claimed
      draws_run: drawn.rows[0].n,
      holders: holders.rows[0]?.holder_count ?? 0,
      crates_opened: cratesOpened,               // crates pulled
      crate_keys_claimed: cratesKept,            // crate keys kept/revealed
      drop_burned_raw: burnedRaw,                // base units; UI divides by 10^decimals
      feed,                                      // [{game,image,rarity,crate,wallet,at}]
      decimals: Number(process.env.DROP_DECIMALS || 6),
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}
