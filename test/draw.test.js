import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { roundAt, roundTime, selectWinners, buildPool, payableWallet, DRAND } from "../lib/draw.js";
import { encryptCode, decryptCode, verifyWalletSignature, claimMessage, b58decode } from "../lib/vault.js";

const SEED = "a3f1c2d4e5b6978811223344556677889900aabbccddeeff0011223344556677";

test("drand: committed round is strictly in the future", () => {
  const now = Math.floor(Date.now() / 1000);
  const r = roundAt(now);
  assert.ok(roundTime(r) > now, "round time must be after commitment time");
  assert.ok(roundTime(r) - now <= DRAND.PERIOD * 2, "and not far after");
});

test("selection: deterministic — same inputs, same winners", () => {
  const pool = buildPool(
    [{ wallet: "Alice", tickets: 10 }, { wallet: "Bob", tickets: 100 }, { wallet: "Cara", tickets: 1 }],
    [{ id: 1, wallet: "Dave" }, { id: 2, wallet: "Eve" }]
  );
  const a = selectWinners(SEED, 7, pool, 3);
  const b = selectWinners(SEED, 7, pool, 3);
  assert.deepEqual(a.winners, b.winners);
});

test("selection: different seed or draw id changes outcome distribution", () => {
  const pool = buildPool(
    Array.from({ length: 50 }, (_, i) => ({ wallet: `w${i}`, tickets: 5 })), []
  );
  const a = selectWinners(SEED, 1, pool, 5).winners.map((w) => w.wallet).join(",");
  const b = selectWinners(SEED, 2, pool, 5).winners.map((w) => w.wallet).join(",");
  const c = selectWinners(SEED.replace("a", "b"), 1, pool, 5).winners.map((w) => w.wallet).join(",");
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

test("selection: without replacement — no wallet wins twice", () => {
  const pool = buildPool(
    [{ wallet: "Whale", tickets: 100 }, { wallet: "S1", tickets: 1 }, { wallet: "S2", tickets: 1 }], []
  );
  const { winners } = selectWinners(SEED, 3, pool, 3);
  const names = winners.map((w) => w.wallet);
  assert.equal(new Set(names).size, names.length);
  assert.equal(names.length, 3); // pool exhausts exactly
});

test("selection: weights matter — capped whale wins most but not all over many draws", () => {
  const pool = buildPool(
    [{ wallet: "Whale", tickets: 100 }, ...Array.from({ length: 100 }, (_, i) => ({ wallet: `minnow${i}`, tickets: 1 }))],
    []
  );
  let whaleWins = 0;
  for (let drawId = 0; drawId < 400; drawId++) {
    const { winners } = selectWinners(SEED, drawId, pool, 1);
    if (winners[0].wallet === "Whale") whaleWins++;
  }
  // whale has 100/200 tickets = ~50% expectation
  assert.ok(whaleWins > 140 && whaleWins < 260, `whale won ${whaleWins}/400 — expected near 200`);
});

test("selection: exhausted pool stops early instead of looping", () => {
  const pool = buildPool([{ wallet: "only", tickets: 5 }], []);
  const { winners } = selectWinners(SEED, 1, pool, 10);
  assert.equal(winners.length, 1);
});

test("redraw: excluding prior winners and continuing index is deterministic", () => {
  const pool = buildPool(
    [{ wallet: "A", tickets: 3 }, { wallet: "B", tickets: 3 }, { wallet: "C", tickets: 3 }], []
  );
  const first = selectWinners(SEED, 9, pool, 1);
  const exclude = new Set(first.winners.map((w) => w.wallet));
  const r1 = selectWinners(SEED, 9, pool, 1, exclude, first.nextIndex);
  const r2 = selectWinners(SEED, 9, pool, 1, exclude, first.nextIndex);
  assert.deepEqual(r1.winners, r2.winners);
  assert.ok(!exclude.has(r1.winners[0].wallet));
});

test("free entries: 1 ticket each, wallet can hold AND free-enter, payable resolves", () => {
  const pool = buildPool(
    [{ wallet: "Holder", tickets: 4 }],
    [{ id: 10, wallet: "Holder" }, { id: 11, wallet: "FreeOnly" }]
  );
  assert.equal(pool.length, 3);
  const free = pool.find((p) => p.wallet.startsWith("free:11:"));
  assert.equal(free.tickets, 1);
  assert.equal(payableWallet("free:11:FreeOnly"), "FreeOnly");
  assert.equal(payableWallet("Holder"), "Holder");
});

test("vault: encrypt/decrypt roundtrip, tamper fails", () => {
  const key = "11".repeat(32);
  const blob = encryptCode("STEAM-ABCD-1234-XYZ", key);
  assert.equal(decryptCode(blob, key), "STEAM-ABCD-1234-XYZ");
  const raw = Buffer.from(blob, "base64");
  raw[raw.length - 1] ^= 0xff;
  assert.throws(() => decryptCode(raw.toString("base64"), key));
});

test("signature: real ed25519 sign/verify with base58 wallet", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  // base58-encode pubkey like a Solana address
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n; for (const b of rawPub) n = n * 256n + BigInt(b);
  let wallet = ""; while (n > 0n) { wallet = A[Number(n % 58n)] + wallet; n /= 58n; }
  for (const b of rawPub) { if (b === 0) wallet = "1" + wallet; else break; }

  assert.deepEqual([...b58decode(wallet)], [...rawPub], "b58 roundtrip");

  const msg = claimMessage(12, wallet, "deadbeef");
  const sig = edSign(null, Buffer.from(msg, "utf8"), privateKey);
  let sn = 0n; for (const b of sig) sn = sn * 256n + BigInt(b);
  let sigB58 = ""; while (sn > 0n) { sigB58 = A[Number(sn % 58n)] + sigB58; sn /= 58n; }
  for (const b of sig) { if (b === 0) sigB58 = "1" + sigB58; else break; }

  assert.equal(verifyWalletSignature(msg, sigB58, wallet), true);
  assert.equal(verifyWalletSignature(msg + "x", sigB58, wallet), false);
});
