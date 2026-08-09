import { sql, migrate } from "../lib/db.js";
import { loadEligibility } from "../lib/eligibility.js";
import { parseCommand, formatNextDrop, helpMessage, sendTo } from "../lib/bot.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers["x-telegram-bot-api-secret-token"] !== secret) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const update = req.body ?? {};
  const msg = update.message || update.edited_message;
  const text = msg?.text;
  const chatId = msg?.chat?.id;
  if (!chatId || !text) return res.status(200).json({ ok: true });

  const botUsername = process.env.TELEGRAM_BOT_USERNAME || "";
  const { cmd } = parseCommand(text, botUsername);

  try {
    let reply = null;
    switch (cmd) {
      case "nextdrop": {
        await migrate();
        const dq = await sql`
          SELECT id, scheduled_at, prize_title FROM draws
          WHERE status <> 'drawn' AND scheduled_at > now()
          ORDER BY scheduled_at ASC LIMIT 1`;
        const next = dq.rows[0] || null;

        let holderTickets = 0;
        let freeTickets = 0;
        if (next) {
          try {
            const { results } = await loadEligibility();
            for (const [, r] of results) {
              if (r.eligible && r.tickets >= 1) holderTickets += r.tickets;
            }
          } catch (e) {
            console.error("nextdrop eligibility:", e);
          }
          const fq = await sql`
            SELECT count(*)::int AS n FROM free_entries WHERE draw_id = ${next.id}`;
          freeTickets = fq.rows[0]?.n ?? 0;
        }

        reply = formatNextDrop(next, { holderTickets, freeTickets });
        break;
      }
      case "start":
      case "help":
        reply = helpMessage();
        break;
      default:
        if (cmd && msg.chat?.type === "private") reply = helpMessage();
    }
    if (reply) await sendTo(chatId, reply);
  } catch (err) {
    console.error("bot:", err);
    try { await sendTo(chatId, "⚠️ Something hiccuped on our end — try again in a moment."); }
    catch (_) {}
  }
  return res.status(200).json({ ok: true });
}
