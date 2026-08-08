// Interactive Telegram bot for DropRate.
const TG_API = "https://api.telegram.org";
const SITE = (process.env.SITE_URL || "https://droprate.xyz").replace(/\/$/, "");

export async function sendTo(chatId, text, extra = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { skipped: "no bot token" };
  const res = await fetch(`${TG_API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId, text, parse_mode: "HTML",
      disable_web_page_preview: true, ...extra,
    }),
    signal: AbortSignal.timeout(8000),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(`telegram send: ${j.description || res.status}`);
  return { ok: true };
}

export function parseCommand(text, botUsername = "") {
  if (typeof text !== "string") return { cmd: null, args: [] };
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return { cmd: null, args: [] };
  const parts = trimmed.slice(1).split(/\s+/);
  let head = parts[0].toLowerCase();
  const at = head.indexOf("@");
  if (at !== -1) {
    const mention = head.slice(at + 1);
    head = head.slice(0, at);
    if (botUsername && mention && mention !== botUsername.toLowerCase()) {
      return { cmd: null, args: [] };
    }
  }
  if (!head) return { cmd: null, args: [] };
  return { cmd: head, args: parts.slice(1) };
}

export function formatDuration(ms) {
  if (ms <= 0) return "now";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m || (!d && !h)) parts.push(`${m}m`);
  return parts.join(" ");
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatNextDrop(draw, stock = {}, now = Date.now()) {
  if (!draw) {
    return [
      "🎲 <b>No drop scheduled right now.</b>", "",
      `Watch the channel or check ${SITE}/draws.html — new drops post the moment they're set.`,
    ].join("\n");
  }
  const when = new Date(draw.scheduled_at);
  const until = when.getTime() - now;
  const prize = draw.prize_title && String(draw.prize_title).trim()
    ? esc(draw.prize_title) : "Mystery game key";
  const whenStr = when.toUTCString().replace(":00 GMT", " UTC");
  const lines = [
    "🎁 <b>Next drop</b>", "",
    `🏷️ Prize: <b>${prize}</b>`,
    `⏰ ${whenStr}`,
    `⌛ in <b>${formatDuration(until)}</b>`,
  ];
  if (typeof stock.holders === "number") {
    lines.push(`👥 ${stock.holders} eligible holders in the pool`);
  }
  lines.push("", `🔍 Odds &amp; past draws: ${SITE}/draws.html`);
  lines.push("<i>Holders are entered automatically — no action needed.</i>");
  return lines.join("\n");
}

export function helpMessage() {
  return [
    "🤖 <b>DropRate bot</b>", "",
    "/nextdrop — when's the next drop &amp; what's the prize",
    "/help — this message", "",
    "<i>Coming soon: /mytickets, /enter</i>", "",
    `Hold $DROP, get tickets automatically → ${SITE}`,
  ].join("\n");
}
