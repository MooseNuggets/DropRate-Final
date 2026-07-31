import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG, ticketsFor, RAW_PER_TICKET } from "../lib/config.js";
import { windowStart, randomOffsetMinutes, isDue, buildEntries, summarize } from "../lib/snapshot.js";
import { merkleRoot, merkleProof, verifyProof } from "../lib/merkle.js";

const T = (tokens) => BigInt(tokens) * 10n ** BigInt(CONFIG.DECIMALS);

test("tickets: floor division per 10k", () => {
  assert.equal(ticketsFor(T(9_999)), 0);
  assert.equal(ticketsFor(T(10_000)), 1);
  assert.equal(ticketsFor(T(19_999)), 1);
  assert.equal(ticketsFor(T(50_000)), 5);
});

test("tickets: capped at 100 (1M tokens)", () => {
  assert.equal(ticketsFor(T(1_000_000)), 100);
  assert.equal(ticketsFor(T(999_999)), 99);
  assert.equal(ticketsFor(T(5_000_000)), 100);
  assert.equal(ticketsFor(T(1_000_000_000)), 100); // whole supply, still 100
});

test("aggregation: multiple token accounts per owner combine", () => {
  const entries = buildEntries(
    [
      { owner: "walletA", amountRaw: T(6_000) },
      { owner: "walletA", amountRaw: T(6_000) }, // combined 12k = 1 ticket
      { owner: "walletB", amountRaw: T(9_000) }, // below threshold, dropped
      { owner: "walletC", amountRaw: T(2_500_000) }, // capped
    ],
    new Set()
  );
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => [e.wallet, e.tickets]),
    [["walletA", 1], ["walletC", 100]]);
});

test("aggregation: exclusion list removes wallets", () => {
  const entries = buildEntries(
    [
      { owner: "curve", amountRaw: T(800_000_000) },
      { owner: "holder", amountRaw: T(20_000) },
    ],
    new Set(["curve"])
  );
  assert.deepEqual(entries.map((e) => e.wallet), ["holder"]);
});

test("scheduler: window start floors to 6h boundary", () => {
  const w = windowStart(new Date("2026-07-27T17:59:00Z"));
  assert.equal(w.toISOString(), "2026-07-27T12:00:00.000Z");
  const w2 = windowStart(new Date("2026-07-27T18:00:00Z"));
  assert.equal(w2.toISOString(), "2026-07-27T18:00:00.000Z");
});

test("scheduler: random offset stays inside bounds over many draws", () => {
  for (let i = 0; i < 5000; i++) {
    const o = randomOffsetMinutes();
    assert.ok(o >= CONFIG.OFFSET_MIN_MINUTES && o <= CONFIG.OFFSET_MAX_MINUTES);
  }
});

test("scheduler: isDue fires only after offset", () => {
  const win = new Date("2026-07-27T12:00:00Z");
  assert.equal(isDue(new Date("2026-07-27T13:29:59Z"), win, 90), false);
  assert.equal(isDue(new Date("2026-07-27T13:30:00Z"), win, 90), true);
});

test("merkle: deterministic regardless of entry order", () => {
  const a = [{ wallet: "x", tickets: 3 }, { wallet: "y", tickets: 7 }, { wallet: "z", tickets: 1 }];
  const b = [a[2], a[0], a[1]];
  assert.equal(merkleRoot(a), merkleRoot(b));
});

test("merkle: root changes if any ticket count changes", () => {
  const a = [{ wallet: "x", tickets: 3 }, { wallet: "y", tickets: 7 }];
  const b = [{ wallet: "x", tickets: 3 }, { wallet: "y", tickets: 8 }];
  assert.notEqual(merkleRoot(a), merkleRoot(b));
});

test("merkle: inclusion proofs verify, wrong data fails", () => {
  const entries = Array.from({ length: 137 }, (_, i) => ({ wallet: `w${String(i).padStart(3, "0")}`, tickets: (i % 100) + 1 }));
  const root = merkleRoot(entries);
  for (const e of [entries[0], entries[64], entries[136]]) {
    const proof = merkleProof(entries, e.wallet, e.tickets);
    assert.ok(proof, "proof exists");
    assert.equal(verifyProof(root, e.wallet, e.tickets, proof), true);
    assert.equal(verifyProof(root, e.wallet, e.tickets + 1, proof), false);
  }
  assert.equal(merkleProof(entries, "not-a-wallet", 5), null);
});

test("summarize: counts and totals", () => {
  const s = summarize([{ wallet: "a", tickets: 100 }, { wallet: "b", tickets: 2 }]);
  assert.equal(s.holderCount, 2);
  assert.equal(s.totalTickets, 102);
  assert.equal(typeof s.merkleRoot, "string");
});
