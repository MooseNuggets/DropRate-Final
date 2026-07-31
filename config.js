import { createCipheriv, createDecipheriv, randomBytes, createPublicKey, verify as edVerify } from "node:crypto";

// ---------- code vault: AES-256-GCM, key from env CODE_VAULT_KEY (64 hex chars) ----------
export function encryptCode(plaintext, keyHex) {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) throw new Error("CODE_VAULT_KEY must be 32 bytes hex");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

export function decryptCode(blob, keyHex) {
  const key = Buffer.from(keyHex, "hex");
  const raw = Buffer.from(blob, "base64");
  const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), enc = raw.subarray(28);
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

// ---------- base58 (no deps) ----------
const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const AMAP = Object.fromEntries([...ALPHA].map((c, i) => [c, BigInt(i)]));

export function b58decode(s) {
  let n = 0n;
  for (const ch of s) {
    const v = AMAP[ch];
    if (v === undefined) throw new Error("invalid base58");
    n = n * 58n + v;
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of s) { if (ch === "1") bytes.unshift(0); else break; }
  return Buffer.from(bytes);
}

// ---------- ed25519 verify via node:crypto (Solana wallet signMessage) ----------
// raw 32-byte pubkey -> SPKI DER wrapper
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function verifyWalletSignature(message, signatureB58OrB64, walletB58) {
  const pubRaw = b58decode(walletB58);
  if (pubRaw.length !== 32) throw new Error("invalid wallet pubkey");
  const keyObj = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, pubRaw]),
    format: "der",
    type: "spki",
  });
  let sig;
  try { sig = b58decode(signatureB58OrB64); } catch { sig = Buffer.from(signatureB58OrB64, "base64"); }
  if (sig.length !== 64) {
    // maybe base64 decoded to wrong length; retry base64 explicitly
    sig = Buffer.from(signatureB58OrB64, "base64");
  }
  if (sig.length !== 64) throw new Error("invalid signature length");
  return edVerify(null, Buffer.from(message, "utf8"), keyObj, sig);
}

export function claimMessage(drawId, wallet, nonce) {
  return `DROPRATE claim draw:${drawId} wallet:${wallet} nonce:${nonce}`;
}
