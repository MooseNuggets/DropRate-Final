// ============================================================================
// DROPRATE — Multi-currency escrow rails for the dev marketplace (USDC + SOL).
//
// The proven $DROP path stays in lib/solana.js untouched. This module adds the
// SAME-CURRENCY rails for USDC (an SPL token) and native SOL, in the same shape
// the $DROP escrow already uses: a buyer-signed, reference-tagged transfer to the
// treasury, verified on-chain by reference, then a treasury-signed payout/refund.
//
// Same-currency only: buyer pays USDC -> dev is paid USDC; buyer pays SOL -> dev
// is paid SOL. No swaps, so the treasury never carries FX risk on an open order.
//
// Required env (in addition to the $DROP ones):
//   USDC_MINT          — the USDC SPL mint (mainnet: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)
//   SOLANA_RPC_URL, TREASURY_WALLET, TREASURY_SECRET — already set for $DROP.
// Every @solana/* import is DYNAMIC so the offline test suite needs no packages.
// ============================================================================

const WSOL_MINT = "So11111111111111111111111111111111111111112"; // for SOL/USD pricing via Jupiter
export const SOL_DECIMALS = 9;
export const USDC_DECIMALS = 6;

async function w3() { return import("@solana/web3.js"); }
async function spl() { return import("@solana/spl-token"); }
async function getConnection() {
  const { Connection } = await w3();
  const url = process.env.SOLANA_RPC_URL;
  if (!url) throw new Error("paymulti: SOLANA_RPC_URL not set");
  return new Connection(url, "confirmed");
}
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`paymulti: ${name} not set`);
  return v;
}
async function treasuryKeypair() {
  const { Keypair } = await w3();
  const raw = requireEnv("TREASURY_SECRET");
  if (raw.trim().startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  const bs58 = (await import("bs58")).default;
  return Keypair.fromSecretKey(bs58.decode(raw.trim()));
}
// A mint's OWNER program (classic Tokenkeg… vs Token-2022) + its decimals.
async function mintContext(connection, mintPk) {
  const { getMint } = await spl();
  const info = await connection.getAccountInfo(mintPk);
  if (!info) throw new Error("paymulti: mint account not found on-chain");
  const programId = info.owner;
  const mint = await getMint(connection, mintPk, "confirmed", programId);
  return { programId, decimals: mint.decimals };
}

// ---- SOL/USD price (same Jupiter source lib/oracle.js uses for $DROP) --------
export async function currentSolUsd() {
  const urls = [
    `https://lite-api.jup.ag/price/v3?ids=${WSOL_MINT}`,
    `https://api.jup.ag/price/v2?ids=${WSOL_MINT}`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const j = await res.json();
      const node = j?.[WSOL_MINT] ?? j?.data?.[WSOL_MINT];
      const p = Number(node?.usdPrice ?? node?.price);
      if (Number.isFinite(p) && p > 0) return p;
    } catch { /* try next */ }
  }
  return null;
}

// ---- USDC ATA resolver (for verifying which token account received funds) ---
export async function resolveUsdcAta(wallet) {
  const { PublicKey } = await w3();
  const { getAssociatedTokenAddress } = await spl();
  const connection = await getConnection();
  const mintPk = new PublicKey(requireEnv("USDC_MINT"));
  const { programId } = await mintContext(connection, mintPk);
  const ata = await getAssociatedTokenAddress(mintPk, new PublicKey(wallet), true, programId);
  return ata.toBase58();
}

