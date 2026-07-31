import { randomInt } from "node:crypto";
import { CONFIG, ticketsFor } from "./config.js";
import { merkleRoot } from "./merkle.js";

// ---------- window math (pure, tested) ----------
export function windowStart(now = new Date()) {
  const ms = CONFIG.WINDOW_HOURS * 3600 * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

export function randomOffsetMinutes() {
  // CSPRNG offset inside the window; never published before the snapshot fires
  return randomInt(CONFIG.OFFSET_MIN_MINUTES, CONFIG.OFFSET_MAX_MINUTES + 1);
}

export function isDue(now, winStart, offsetMinutes) {
  return now.getTime() >= winStart.getTime() + offsetMinutes * 60_000;
}

// ---------- holder aggregation (pure, tested) ----------
// tokenAccounts: [{owner, amountRaw: BigInt}], exclusions: Set<string>
export function buildEntries(tokenAccounts, exclusions) {
  const byOwner = new Map();
  for (const ta of tokenAccounts) {
    if (exclusions.has(ta.owner)) continue;
    byOwner.set(ta.owner, (byOwner.get(ta.owner) ?? 0n) + ta.amountRaw);
  }
  const entries = [];
  for (const [wallet, balanceRaw] of byOwner) {
    const tickets = ticketsFor(balanceRaw);
    if (tickets >= 1) entries.push({ wallet, balanceRaw, tickets });
  }
  entries.sort((a, b) => (a.wallet < b.wallet ? -1 : 1));
  return entries;
}

export function summarize(entries) {
  return {
    holderCount: entries.length,
    totalTickets: entries.reduce((s, e) => s + e.tickets, 0),
    merkleRoot: merkleRoot(entries),
  };
}

// ---------- Helius fetch (network; not unit-tested) ----------
export async function fetchAllTokenAccounts(mint, apiKey) {
  const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  const out = [];
  let cursor = undefined;
  for (let page = 0; page < 200; page++) {          // hard stop safety
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "droprate-snap",
        method: "getTokenAccounts",
        params: { mint, limit: 1000, ...(cursor ? { cursor } : {}) },
      }),
    });
    if (!res.ok) throw new Error(`Helius ${res.status}: ${await res.text()}`);
    const { result, error } = await res.json();
    if (error) throw new Error(`Helius RPC error: ${JSON.stringify(error)}`);
    for (const ta of result.token_accounts ?? []) {
      out.push({ owner: ta.owner, amountRaw: BigInt(ta.amount) });
    }
    cursor = result.cursor;
    if (!cursor) break;
  }
  return out;
}
