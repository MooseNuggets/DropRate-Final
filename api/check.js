import { CONFIG } from "../lib/config.js";
import { sql } from "../lib/db.js";
import { lastTakenSnapshots, walletInSnapshots } from "../lib/db.js";
import { loadEligibility } from "../lib/eligibility.js";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export default async function handler(req, res) {
  const wallet = String(req.query.wallet || "").trim();
  if (!BASE58.test(wallet)) {
    return res.status(400).json({ error: "invalid wallet address" });
  }
  try {
    const snaps = await lastTakenSnapshots(CONFIG.K_CONSECUTIVE, CONFIG.ELIGIBILITY_START);
    if (snaps.length === 0) {
      return res.status(200).json({
        wallet, eligible: false, reason: "no-snapshots-yet",
        required: CONFIG.K_CONSECUTIVE, snapshots: [],
      });
    }
    const rows = await walletInSnapshots(wallet, snaps.map((s) => s.id));
    const byId = new Map(rows.map((r) => [r.snapshot_id, r]));

    const detail = snaps.map((s) => {
      const hit = byId.get(s.id);
      return {
        snapshot_id: s.id,
        taken_at: s.taken_at,
        merkle_root: s.merkle_root,
        present: !!hit,
        tickets: hit ? hit.tickets : 0,
        balance: hit ? Number(BigInt(String(hit.balance_raw).split(".")[0]) / 10n ** BigInt(CONFIG.DECIMALS)) : 0,
      };
    });

    const { results } = await loadEligibility();
    const ev = results.get(wallet);
    const enoughSnaps = snaps.length >= CONFIG.K_CONSECUTIVE;
    const eligible = !!(ev && ev.eligible && enoughSnaps);

    let reason = "ok";
    if (!enoughSnaps) reason = "warming-up";
    else if (!ev || !ev.streakOk) reason = "missed-snapshot";
    else if (ev.soldRecently) reason = "sold-recently";

    const feQ = await sql`
      SELECT f.draw_id, d.prize_title, d.scheduled_at
      FROM free_entries f JOIN draws d ON d.id = f.draw_id
      WHERE f.wallet = ${wallet} AND d.status != 'drawn' AND d.scheduled_at > now()
      ORDER BY d.scheduled_at`;

    return res.status(200).json({
      wallet,
      eligible,
      reason,
      required: CONFIG.K_CONSECUTIVE,
      sell_lookback: CONFIG.SELL_LOOKBACK,
      tickets: eligible ? ev.tickets : 0,
      ticket_cap: CONFIG.TICKET_CAP,
      tokens_per_ticket: CONFIG.TOKENS_PER_TICKET,
      snapshots: detail,
      free_entries: feQ.rows,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
