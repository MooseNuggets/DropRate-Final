import { sql, migrate } from "../lib/db.js";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    await migrate();
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
}
