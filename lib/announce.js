// Winner announcements — Telegram first, X later.
// Runs as a stage inside draw-tick: finds drawn-but-unannounced draws,
// posts, marks announced. Failures leave announced_at NULL → auto-retry
// on the next tick. Announcing can never break a draw.

const SITE = "https://droprate.xyz";

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildWinnerMessage(draw, winnerWallets, nextDraw) {
  const prize = escHtml(draw.prize_title || "Mystery game key");
  const winners = winnerWallets.length
    ? winnerWallets.map((w) => `<code>${escHtml(w)}</code>`).join("\n")
    : "— no entries this round —";
  const pool = draw.pool_tickets != null
    ? `\n🎫 Pool: ${draw.pool_holders || 0} holders · ${draw.pool_tickets} tickets · ${draw.pool_free || 0} free entries`
    : "";
  const next = nextDraw
    ? `\n\n⏰ Next drop: ${escHtml(nextDraw.prize_title || "Mystery key")} — ${new Date(nextDraw.scheduled_at).toUTCString().replace(":00 GMT", " UTC")}`
    : "";
  return `🎁 <b>DROP COMPLETE — ${prize}</b>\n\n🏆 Winner:\n${winners}${pool}\n\n🔑 Claim your key: ${SITE}/claim.html\n🔍 Proof &amp; receipts: ${SITE}/draws.html${next}\n\n<i>Provably random. Verify it yourself.</i>`;
}

export async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return { skipped: "telegram not configured" };
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true }),
    signal: AbortSignal.timeout(8000),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`telegram: ${j.description || res.status}`);
  return { ok: true };
}

export async function announceDrawnDraws(sql) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return [];
  const log = [];
  const pending = await sql`
    SELECT * FROM draws WHERE status = 'drawn' AND announced_at IS NULL
    ORDER BY scheduled_at ASC LIMIT 5`;
  for (const d of pending.rows) {
    try {
      const winQ = await sql`
        SELECT wallet FROM winners WHERE draw_id = ${d.id} AND status IN ('assigned','claimed')
        ORDER BY sel_index ASC`;
      const nextQ = await sql`
        SELECT prize_title, scheduled_at FROM draws
        WHERE status != 'drawn' AND scheduled_at > now()
        ORDER BY scheduled_at ASC LIMIT 1`;
      const msg = buildWinnerMessage(d, winQ.rows.map((w) => w.wallet), nextQ.rows[0] || null);
      await sendTelegram(msg);
      await sql`UPDATE draws SET announced_at = now() WHERE id = ${d.id}`;
      log.push({ draw: d.id, action: "announced" });
    } catch (err) {
      console.error("announce:", d.id, err.message);
      log.push({ draw: d.id, action: "announce-failed", why: String(err.message) });
    }
  }
  return log;
}
