import { sql, migrate } from "../lib/db.js";
import { encryptCode } from "../lib/vault.js";

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.ADMIN_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    await migrate();
    const { action } = req.body ?? {};

    if (action === "create-draw") {
      const { scheduled_at, prize_title, n_winners = 1 } = req.body;
      const r = await sql`
        INSERT INTO draws(scheduled_at, prize_title, n_winners)
        VALUES (${scheduled_at}, ${prize_title}, ${Number(n_winners)})
        RETURNING id, scheduled_at, prize_title, n_winners`;
      return res.status(200).json({ ok: true, draw: r.rows[0] });
    }

    if (action === "add-codes") {
      // codes: array of plaintext keys. draw_id/game_title optional —
      // omitted = global mystery pool, which is the normal mode.
      const { draw_id, game_title, codes } = req.body;
      if (!Array.isArray(codes) || !codes.length) return res.status(400).json({ error: "codes[] required" });
      const cleaned = codes.map((c) => String(c).trim()).filter(Boolean);
      for (const code of cleaned) {
        const enc = encryptCode(code, process.env.CODE_VAULT_KEY);
        await sql`
          INSERT INTO codes(draw_id, game_title, code_encrypted)
          VALUES (${draw_id ? Number(draw_id) : null}, ${game_title ? String(game_title) : null}, ${enc})`;
      }
      return res.status(200).json({ ok: true, added: cleaned.length });
    }

    if (action === "create-draws-bulk") {
      // draws: [{scheduled_at, prize_title?, n_winners?}]
      const { draws } = req.body;
      if (!Array.isArray(draws) || !draws.length) return res.status(400).json({ error: "draws[] required" });
      const created = [];
      for (const d of draws) {
        const r = await sql`
          INSERT INTO draws(scheduled_at, prize_title, n_winners)
          VALUES (${d.scheduled_at}, ${d.prize_title || "Mystery game key"}, ${Number(d.n_winners || 1)})
          RETURNING id, scheduled_at`;
        created.push(r.rows[0]);
      }
      return res.status(200).json({ ok: true, created });
    }

    if (action === "stats") {
      const codes = await sql`
        SELECT status, count(*)::int AS n FROM codes GROUP BY status`;
      const upcoming = await sql`
        SELECT id, scheduled_at, prize_title, n_winners, status, drand_round
        FROM draws WHERE status != 'drawn' ORDER BY scheduled_at ASC LIMIT 60`;
      const recentWinners = await sql`
        SELECT w.draw_id, w.wallet, w.status, w.expires_at, d.prize_title
        FROM winners w JOIN draws d ON d.id = w.draw_id
        ORDER BY w.assigned_at DESC LIMIT 20`;
      const snap = await sql`
        SELECT taken_at, holder_count, total_tickets FROM snapshots
        WHERE status = 'taken' ORDER BY window_start DESC LIMIT 1`;
      const codeMap = Object.fromEntries(codes.rows.map((c) => [c.status, c.n]));
      return res.status(200).json({
        codes: { available: codeMap.available || 0, assigned: codeMap.assigned || 0, claimed: codeMap.claimed || 0 },
        upcoming: upcoming.rows,
        recentWinners: recentWinners.rows,
        latestSnapshot: snap.rows[0] || null,
      });
    }

    if (action === "add-exclusion") {
      const { wallet, label } = req.body;
      await sql`
        INSERT INTO exclusions(wallet, label) VALUES (${wallet}, ${String(label || "")})
        ON CONFLICT (wallet) DO UPDATE SET label = EXCLUDED.label`;
      return res.status(200).json({ ok: true });
    }

    res.status(400).json({ error: "unknown action" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
}
