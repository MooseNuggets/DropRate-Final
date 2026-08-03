import { CONFIG } from "../lib/config.js";
import {
  windowStart, randomOffsetMinutes, isDue,
  fetchAllTokenAccounts, buildEntries, summarize,
} from "../lib/snapshot.js";
import { migrate, getOrCreateWindow, saveSnapshot, getExclusions } from "../lib/db.js";

export default async function handler(req, res) {
  // secured: GitHub Actions sends Authorization: Bearer <CRON_SECRET>
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!CONFIG.MINT) return res.status(200).json({ ok: true, note: "DROP_MINT not set yet — idle" });

  try {
    await migrate();
    const now = new Date();
    const win = windowStart(now);
    const row = await getOrCreateWindow(win, randomOffsetMinutes);

    if (row.status === "taken") {
      return res.status(200).json({ ok: true, window: win, status: "already-taken" });
    }
    if (!isDue(now, win, row.offset_minutes)) {
      // due time is intentionally NOT included in the response
      return res.status(200).json({ ok: true, window: win, status: "not-yet" });
    }

    const accounts = await fetchAllTokenAccounts(CONFIG.MINT, process.env.HELIUS_API_KEY);
    const exclusions = await getExclusions();
    const entries = buildEntries(accounts, exclusions);
    const summary = summarize(entries);
    await saveSnapshot(row.id, entries, summary);

    return res.status(200).json({ ok: true, window: win, status: "taken", ...summary });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
