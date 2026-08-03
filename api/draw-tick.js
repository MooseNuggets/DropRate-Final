import { CONFIG } from "../lib/config.js";
import { sql, migrate, lastTakenSnapshots } from "../lib/db.js";
import { roundAt, fetchRandomness, selectWinners, buildPool, payableWallet } from "../lib/draw.js";

const CLAIM_DAYS = 7;

export default async function handler(req, res) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    await migrate();
    const log = [];

    // 1) COMMIT: any scheduled draw gets its future drand round pinned immediately.
    //    The commitment (round number) is public before the randomness exists.
    const toCommit = await sql`SELECT * FROM draws WHERE status = 'scheduled'`;
    for (const d of toCommit.rows) {
      const round = roundAt(Math.floor(new Date(d.scheduled_at).getTime() / 1000));
      await sql`UPDATE draws SET drand_round = ${round}, status = 'committed' WHERE id = ${d.id}`;
      log.push({ draw: d.id, action: "committed", round });
    }

    // 2) RUN: committed draws whose time has passed
    const due = await sql`
      SELECT * FROM draws WHERE status = 'committed' AND scheduled_at <= now()`;
    for (const d of due.rows) {
      // Holder
