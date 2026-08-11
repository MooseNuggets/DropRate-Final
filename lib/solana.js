// ============================================================================
// DROPRATE — Solana edge (the ONLY place that talks to the chain for gacha)
//
// Detects whether $DROP is a classic SPL Token or a Token-2022 mint and uses the
// correct token program for every ATA derivation, account creation, transfer, and
// for reading the payment back. Every @solana/* import is DYNAMIC so the offline
// unit-test suite never needs these packages installed. Gacha only.
//
// Required env: SOLANA_RPC_URL, DROP_MINT, TREASURY_WALLET, BURN_WALLET
// (defaults to incinerator), LP_WALLET, MARKETING_WALLET, TREASURY_SECRET.
// ============================================================================

const INCINERATOR = "1nc1nerator11111111111111111111111111111111";

async function w3() { return import("@solana/web3.js"); }
async function spl() { return import("@solana/spl-token"); }

async function getConnection() {
  const { Connection } = await w3();
  const url = process.env.SOLANA_RPC_URL;
  if (!url) throw new Error("solana: SOLANA_RPC_URL not set");
  return new Connection(url, "confirmed");
}
function requireEnv(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`solana: ${name} not set`);
  return v;
}

// The mint account's OWNER is the token program (classic Tokenkeg… or Token-2022
// TokenzQd…). We read it once and thread it through everything.
async function mintContext(connection, mintPk) {
  const { getMint } = await spl();
  const info = await connection.getAccountInfo(mintPk);
  if (!info) throw new Error("solana: DROP_MINT account not found on-chain");
  const programId = info.owner; // PublicKey of the owning token program
  const mint = await getMint(connection, mintPk, "confirmed", programId);
  return { programId, decimals: mint.decimals };
}

// Derive the four destination token accounts using the mint's own token program.
export async function resolveSplitAtas() {
  const { PublicKey } = await w3();
  const { getAssociatedTokenAddress } = await spl();
  const connection = await getConnection();
  const mintPk = new PublicKey(requireEnv("DROP_MINT"));
  const { programId } = await mintContext(connection, mintPk);
  const ata = (walletStr) => getAssociatedTokenAddress(mintPk, new PublicKey(walletStr), true, programId);
  const [treasury, burn, lp, marketing] = await Promise.all([
    ata(requireEnv("TREASURY_WALLET")),
    ata(requireEnv("BURN_WALLET", INCINERATOR)),
    ata(requireEnv("LP_WALLET")),
    ata(requireEnv("MARKETING_WALLET")),
  ]);
  return {
    mint: mintPk.toBase58(),
    treasury: treasury.toBase58(),
    burn: burn.toBase58(),
    lp: lp.toBase58(),
    marketing: marketing.toBase58(),
  };
}

// Pull the $DROP transfers out of a parsed tx. Accepts BOTH spl-token and
// spl-token-2022 program instructions.
function extractLegs(parsedTx, mint) {
  const legs = [];
  let sender = null;
  const inner = parsedTx?.meta?.innerInstructions?.flatMap((x) => x.instructions) ?? [];
  const top = parsedTx?.transaction?.message?.instructions ?? [];
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
  return { legs, sender };
}

// SEAM 1: find the payment by reference and return its transfer legs.
export async function findPaymentByReference(reference) {
  const { PublicKey } = await w3();
  const { findReference } = await import("@solana/pay");
  const connection = await getConnection();
  const refKey = new PublicKey(reference);
  let sigInfo;
  try {
    sigInfo = await findReference(connection, refKey, { finality: "confirmed" });
  } catch {
    return null;
  }
  const parsed = await connection.getParsedTransaction(sigInfo.signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!parsed || parsed.meta?.err) return null;
  const mint = requireEnv("DROP_MINT");
  const { legs, sender } = extractLegs(parsed, mint);
  return { legs, sender, signature: sigInfo.signature, mint };
}

async function treasuryKeypair() {
  const { Keypair } = await w3();
  const raw = requireEnv("TREASURY_SECRET");
  if (raw.trim().startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  const bs58 = (await import("bs58")).default;
  return Keypair.fromSecretKey(bs58.decode(raw.trim()));
}

// SEAM helper (buildpay): the buyer-signed 4-way split, program-correct + 2022-safe.
export async function buildSplitPaymentTx(payer, reference, split) {
  const { PublicKey, Transaction } = await w3();
  const {
    getAssociatedTokenAddress, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
  } = await spl();
  const connection = await getConnection();
  const mintPk = new PublicKey(requireEnv("DROP_MINT"));
  const { programId, decimals } = await mintContext(connection, mintPk);
  const payerPk = new PublicKey(payer);
  const refPk = new PublicKey(reference);
  const fromAta = await getAssociatedTokenAddress(mintPk, payerPk, true, programId);

  const dests = [
    { owner: requireEnv("TREASURY_WALLET"), amount: split.treasuryRaw },
    { owner: requireEnv("BURN_WALLET", INCINERATOR), amount: split.burnRaw },
    { owner: requireEnv("LP_WALLET"), amount: split.lpRaw },
    { owner: requireEnv("MARKETING_WALLET"), amount: split.marketingRaw },
  ];

  const tx = new Transaction();
  let attachedRef = false;
  for (const d of dests) {
    if (BigInt(d.amount) <= 0n) continue;
    const ownerPk = new PublicKey(d.owner);
    const toAta = await getAssociatedTokenAddress(mintPk, ownerPk, true, programId);
    tx.add(createAssociatedTokenAccountIdempotentInstruction(payerPk, toAta, ownerPk, mintPk, programId));
    const ix = createTransferCheckedInstruction(fromAta, mintPk, toAta, payerPk, BigInt(d.amount), decimals, [], programId);
    if (!attachedRef) { ix.keys.push({ pubkey: refPk, isSigner: false, isWritable: false }); attachedRef = true; }
    tx.add(ix);
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.feePayer = payerPk;
  tx.recentBlockhash = blockhash;
  const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  return { transaction: serialized, blockhash, lastValidBlockHeight };
}

// SEAM 2: treasury sends `amountRaw` $DROP to `toWallet` now (refund), 2022-safe.
export async function sendTreasuryTransfer(toWallet, amountRaw) {
  const { PublicKey, Transaction, sendAndConfirmTransaction } = await w3();
  const {
    getAssociatedTokenAddress, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction,
  } = await spl();
  const connection = await getConnection();
  const payer = await treasuryKeypair();
  const mintPk = new PublicKey(requireEnv("DROP_MINT"));
  const { programId, decimals } = await mintContext(connection, mintPk);
  const destPk = new PublicKey(toWallet);
  const fromAta = await getAssociatedTokenAddress(mintPk, payer.publicKey, true, programId);
  const toAta = await getAssociatedTokenAddress(mintPk, destPk, true, programId);
  const tx = new Transaction();
  tx.add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, toAta, destPk, mintPk, programId));
  tx.add(createTransferCheckedInstruction(fromAta, mintPk, toAta, payer.publicKey, BigInt(amountRaw), decimals, [], programId));
  const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
  return sig;
}
