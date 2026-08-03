import { CONFIG } from "../lib/config.js";
import { sql, migrate, lastTakenSnapshots } from "../lib/db.js";
import { roundAt, fetchRandomness, selectWinners, buildPool, payableWallet } from "../lib/draw.js";

const CLAIM_DAYS = 7;

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    await migrate();
    const log = [];

    // 1) COMMIT: any scheduled draw gets its future drand round pinned immediately.
    const toCommit = await sql`SELECT * FROM draws WHERE status = 'scheduled'`;
    for (const d of toCommit.rows) {
      const round = roundAt(Math.floor(new Date(d.scheduled_at).getTime() / 1000));
      await sql`UPDATE draws SET drand_round = ${round}, status = 'committed' WHERE id = ${d.id}`;
      log.push({ draw: d.id, action: "committed", round });
    }

    // 2) RUN: committed draws whose time has passed
    const due = await sql`
      SELECT * FROM draws WHERE status = 'committed' AND scheduled_at <= now()`;
    for (const d of due.rows) {
      // With no snapshots yet (pre-token), the draw runs on free entries alone.
      const snaps = await lastTakenSnapshots(1);
      const snap = snaps[0] ?? null;

      const seed = await fetchRandomness(Number(d.drand_round));

      let eligible = [];
      if (snap) {
        const entriesQ = await sql`
          SELECT wallet, tickets FROM snapshot_entries WHERE snapshot_id = ${snap.id}`;
        eligible = await filterEligible(entriesQ.rows, snap.id);
      }
      const freeQ = await sql`
        SELECT id, wallet FROM free_entries WHERE draw_id = ${d.id}`;
      const pool = buildPool(eligible, freeQ.rows);

      const { winners, nextIndex } = selectWinners(seed, d.id, pool, d.n_winners);
      const expires = new Date(Date.now() + CLAIM_DAYS * 86400_000).toISOString();

      for (const w of winners) {
        const code = await sql`
          SELECT id FROM codes WHERE status = 'available'
            AND (draw_id = ${d.id} OR draw_id IS NULL)
          ORDER BY draw_id ASC NULLS LAST, id ASC LIMIT 1`;
        const codeId = code.rows[0]?.id ?? null;
        if (codeId) await sql`UPDATE codes SET status = 'assigned' WHERE id = ${codeId}`;
        await sql`
          INSERT INTO winners(draw_id, pool_identity, wallet, sel_index, code_id, expires_at)
          VALUES (${d.id}, ${w.wallet}, ${payableWallet(w.wallet)}, ${w.index}, ${codeId}, ${expires})`;
      }
      await sql`
        UPDATE draws SET status = 'drawn', seed = ${seed},
        snapshot_id = ${snap ? snap.id : null}, next_index = ${nextIndex} WHERE id = ${d.id}`;
      if (!pool.length) log.push({ draw: d.id, note: "no entries — drawn with zero winners" });
      log.push({ draw: d.id, action: "drawn", winners: winners.map((w) => payableWallet(w.wallet)) });
    }

    // 3) EXPIRE + REDRAW: unclaimed past deadline
    const expired = await sql`
      SELECT w.*, d.seed, d.n_winners, d.next_index, d.snapshot_id
      FROM winners w JOIN draws d ON d.id = w.draw_id
      WHERE w.status = 'assigned' AND w.expires_at < now() AND d.status = 'drawn'`;
    for (const w of expired.rows) {
      await sql`UPDATE winners SET status = 'expired' WHERE id = ${w.id}`;
      if (w.code_id) await sql`UPDATE codes SET status = 'available' WHERE id = ${w.code_id}`;

      let eligible = [];
      if (w.snapshot_id) {
        const entriesQ = await sql`
          SELECT wallet, tickets FROM snapshot_entries WHERE snapshot_id = ${w.snapshot_id}`;
        eligible = await filterEligible(entriesQ.rows, w.snapshot_id);
      }
      const freeQ = await sql`SELECT id, wallet FROM free_entries WHERE draw_id = ${w.draw_id}`;
      const pool = buildPool(eligible, freeQ.rows);

      const prev = await sql`
        SELECT pool_identity FROM winners WHERE draw_id = ${w.draw_id}`;
      const exclude = new Set(prev.rows.map((r) => r.pool_identity));

      const { winners: repl, nextIndex } =
        selectWinners(w.seed, w.draw_id, pool, 1, exclude, w.next_index);
      if (repl.length) {
        const r = repl[0];
        const code = await sql`
          SELECT id FROM codes WHERE status = 'available'
            AND (draw_id = ${w.draw_id} OR draw_id IS NULL)
          ORDER BY draw_id ASC NULLS LAST, id ASC LIMIT 1`;
        const codeId = code.rows[0]?.id ?? null;
        if (codeId) await sql`UPDATE codes SET status = 'assigned' WHERE id = ${codeId}`;
        await sql`
          INSERT INTO winners(draw_id, pool_identity, wallet, sel_index, code_id, expires_at)
          VALUES (${w.draw_id}, ${r.wallet}, ${payableWallet(r.wallet)}, ${r.index}, ${codeId},
                  ${new Date(Date.now() + CLAIM_DAYS * 86400_000).toISOString()})`;
        await sql`UPDATE draws SET next_index = ${nextIndex} WHERE id = ${w.draw_id}`;
        log.push({ draw: w.draw_id, action: "redrawn", winner: payableWallet(r.wallet) });
      }
    }

    res.status(200).json({ ok: true, log });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
}

// Eligibility: wallet must appear in the last K consecutive snapshots.
async function filterEligible(entries, latestSnapshotId) {
  const snaps = await lastTakenSnapshots(CONFIG.K_CONSECUTIVE);
  if (snaps.length < CONFIG.K_CONSECUTIVE) return [];
  const ids = snaps.map((s) => s.id);
  const r = await sql.query(
    `SELECT wallet FROM snapshot_entries WHERE snapshot_id = ANY($1::int[])
     GROUP BY wallet HAVING count(*) = $2`,
    [ids, ids.length]
  );
  const ok = new Set(r.rows.map((x) => x.wallet));
  return entries.filter((e) => ok.has(e.wallet));
}
