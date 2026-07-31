#!/usr/bin/env node
// DROPRATE draw verifier — reproduce any draw's winners from public data.
//
// Usage:
//   node scripts/verify-draw.js <site-url> <draw-id>
//
// What it does:
//   1. Fetches the draw record (drand round, seed, snapshot id, winners) from /api/draws
//   2. Fetches the drand beacon for that round from drand's own public API
//      and confirms the seed matches (the round number was committed BEFORE it existed)
//   3. Fetches the snapshot entries + free entries and re-runs the exact
//      selection algorithm locally
//   4. Compares the locally computed winners with the published ones
//
// The selection code imported below is the same code the server runs.

import { selectWinners, buildPool, payableWallet, DRAND } from "../lib/draw.js";

const [site, drawIdArg] = process.argv.slice(2);
if (!site || !drawIdArg) {
  console.error("usage: node scripts/verify-draw.js <site-url> <draw-id>");
  process.exit(1);
}
const drawId = Number(drawIdArg);

const j = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(`${u} -> ${r.status}`); return r.json(); });

const { draws } = await j(`${site}/api/draws`);
const draw = draws.find((d) => d.id === drawId);
if (!draw) throw new Error(`draw ${drawId} not found`);
if (draw.status !== "drawn") throw new Error(`draw ${drawId} not run yet (status: ${draw.status})`);

console.log(`Draw #${draw.id} — "${draw.prize_title}" — drand round ${draw.drand_round}`);

// independent randomness check straight from drand
const beacon = await j(`https://api.drand.sh/v2/beacons/quicknet/rounds/${draw.drand_round}`);
if (beacon.randomness.toLowerCase() !== draw.seed.toLowerCase()) {
  console.error("❌ SEED MISMATCH: published seed does not equal the drand beacon for the committed round");
  process.exit(1);
}
console.log("✓ seed matches the public drand beacon");

const { entries } = await j(`${site}/api/snapshot-entries?snapshot_id=${draw.snapshot_id}`);
const { free } = await j(`${site}/api/free-entries?draw_id=${draw.id}`);
const pool = buildPool(entries, free);

const { winners } = selectWinners(draw.seed, draw.id, pool, draw.n_winners);
const computed = winners.map((w) => payableWallet(w.wallet));
const published = draw.winners.filter((w) => w.status !== "expired").map((w) => w.wallet);

console.log("computed :", computed.join(", "));
console.log("published:", published.slice(0, computed.length).join(", "));

const match = computed.every((w, i) => w === published[i]);
console.log(match ? "✓ WINNERS VERIFIED — draw reproduces exactly" : "❌ MISMATCH — winners do not reproduce");
process.exit(match ? 0 : 1);