// ---- BUILD: buyer-signed, reference-tagged transfer to the treasury ---------
// currency: "USDC" (SPL transfer) | "SOL" (native transfer). amountRaw in base units.
export async function buildDirectPaymentMulti(payer, reference, toWallet, amountRaw, currency) {
  const { PublicKey, Transaction, SystemProgram } = await w3();
  const connection = await getConnection();
  const payerPk = new PublicKey(payer);
  const toPk = new PublicKey(toWallet);
  const refPk = new PublicKey(reference);
  const tx = new Transaction();

  if (currency === "SOL") {
    const ix = SystemProgram.transfer({ fromPubkey: payerPk, toPubkey: toPk, lamports: BigInt(amountRaw) });
    ix.keys.push({ pubkey: refPk, isSigner: false, isWritable: false }); // makes it findable by reference
    tx.add(ix);
  } else if (currency === "USDC") {
    const {
      getAssociatedTokenAddress, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
    } = await spl();
    const mintPk = new PublicKey(requireEnv("USDC_MINT"));
    const { programId, decimals } = await mintContext(connection, mintPk);
    const fromAta = await getAssociatedTokenAddress(mintPk, payerPk, true, programId);
    const toAta = await getAssociatedTokenAddress(mintPk, toPk, true, programId);
    tx.add(createAssociatedTokenAccountIdempotentInstruction(payerPk, toAta, toPk, mintPk, programId));
    const ix = createTransferCheckedInstruction(fromAta, mintPk, toAta, payerPk, BigInt(amountRaw), decimals, [], programId);
    ix.keys.push({ pubkey: refPk, isSigner: false, isWritable: false });
    tx.add(ix);
  } else {
    throw new Error(`paymulti: unsupported currency ${currency}`);
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.feePayer = payerPk;
  tx.recentBlockhash = blockhash;
  const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  return { transaction: serialized, blockhash, lastValidBlockHeight };
}

// ---- VERIFY: find the reference-tagged payment and pull its legs -------------
// Returns { legs:[{destination, amountRaw}], sender, signature } or null.
// For USDC, destination is a token account (ATA). For SOL, destination is a wallet.
export async function findDirectPayment(reference, currency) {
  const { PublicKey } = await w3();
  const { findReference } = await import("@solana/pay");
  const connection = await getConnection();
  const refKey = new PublicKey(reference);
  let sigInfo;
  try { sigInfo = await findReference(connection, refKey, { finality: "confirmed" }); }
  catch { return null; }
  const parsed = await connection.getParsedTransaction(sigInfo.signature, {
    commitment: "confirmed", maxSupportedTransactionVersion: 0,
  });
  if (!parsed || parsed.meta?.err) return null;

  const legs = [];
  let sender = null;
  const inner = parsed?.meta?.innerInstructions?.flatMap((x) => x.instructions) ?? [];
  const top = parsed?.transaction?.message?.instructions ?? [];

  if (currency === "SOL") {
    for (const ix of [...top, ...inner]) {
      if (ix.program !== "system" || !ix.parsed) continue;
      const { type, info } = ix.parsed;
      if (type === "transfer") {
        legs.push({ destination: info.destination, amountRaw: String(info.lamports ?? "0") });
        sender = sender || info.source;
      }
    }
    return { legs, sender, signature: sigInfo.signature };
  }

  const mint = requireEnv("USDC_MINT");
  for (const ix of [...top, ...inner]) {
    if ((ix.program !== "spl-token" && ix.program !== "spl-token-2022") || !ix.parsed) continue;
    const { type, info } = ix.parsed;
    if (type === "transferChecked") {
      if (String(info.mint) !== String(mint)) continue;
      legs.push({ destination: info.destination, amountRaw: info.tokenAmount?.amount ?? "0" });
      sender = sender || info.authority || info.source;
    } else if (type === "transfer") {
      legs.push({ destination: info.destination, amountRaw: info.amount ?? "0" });
      sender = sender || info.authority || info.source;
    }
  }
  return { legs, sender, signature: sigInfo.signature };
}

// ---- PAYOUT / REFUND: treasury sends `amountRaw` of `currency` to `toWallet` -
export async function sendTreasuryMulti(toWallet, amountRaw, currency) {
  const { PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction } = await w3();
  const connection = await getConnection();
  const payer = await treasuryKeypair();
  const destPk = new PublicKey(toWallet);
  const tx = new Transaction();

  if (currency === "SOL") {
    tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: destPk, lamports: BigInt(amountRaw) }));
  } else if (currency === "USDC") {
    const {
      getAssociatedTokenAddress, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
    } = await spl();
    const mintPk = new PublicKey(requireEnv("USDC_MINT"));
    const { programId, decimals } = await mintContext(connection, mintPk);
    const fromAta = await getAssociatedTokenAddress(mintPk, payer.publicKey, true, programId);
    const toAta = await getAssociatedTokenAddress(mintPk, destPk, true, programId);
    tx.add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, toAta, destPk, mintPk, programId));
    tx.add(createTransferCheckedInstruction(fromAta, mintPk, toAta, payer.publicKey, BigInt(amountRaw), decimals, [], programId));
  } else {
    throw new Error(`paymulti: unsupported currency ${currency}`);
  }

  const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
  return sig;
}
