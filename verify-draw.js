import { createHmac } from "node:crypto";

// ---------- drand quicknet (3s rounds, League of Entropy) ----------
export const DRAND = {
  CHAIN: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971", // quicknet
  GENESIS: 1692803367, // unix seconds
  PERIOD: 3,           // seconds
  RELAYS: [
    "https://api.drand.sh",
    "https://drand.cloudflare.com",
    "https://api2.drand.sh",
  ],
};

// Round number whose randomness becomes available at/after unix time t.
// Public, deterministic — this is the commitment: announce the round before it exists.
export function roundAt(unixSeconds) {
  if (unixSeconds <= DRAND.GENESIS) return 1;
  return Math.floor((unixSeconds - DRAND.GENESIS) / DRAND.PERIOD) + 2; // +2 = strictly future round
}

export function roundTime(round) {
  return DRAND.GENESIS + (round - 1) * DRAND.PERIOD;
}

// Fetch a round from multiple relays and require agreement (network; not unit-tested)
export async function fetchRandomness(round) {
  const results = [];
  for (const base of DRAND.RELAYS) {
    try {
      const res = await fetch(`${base}/v2/beacons/quicknet/rounds/${round}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const j = await res.json();
      if (j.round === round && j.randomness) results.push(j.randomness.toLowerCase());
    } catch { /* try next relay */ }
  }
  if (results.length === 0) throw new Error(`drand round ${round} unavailable from all relays`);
  if (!results.every((r) => r === results[0])) throw new Error(`drand relay disagreement on round ${round}`);
  return results[0]; // hex randomness
}

// ---------- deterministic selection ----------
// pool: [{wallet, tickets}] — MUST be pre-sorted canonically by caller:
//   holder entries sorted by wallet asc, then free entries sorted by entry id asc.
// Returns up to nWinners distinct wallets. One win per wallet per draw.
export function selectWinners(seedHex, drawId, pool, nWinners, excludeWallets = new Set(), startIndex = 0) {
  const entries = pool.filter((e) => e.tickets > 0 && !excludeWallets.has(e.wallet));
  const winners = [];
  let idx = startIndex;
  while (winners.length < nWinners && entries.length > 0) {
    const total = entries.reduce((s, e) => s + BigInt(e.tickets), 0n);
    const digest = createHmac("sha256", Buffer.from(seedHex, "hex"))
      .update(`${drawId}:${idx}`)
      .digest("hex");
    const r = BigInt("0x" + digest) % total;
    let acc = 0n, pick = -1;
    for (let i = 0; i < entries.length; i++) {
      acc += BigInt(entries[i].tickets);
      if (r < acc) { pick = i; break; }
    }
    winners.push({ wallet: entries[pick].wallet, tickets: entries[pick].tickets, index: idx });
    entries.splice(pick, 1); // without replacement: all of that wallet's tickets leave the pool
    idx++;
  }
  return { winners, nextIndex: idx };
}

// Canonical pool builder: holder snapshot entries + free entries.
// Free entries are 1 ticket each and use pseudo-wallet key "free:<id>:<wallet>"
// so a wallet can hold AND free-enter (two distinct pool identities, per-lane).
export function buildPool(snapshotEntries, freeEntries) {
  const holders = snapshotEntries
    .map((e) => ({ wallet: e.wallet, tickets: e.tickets }))
    .sort((a, b) => (a.wallet < b.wallet ? -1 : 1));
  const free = freeEntries
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((f) => ({ wallet: `free:${f.id}:${f.wallet}`, tickets: 1 }));
  return holders.concat(free);
}

// Resolve a pool identity back to the payable wallet
export function payableWallet(poolWallet) {
  if (poolWallet.startsWith("free:")) return poolWallet.split(":")[2];
  return poolWallet;
}
