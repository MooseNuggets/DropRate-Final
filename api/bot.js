import { sql, migrate } from "../lib/db.js";
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
          SELECT scheduled_at, prize_title FROM draws
          WHERE status <> 'drawn' AND scheduled_at > now()
          ORDER BY scheduled_at ASC LIMIT 1`;
        const hq = await sql`
          SELECT holder_count FROM snapshots WHERE status = 'taken'
          ORDER BY window_start DESC LIMIT 1`;
        reply = formatNextDrop(dq.rows[0] || null, {
          holders: hq.rows[0]?.holder_count ?? undefined,
        });
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
