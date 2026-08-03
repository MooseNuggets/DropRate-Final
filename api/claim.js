import { randomBytes } from "node:crypto";
import { sql, migrate } from "../lib/db.js";
import { verifyWalletSignature, claimMessage, decryptCode } from "../lib/vault.js";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export default async function handler(req, res) {
  try {
    await migrate();

    // ---- GET /api/claim?wallet=..&draw_id=..  → issue nonce + message to sign ----
    if (req.method === "GET") {
      const wallet = String(req.query.wallet || "");
      const drawId = Number(req.query.draw_id);
      if (!BASE58.test(wallet) || !Number.isInteger(drawId)) {
        return res.status(400).json({ error: "invalid params" });
      }
      const win = await sql`
        SELECT id FROM winners
        WHERE draw_id = ${drawId} AND wallet = ${wallet} AND status = 'assigned'`;
      if (!win.rows.length) {
        return res.status(404).json({ error: "no unclaimed win for this wallet in this draw" });
      }
      const nonce = randomBytes(16).toString("hex");
      const expires = new Date(Date.now() + 10 * 60_000).toISOString();
      await sql`
        INSERT INTO claim_nonces(nonce, wallet, draw_id, expires_at)
        VALUES (${nonce}, ${wallet}, ${drawId}, ${expires})`;
      return res.status(200).json({ nonce, message: claimMessage(drawId, wallet, nonce) });
    }

    // ---- POST { wallet, draw_id, nonce, signature } → verify + return code once ----
    if (req.method === "POST") {
      const { wallet, draw_id, nonce, signature } = req.body ?? {};
      const drawId = Number(draw_id);
      if (!BASE58.test(String(wallet || "")) || !Number.isInteger(drawId) || !nonce || !signature) {
        return res.status(400).json({ error: "invalid params" });
      }
      const n = await sql`
        SELECT * FROM claim_nonces
        WHERE nonce = ${nonce} AND wallet = ${wallet} AND draw_id = ${drawId}
          AND used = false AND expires_at > now()`;
      if (!n.rows.length) return res.status(400).json({ error: "nonce invalid or expired — request a new one" });

      const msg = claimMessage(drawId, wallet, nonce);
      let ok = false;
      try { ok = verifyWalletSignature(msg, String(signature), wallet); } catch { ok = false; }
      if (!ok) return res.status(401).json({ error: "signature verification failed" });

      await sql`UPDATE claim_nonces SET used = true WHERE nonce = ${nonce}`;

      const win = await sql`
        SELECT w.id, w.code_id, c.game_title, c.code_encrypted
        FROM winners w LEFT JOIN codes c ON c.id = w.code_id
        WHERE w.draw_id = ${drawId} AND w.wallet = ${wallet} AND w.status = 'assigned'`;
      if (!win.rows.length) return res.status(404).json({ error: "no unclaimed win" });
      const w = win.rows[0];
      if (!w.code_id) return res.status(409).json({ error: "code not yet stocked for this draw — contact the team" });

      const code = decryptCode(w.code_encrypted, process.env.CODE_VAULT_KEY);
      await sql`UPDATE winners SET status = 'claimed', claimed_at = now() WHERE id = ${w.id}`;
      await sql`UPDATE codes SET status = 'claimed' WHERE id = ${w.code_id}`;

      return res.status(200).json({ game_title: w.game_title || "Mystery game key", code });
    }

    res.status(405).json({ error: "GET or POST" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
}
