import { sql, migrate } from "../lib/db.js";
import { feedPayload } from "../lib/feed.js";

// Public site stats + live win feed — safe aggregates only, edge-cached.
// Raffle numbers are computed first and always return; the gacha dashboard +
// live feed are layered on and soft-fail independently so one bad query can
// never blank the homepage chips.
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

    // gacha stats + live feed — layered on, guarded so raffle stats always return
    let gacha = { crates_opened: 0, drop_burned_raw: "0", games_kept: 0, biggest: null, feed: [] };
    try { gacha = await feedPayload(20); } catch (e) { console.error("feed:", e.message); }

    const keysClaimed = claimed.rows[0].n;
    res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=40");
    res.status(200).json({
      // existing raffle chips
      keys_claimed: keysClaimed,
      draws_run: drawn.rows[0].n,
      holders: holders.rows[0]?.holder_count ?? 0,
      // gacha dashboard
      crates_opened: gacha.crates_opened,
      drop_burned_raw: gacha.drop_burned_raw,        // base units; UI divides by 10^decimals
      games_given: keysClaimed + (gacha.games_kept || 0),  // draw wins + crate keeps
      biggest: gacha.biggest,                        // {game,image,rarity,wallet,msrp_cents} | null
      feed: gacha.feed,                              // [{game,image,rarity,crate,wallet,at}]
      decimals: Number(process.env.DROP_DECIMALS || 6),
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}
