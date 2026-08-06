import { CONFIG } from "../lib/config.js";
import {
  windowStart, randomOffsetMinutes, isDue,
  fetchAllTokenAccounts, buildEntries, summarize,
} from "../lib/snapshot.js";
import { sql, migrate, getOrCreateWindow, saveSnapshot, getExclusions } from "../lib/db.js";

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!CONFIG.MINT) return res.status(200).json({ ok: true, note: "DROP_MINT not set yet — idle" });

  try {
    await migrate();
    const now = new Date();
    const win = windowStart(now);
    await getOrCreateWindow(win, randomOffsetMinutes); // ensure current window exists

    // Take EVERY pending snapshot whose secret minute has passed — including
    // windows from previous hours whose offset landed after the last tick.
    const duePending = await sql`
      SELECT * FROM snapshots WHERE status = 'pending'
      AND window_start + (offset_minutes * interval '1 minute') <= now()
      ORDER BY window_start ASC`;

    if (!duePending.rows.length) {
      return res.status(200).json({ ok: true, window: win, status: "not-yet" });
    }

    const results = [];
    for (const row of duePending.rows) {
      const accounts = await fetchAllTokenAccounts(CONFIG.MINT, process.env.HELIUS_API_KEY);
      const exclusions = await getExclusions();
      const entries = buildEntries(accounts, exclusions);
      const summary = summarize(entries);
      await saveSnapshot(row.id, entries, summary);
      results.push({ window: row.window_start, status: "taken", ...summary });
    }

    return res.status(200).json({ ok: true, taken: results });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
