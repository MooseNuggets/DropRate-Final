import { sql, migrate, lastTakenSnapshots } from "../lib/db.js";
import { roundAt, fetchRandomness, selectWinners, buildPool, payableWallet } from "../lib/draw.js";
import { loadEligibility } from "../lib/eligibility.js";

const CLAIM_DAYS = 7;

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    await migrate();
    const log = [];

    // 1) COMMIT: any scheduled draw gets its future drand round pinned immediately.
    //    The commitment (round number) is public before the randomness exists.
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
      // Holder entries come from the latest snapshot; with no snapshots yet
      // (pre-token, or pre-warmup) the draw still runs on free entries alone.
      const snaps = await lastTakenSnapshots(1);
      const snap = snaps[0] ?? null;

      const seed = await fetchRandomness(Number(d.drand_round));

      let eligible = [];
      if (snap) {
        const { results } = await loadEligibility();
        eligible = [...results.entries()]
          .filter(([, r]) => r.eligible && r.tickets >= 1)
          .map(([wallet, r]) => ({ wallet, tickets: r.tickets }));
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
      const poolTickets = pool.reduce((s, e) => s + e.tickets, 0);
      await sql`
        UPDATE draws SET status = 'drawn', seed = ${seed},
        snapshot_id = ${snap ? snap.id : null}, next_index = ${nextIndex},
        pool_holders = ${eligible.length}, pool_tickets = ${poolTickets},
        pool_free = ${freeQ.rows.length} WHERE id = ${d.id}`;
      if (!pool.length) log.push({ draw: d.id, note: "no entries — drawn with zero winners" });
      log.push({ draw: d.id, action: "drawn", winners: winners.map((w) => payableWallet(w.wallet)) });
    }

    // 3) EXPIRE + REDRAW: unclaimed past deadline → code back to pool, next deterministic winner
    const expired = await sql`
      SELECT w.*, d.seed, d.n_winners, d.next_index, d.snapshot_id
      FROM winners w JOIN draws d ON d.id = w.draw_id
      WHERE w.status = 'assigned' AND w.expires_at < now() AND d.status = 'drawn'`;
    for (const w of expired.rows) {
      await sql`UPDATE winners SET status = 'expired' WHERE id = ${w.id}`;
      if (w.code_id) await sql`UPDATE codes SET status = 'available' WHERE id = ${w.code_id}`;

      let eligible = [];
      if (w.snapshot_id) {
        const { results } = await loadEligibility();
        eligible = [...results.entries()]
          .filter(([, r]) => r.eligible && r.tickets >= 1)
          .map(([wallet, r]) => ({ wallet, tickets: r.tickets }));
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
