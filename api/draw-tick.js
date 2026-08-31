import { sql, migrate, lastTakenSnapshots } from "../lib/db.js";
import { roundAt, fetchRandomness, selectWinners, buildPool, payableWallet } from "../lib/draw.js";
import { loadEligibility } from "../lib/eligibility.js";
import { loadStreaks } from "../lib/streak.js";
import { announceDrawnDraws } from "../lib/announce.js";
const CLAIM_DAYS = 7;

// Build the eligible holder pool with the diamond-hands loyalty bonus applied:
// each clean-hold wallet gets its base tickets PLUS its streak bonus entries.
// (Same eligibility + streak rules as the public checker, so they always agree.)
function eligibleWithBonus(results, streaks) {
  return [...results.entries()]
    .filter(([, r]) => r.eligible && r.tickets >= 1)
    .map(([wallet, r]) => {
      const bonus = (streaks.get(wallet) && streaks.get(wallet).bonus) || 0;
      return { wallet, tickets: r.tickets + bonus };
    });
}

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    await migrate();
    // Exact recorded pool per draw so the public verifier can reproduce winners
    // with loyalty bonuses baked in (no client-side reconstruction guesswork).
    await sql`ALTER TABLE draws ADD COLUMN IF NOT EXISTS pool_json text`;
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
        const { streaks } = await loadStreaks();
        eligible = eligibleWithBonus(results, streaks);
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
      // Canonical ordered pool (identity + final ticket count incl. bonus) — this is
      // exactly what selectWinners ran on, so verify.html can re-run it byte-for-byte.
      const poolJson = JSON.stringify(pool.map((e) => ({ w: e.wallet, t: e.tickets })));
      await sql`
        UPDATE draws SET status = 'drawn', seed = ${seed},
        snapshot_id = ${snap ? snap.id : null}, next_index = ${nextIndex},
        pool_holders = ${eligible.length}, pool_tickets = ${poolTickets},
        pool_free = ${freeQ.rows.length}, pool_json = ${poolJson} WHERE id = ${d.id}`;
      if (!pool.length) log.push({ draw: d.id, note: "no entries — drawn with zero winners" });
      log.push({ draw: d.id, action: "drawn", winners: winners.map((w) => payableWallet(w.wallet)) });
    }
    // 3) EXPIRE: unclaimed past deadline → winner expires, key returns to the
    //    general pool to be used by a FUTURE draw.
    //
    //    Deliberately does NOT redraw a replacement from the same snapshot. That
    //    pool is a week stale by definition — the wallets in it are the ones who
    //    already didn't turn up — so handing the key to the next name on the same
    //    list usually just starts another seven-day wait, and can chain that way
    //    for months. A fresh draw has people who are actually paying attention.
    //
    //    Clearing draw_id is the part that makes the key genuinely reusable. The
    //    assignment queries above only ever consider codes matching the draw being
    //    run or codes with no draw_id at all, so a code released while still pinned
    //    to a finished draw would sit 'available' forever and never be handed out
    //    again. NULL puts it in the open pool that any future draw can reach.
    //
    //    The winners row keeps its draw_id and code_id with status 'expired', so
    //    where the key came from stays auditable.
    const expired = await sql`
      SELECT w.id, w.draw_id, w.code_id, w.wallet
      FROM winners w JOIN draws d ON d.id = w.draw_id
      WHERE w.status = 'assigned' AND w.expires_at < now() AND d.status = 'drawn'`;
    for (const w of expired.rows) {
      await sql`UPDATE winners SET status = 'expired' WHERE id = ${w.id}`;
      if (w.code_id) {
        await sql`UPDATE codes SET status = 'available', draw_id = NULL WHERE id = ${w.code_id}`;
      }
      log.push({
        draw: w.draw_id, action: "expired", wallet: w.wallet,
        key: w.code_id ? "returned to pool" : "none was assigned",
      });
    }
    try {
      const announced = await announceDrawnDraws(sql);
      log.push(...announced);
    } catch (err) { console.error("announce stage:", err); }
    res.status(200).json({ ok: true, log });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
}
