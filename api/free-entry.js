import { sql, migrate } from "../lib/db.js";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// MERGED endpoint (frees a Vercel Hobby function slot):
//   GET  /api/free-entry?draw_id=N   -> public free-entry list for a draw
//   POST /api/free-entry             -> create one free entry
// A vercel.json rewrite keeps the old /api/free-entries URL working (-> GET here).
export default async function handler(req, res) {
  try {
    await migrate();

    // ---- GET: public free-entry list (was /api/free-entries) ----
    if (req.method === "GET") {
      const id = Number(req.query.draw_id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: "draw_id required" });
      const r = await sql`
        SELECT id, wallet FROM free_entries WHERE draw_id = ${id} ORDER BY id`;
      return res.status(200).json({ draw_id: id, free: r.rows });
    }

    // ---- POST: create a free entry ----
    if (req.method === "POST") {
      const { wallet, handle, draw_id, ts_token, website } = req.body ?? {};

      // honeypot: real users never fill the hidden "website" field
      if (website) return res.status(200).json({ ok: true }); // silently drop bots

      if (!BASE58.test(String(wallet || ""))) {
        return res.status(400).json({ error: "invalid wallet address" });
      }
      const drawId = Number(draw_id);
      if (!Number.isInteger(drawId)) return res.status(400).json({ error: "invalid draw" });

      // Cloudflare Turnstile if configured
      if (process.env.TURNSTILE_SECRET) {
        const v = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `secret=${encodeURIComponent(process.env.TURNSTILE_SECRET)}&response=${encodeURIComponent(ts_token || "")}`,
        }).then((r) => r.json());
        if (!v.success) return res.status(400).json({ error: "captcha failed" });
      }

      const draw = await sql`
        SELECT id, status, scheduled_at FROM draws WHERE id = ${drawId}`;
      if (!draw.rows.length) return res.status(404).json({ error: "draw not found" });
      if (draw.rows[0].status === "drawn") {
        return res.status(400).json({ error: "this draw already ran" });
      }

      await sql`
        INSERT INTO free_entries(draw_id, wallet, handle)
        VALUES (${drawId}, ${wallet}, ${String(handle || "").slice(0, 64)})
        ON CONFLICT (draw_id, wallet) DO NOTHING`;

      return res.status(200).json({ ok: true, note: "one free entry per wallet per draw" });
    }

    return res.status(405).json({ error: "GET or POST only" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
