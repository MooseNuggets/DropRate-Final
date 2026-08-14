import { lastTakenSnapshots } from "../lib/db.js";

// Public snapshot list. Default 50 (unchanged), but callers can request more via
// ?limit= (capped at 2000) so the verify tool can rebuild the eligible pool for
// older draws — the K consecutive snapshots ending at a draw's snapshot.
export default async function handler(req, res) {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 2000);
    const rows = await lastTakenSnapshots(limit);
    // offset_minutes is intentionally only visible via taken_at (after the fact)
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    res.status(200).json({ snapshots: rows });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}
