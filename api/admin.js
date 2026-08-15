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
      const st = r.rows[0].status;
      if (st === "available") {
        await sql`UPDATE codes SET status = 'void' WHERE id = ${id}`;
        return res.status(200).json({ ok: true, voided: id });
      }
      if (st === "assigned") {
        // Allow voiding an ORPHANED assigned key — one whose winner was voided/
        // removed, so nothing holds it. Block if a live winner still holds it
        // (use swap for that case, so the winner keeps a valid key).
        const held = await sql`
          SELECT id FROM winners WHERE code_id = ${id} AND status IN ('assigned','claimed')`;
        if (held.rows.length) return res.status(400).json({ error: "a live winner holds this key — use swap, not void" });
        await sql`UPDATE codes SET status = 'void' WHERE id = ${id}`;
        return res.status(200).json({ ok: true, voided: id });
      }
      return res.status(400).json({ error: "only pool (available) or orphaned assigned keys can be voided" });
    }
    if (action === "restore-key") {
      // Un-void a key back into the pool (void -> available) — undo for an
      // accidental void. Only works on keys currently 'void'.
      const id = Number(req.body.id);
      const r = await sql`UPDATE codes SET status = 'available' WHERE id = ${id} AND status = 'void' RETURNING id`;
      if (!r.rows.length) return res.status(400).json({ error: "key not found or not void" });
      return res.status(200).json({ ok: true, restored: id });
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
    if (action === "void-winner") {
      // Terminally void a WINNER without recycling its key or triggering a redraw.
      // For when a prize was already re-issued out of band (e.g. a dead wallet won a
      // draw and you re-ran it with the same key) and you do NOT want that key to
      // fall back into the pool. Identify by winner_id OR (draw_id + wallet).
      //
      // - winner status -> 'void' (the expire/redraw cron only touches 'assigned'
      //   winners past expiry, so a voided winner is never redrawn)
      // - the code is detached from the winner
      // - the key is only marked 'void' if it's still sitting 'available'; a key you
      //   already re-issued ('assigned'/'claimed') is left completely untouched.
      // Only 'assigned' or 'expired' winners can be voided — never a real 'claimed'.
      const { winner_id, draw_id, wallet } = req.body;
      let rows;
      if (winner_id != null) {
        rows = (await sql`
          SELECT id, code_id FROM winners
          WHERE id = ${Number(winner_id)} AND status IN ('assigned','expired')`).rows;
      } else if (draw_id != null && wallet) {
        rows = (await sql`
          SELECT id, code_id FROM winners
          WHERE draw_id = ${Number(draw_id)} AND wallet = ${String(wallet)}
            AND status IN ('assigned','expired')`).rows;
      } else {
        return res.status(400).json({ error: "provide winner_id OR (draw_id + wallet)" });
      }
      if (!rows.length) return res.status(404).json({ error: "no voidable winner found (already claimed/void, or wrong id)" });
      let voided = 0, keysBlocked = 0;
      for (const w of rows) {
        await sql`UPDATE winners SET status = 'void', code_id = NULL WHERE id = ${w.id}`;
        voided++;
        if (w.code_id) {
          const c = await sql`UPDATE codes SET status = 'void' WHERE id = ${w.code_id} AND status = 'available' RETURNING id`;
          if (c.rows.length) keysBlocked++;
        }
      }
      return res.status(200).json({ ok: true, voided, keys_blocked_from_pool: keysBlocked });
    }
    if (action === "stats") {
      const codes = await sql`
        SELECT status, count(*)::int AS n FROM codes GROUP BY status`;
      const upcoming = await sql`
        SELECT id, scheduled_at, prize_title, n_winners, status, drand_round
        FROM draws WHERE status != 'drawn' ORDER BY scheduled_at ASC LIMIT 60`;
      const recentWinners = await sql`
        SELECT w.id, w.draw_id, w.wallet, w.status, w.expires_at, d.prize_title
        FROM winners w JOIN draws d ON d.id = w.draw_id
        ORDER BY w.assigned_at DESC LIMIT 20`;
      const snap = await sql`
        SELECT taken_at, holder_count, total_tickets FROM snapshots
        WHERE status = 'taken' ORDER BY window_start DESC LIMIT 1`;
      const codeMap = Object.fromEntries(codes.rows.map((c) => [c.status, c.n]));
      return res.status(200).json({
        codes: { available: codeMap.available || 0, assigned: codeMap.assigned || 0, claimed: codeMap.claimed || 0, void: codeMap.void || 0 },
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
    // ---- GACHA: load keys into the crate pool ----------------------------
    if (action === "gacha-load-keys") {
      await migrateGacha();
      // Accept a pasted batch (text) and/or a structured keys[] array.
      let rows = [];
      if (typeof req.body.text === "string" && req.body.text.trim()) {
        rows = parseBatch(req.body.text).map((r) => ({
          code: r.code, gameName: r.gameName, appInput: r.gameName,
          costCents: r.costCents, error: r.error,
        }));
      }
      if (Array.isArray(req.body.keys)) {
        rows = rows.concat(req.body.keys.map((k) => ({
          code: k.code,
          appInput: k.appInput ?? k.game ?? null,
          gameName: k.gameName ?? k.game ?? null,
          msrpCents: k.msrpCents,
          costCents: k.costCents ?? k.cost,
          tierOverride: k.tierOverride ?? k.tier,
        })));
      }
      const defaultTier = req.body.tierOverride || req.body.defaultTier || null;
      const added = { common: 0, rare: 0, epic: 0, legendary: 0 };
      const failures = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row.error) { failures.push({ i, code: row.code, error: row.error }); continue; }
        try {
          const rec = await prepareKey({
            code: row.code, appInput: row.appInput, gameName: row.gameName,
            msrpCents: row.msrpCents, costCents: row.costCents,
            tierOverride: row.tierOverride || defaultTier,
          }, { vaultKey: process.env.CODE_VAULT_KEY });
          await sql`
            INSERT INTO crate_keys(rarity, game_title, appid, image, msrp_cents, cost_cents, code_encrypted, status)
            VALUES (${rec.rarity}, ${rec.game_title}, ${rec.appid}, ${rec.image},
                    ${rec.msrp_cents}, ${rec.cost_cents}, ${rec.code_encrypted}, 'available')`;
          added[rec.rarity] = (added[rec.rarity] || 0) + 1;
        } catch (e) {
          failures.push({ i, code: row.code, error: String(e.message || e) });
        }
      }
      const stock = await bucketCounts();
      return res.status(200).json({ ok: true, added, failures, stock });
    }
    // ---- GACHA: current stock per rarity --------------------------------
    if (action === "gacha-stock") {
      await migrateGacha();
      return res.status(200).json({ ok: true, stock: await bucketCounts() });
    }
    // ---- GACHA: void a bad pool key -------------------------------------
    if (action === "gacha-void-key") {
      await migrateGacha();
      const id = Number(req.body.id);
      const r = await sql`UPDATE crate_keys SET status = 'void' WHERE id = ${id} AND status = 'available' RETURNING id`;
      if (!r.rows.length) return res.status(400).json({ error: "key not found or not available" });
      return res.status(200).json({ ok: true, voided: id });
    }
    // ---- GACHA: wipe ALL gacha data (keys + pulls + history) -------------
    if (action === "gacha-reset") {
      await migrateGacha();
      if (req.body.confirm !== "WIPE") return res.status(400).json({ error: "pass confirm:'WIPE' to reset" });
      await sql`DELETE FROM settlements`;
      await sql`DELETE FROM pulls`;
      await sql`DELETE FROM pity`;
      await sql`DELETE FROM crate_keys`;
      return res.status(200).json({ ok: true, wiped: true });
    }
    res.status(400).json({ error: "unknown action" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
}
