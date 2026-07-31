import { createHash } from "node:crypto";

const sha = (s) => createHash("sha256").update(s).digest("hex");

// Leaf format is public and documented: sha256("wallet:tickets")
export function leafHash(wallet, tickets) {
  return sha(`${wallet}:${tickets}`);
}

// Deterministic root: leaves sorted lexicographically, odd node promoted.
export function merkleRoot(entries /* [{wallet,tickets}] */) {
  if (entries.length === 0) return sha("empty");
  let level = entries
    .map((e) => leafHash(e.wallet, e.tickets))
    .sort();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? sha(level[i] + level[i + 1]) : level[i]);
    }
    level = next;
  }
  return level[0];
}

// Inclusion proof for a wallet (for the public verify page later)
export function merkleProof(entries, wallet, tickets) {
  let level = entries.map((e) => leafHash(e.wallet, e.tickets)).sort();
  let idx = level.indexOf(leafHash(wallet, tickets));
  if (idx === -1) return null;
  const proof = [];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        if (i === idx || i + 1 === idx) {
          proof.push({ hash: level[i === idx ? i + 1 : i], left: i + 1 === idx });
        }
        next.push(sha(level[i] + level[i + 1]));
      } else {
        next.push(level[i]);
      }
      if (i === idx || i + 1 === idx) idx = next.length - 1;
    }
    level = next;
  }
  return proof;
}

export function verifyProof(root, wallet, tickets, proof) {
  let h = leafHash(wallet, tickets);
  for (const p of proof) h = p.left ? sha(p.hash + h) : sha(h + p.hash);
  return h === root;
}
