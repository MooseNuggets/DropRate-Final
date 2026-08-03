import { lastTakenSnapshots } from "../lib/db.js";

export default async function handler(req, res) {
  try {
    const rows = await lastTakenSnapshots(50);
    // offset_minutes is intentionally only visible via taken_at (after the fact)
    res.status(200).json({ snapshots: rows });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}
