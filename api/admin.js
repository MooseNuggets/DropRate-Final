import { sql, migrate } from "../lib/db.js";
import { encryptCode, decryptCode } from "../lib/vault.js";
import { migrateGacha, bucketCounts } from "../lib/gacha-db.js";
import { prepareKey, parseBatch } from "../lib/loader.js";

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

    if (action === "keys") {
      const r = await sql`
        SELECT c.id, c.game_title, c.status, c.draw_id,
               w.wallet AS winner_wallet, w.claimed_at, w.expires_at, w.draw_id AS won_in_draw
        FROM codes c
        LEFT JOIN winners w ON w.code_id = c.id AND w.status IN ('assigned','claimed')
        ORDER BY c.id`;
      const rows = r.rows;
      const counts = { available: 0, assigned: 0, claimed: 0, void: 0 };
      rows.forEach((k) => { counts[k.status] = (counts[k.status] || 0) + 1; });
      return res.status(200).json({ keys: rows, counts });
    }

    if (action === "reveal") {
      // Plaintext is ONLY ever decrypted for keys a winner has already claimed.
      // Sealed (available/assigned) keys cannot be revealed — by design, to anyone.
      const id = Number(req.body.id);
      const r = await sql`
        SELECT code_encrypted, status FROM codes WHERE id = ${id}`;
      if (!r.rows.length) return res.status(404).json({ error: "no such key" });
      if (!["claimed", "assigned"].includes(r.rows[0].status)) {
        return res.status(403).json({ error: "sealed — pool keys can't be revealed until won" });
      }
      return res.status(200).json({ id, code: decryptCode(r.rows[0].code_encrypted, process.env.CODE_VAULT_KEY) });
    }

    if (action === "audit-dupes") {
      // Decrypts server-side ONLY to compare — plaintext never leaves the server.
      const r = await sql`
        SELECT id, status, draw_id FROM codes WHERE status != 'void' ORDER BY id`;
      const enc = await sql`
        SELECT id, code_encrypted FROM codes WHERE status != 'void'`;
      const plain = new Map(enc.rows.map((c) => {
        try { return [c.id, decryptCode(c.code_encrypted, process.env.CODE_VAULT_KEY)]; }
        catch { return [c.id, "__DECRYPT_FAIL_" + c.id]; }
      }));
      const groups = new Map();
      for (const row of r.rows) {
        const p = plain.get(row.id);
        if (!groups.has(p)) groups.set(p, []);
        groups.get(p).push({ id: row.id, status: row.status, draw_id: row.draw_id });
      }
      const dupes = [...groups.values()].filter((g) => g.length > 1);
      return res.status(200).json({ dupe_groups: dupes, checked: r.rows.length });
    }

    if (action === "void-key") {
      const id = Number(req.body.id);
      const r = await sql`SELECT status FROM codes WHERE id = ${id}`;
      if (!r.rows.length) return res.status(404).json({ error: "no such key" });
      if (r.rows[0].status !== "available") {
        return res.status(400).json({ error: "only pool (available) keys can be voided — use swap for assigned keys" });
      }
      await sql`UPDATE codes SET status = 'void' WHERE id = ${id}`;
      return res.status(200).json({ ok: true, voided: id });
    }

    if (action === "swap-key") {
      // Replace an ASSIGNED key with a fresh one — winner, draw, and timing untouched.
      const codeId = Number(req.body.code_id);
      const cur = await sql`SELECT id, status, draw_id FROM codes WHERE id = ${codeId}`;
      if (!cur.rows.length) return res.status(404).json({ error: "no such key" });
      if (cur.rows[0].status !== "assigned") {
        return res.status(400).json({ error: "only assigned (awaiting-claim) keys can be swapped" });
      }
      const win = await sql`
        SELECT id, draw_id FROM winners WHERE code_id = ${codeId} AND status = 'assigned'`;
      if (!win.rows.length) return res.status(409).json({ error: "no active winner holds this key" });
      const repl = await sql`
        SELECT id FROM codes WHERE status = 'available'
          AND (draw_id = ${win.rows[0].draw_id} OR draw_id IS NULL)
        ORDER BY draw_id ASC NULLS LAST, id ASC LIMIT 1`;
      if (!repl.rows.length) return res.status(409).json({ error: "no replacement key in pool — load one first" });
      const newId = repl.rows[0].id;
      await sql`UPDATE codes SET status = 'void' WHERE id = ${codeId}`;
      await sql`UPDATE codes SET status = 'assigned' WHERE id = ${newId}`;
      await sql`UPDATE winners SET code_id = ${newId} WHERE id = ${win.rows[0].id}`;
      return res.status(200).json({ ok: true, voided: codeId, assigned: newId, winner_id: win.rows[0].id });
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
