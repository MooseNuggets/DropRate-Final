import { sql, migrate } from "../lib/db.js";

// Public per-snapshot entry list — required for third-party draw verification.
export default async function handler(req, res) {
  try {
    await migrate();
    const id = Number(req.query.snapshot_id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "snapshot_id required" });
    const r = await sql`
      SELECT wallet, tickets FROM snapshot_entries
      WHERE snapshot_id = ${id} ORDER BY wallet`;
    res.status(200).json({ snapshot_id: id, entries: r.rows });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}
