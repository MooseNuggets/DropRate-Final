import { sql, migrate } from "../lib/db.js";

// Public free-entry list for a draw (id + wallet only — handles stay private).
export default async function handler(req, res) {
  try {
    await migrate();
    const id = Number(req.query.draw_id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "draw_id required" });
    const r = await sql`
      SELECT id, wallet FROM free_entries WHERE draw_id = ${id} ORDER BY id`;
    res.status(200).json({ draw_id: id, free: r.rows });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}
