// ============================================================================
// DROPRATE — Solana edge (the ONLY place that talks to the chain for gacha)
//
// Two jobs, both injected into api/crate.js as "seams":
//   1. findPaymentByReference() — locate the payment tx by its Solana-Pay
//      reference and return the $DROP transfer legs, so payment.verifySplitLegs
//      can confirm the 4-way split (treasury / burn / LP / marketing) landed.
//   2. sendTreasuryTransfer() — treasury keypair sends a $DROP refund NOW.
//
// Every @solana/* import is DYNAMIC (inside the functions) so the pure, offline
// unit-test suite never has to install these packages — they only load at
// runtime on Vercel, where the deps ARE installed. Gacha only; never imported by
// the raffle.
//
// Required env at runtime:
//   SOLANA_RPC_URL   full RPC endpoint (Helius/QuickNode/Triton/etc.)
//   DROP_MINT        $DROP SPL mint address
//   TREASURY_WALLET  public key that receives the 70% treasury leg
//   BURN_WALLET      incinerator (defaults to Solana's 1nc1nerator1111...)
//   LP_WALLET        liquidity wallet (10% leg)
//   MARKETING_WALLET marketing wallet (10% leg)
//   TREASURY_SECRET  base58 OR JSON-array secret key of the treasury (refunds only)
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

// Derive the four destination token accounts (ATAs) from the public wallets.
export async function resolveSplitAtas() {
  const { PublicKey } = await w3();
  const { getAssociatedTokenAddress } = await spl();
  const mint = new PublicKey(requireEnv("DROP_MINT"));
  const ata = (walletStr) => getAssociatedTokenAddress(mint, new PublicKey(walletStr), true);
  const [treasury, burn, lp, marketing] = await Promise.all([
    ata(requireEnv("TREASURY_WALLET")),
    ata(requireEnv("BURN_WALLET", INCINERATOR)),
    ata(requireEnv("LP_WALLET")),
    ata(requireEnv("MARKETING_WALLET")),
  ]);
  return {
    mint: mint.toBase58(),
    treasury: treasury.toBase58(),
    burn: burn.toBase58(),
    lp: lp.toBase58(),
    marketing: marketing.toBase58(),
  };
}

// Pull every $DROP-mint transfer OUT of the tx that carries `reference`, as
// [{ destination, amountRaw }]. Handles both transferChecked and plain transfer.
function extractLegs(parsedTx, mint) {
  const legs = [];
  let sender = null;
  const inner = parsedTx?.meta?.innerInstructions?.flatMap((x) => x.instructions) ?? [];
  const top = parsedTx?.transaction?.message?.instructions ?? [];
  for (const ix of [...top, ...inner]) {
    if (ix.program !== "spl-token" || !ix.parsed) continue;
    const { type, info } = ix.parsed;
    if (type === "transferChecked") {
      if (String(info.mint) !== String(mint)) continue;
      legs.push({ destination: info.destination, amountRaw: info.tokenAmount?.amount ?? "0" });
      sender = sender || info.authority || info.source;
    } else if (type === "transfer") {
      // plain transfer omits the mint; keep it and let the ATA match filter it.
      legs.push({ destination: info.destination, amountRaw: info.amount ?? "0" });
      sender = sender || info.authority || info.source;
    }
  }
  return { legs, sender };
}

// SEAM 1: find the payment by reference and return normalized transfer data.
// Returns null if no confirmed tx carries the reference yet (client should retry).
export async function findPaymentByReference(reference) {
  const { PublicKey } = await w3();
  const { findReference } = await import("@solana/pay");
  const connection = await getConnection();
  const refKey = new PublicKey(reference);

  let sigInfo;
  try {
    sigInfo = await findReference(connection, refKey, { finality: "confirmed" });
  } catch {
    return null; // not found yet
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

// Load the treasury signer from base58 or JSON-array secret.
async function treasuryKeypair() {
  const { Keypair } = await w3();
  const raw = requireEnv("TREASURY_SECRET");
  if (raw.trim().startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }
  const bs58 = (await import("bs58")).default;
  return Keypair.fromSecretKey(bs58.decode(raw.trim()));
}

// SEAM 2: treasury sends `amountRaw` base units of $DROP to `toWallet` now.
// Creates the recipient's ATA if it doesn't exist. Returns the tx signature.
export async function sendTreasuryTransfer(toWallet, amountRaw) {
  const { PublicKey } = await w3();
  const {
    getAssociatedTokenAddress, getOrCreateAssociatedTokenAccount, createTransferInstruction,
  } = await spl();
  const { Transaction, sendAndConfirmTransaction } = await w3();

  const connection = await getConnection();
  const payer = await treasuryKeypair();
  const mint = new PublicKey(requireEnv("DROP_MINT"));
  const dest = new PublicKey(toWallet);

  const fromAta = await getAssociatedTokenAddress(mint, payer.publicKey, true);
  // getOrCreate makes the destination ATA if missing (payer funds the rent).
  const toAtaAcct = await getOrCreateAssociatedTokenAccount(connection, payer, mint, dest, true);

  const ix = createTransferInstruction(fromAta, toAtaAcct.address, payer.publicKey, BigInt(amountRaw));
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
  return sig;
}

// Build the 4-way split payment transaction for the buyer to sign. Each public
// wallet (treasury / burn / LP / marketing) gets its exact share in ONE tx; any
// missing destination token account is created (buyer funds the tiny rent). The
// Solana-Pay reference is attached to the first transfer so confirm() can find it.
export async function buildSplitPaymentTx(payer, reference, split) {
  const { PublicKey, Transaction } = await w3();
  const {
    getAssociatedTokenAddress, getAccount, createAssociatedTokenAccountInstruction, createTransferInstruction,
  } = await spl();

  const connection = await getConnection();
  const mint = new PublicKey(requireEnv("DROP_MINT"));
  const payerPk = new PublicKey(payer);
  const refPk = new PublicKey(reference);
  const fromAta = await getAssociatedTokenAddress(mint, payerPk, true);

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
    const toAta = await getAssociatedTokenAddress(mint, ownerPk, true);
    let exists = true;
    try { await getAccount(connection, toAta); } catch { exists = false; }
    if (!exists) {
      tx.add(createAssociatedTokenAccountInstruction(payerPk, toAta, ownerPk, mint));
    }
    const ix = createTransferInstruction(fromAta, toAta, payerPk, BigInt(d.amount));
    if (!attachedRef) {
      ix.keys.push({ pubkey: refPk, isSigner: false, isWritable: false });
      attachedRef = true;
    }
    tx.add(ix);
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.feePayer = payerPk;
  tx.recentBlockhash = blockhash;
  const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  return { transaction: serialized, blockhash, lastValidBlockHeight };
}
