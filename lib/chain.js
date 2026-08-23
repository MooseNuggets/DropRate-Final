// ============================================================================
// DROPRATE — on-chain ownership (Metaplex Core)
//
// One copy of a game = one Core Asset in that game's Core Collection, held in
// the buyer's own wallet. This module is the ONLY place that talks to the chain
// about ownership; everything else asks it questions.
//
// WHY CORE, AND WHY THIS SHAPE — measured on mainnet 22 Aug 2026:
//   collection   0.002105 SOL  ($0.19)  once per game published
//   mint         0.003366 SOL  ($0.31)  per copy sold, 1.54% of a $20 sale
//   Token Metadata / pNFT would be ~$2.01 a copy — more than the platform fee.
// Those are observed balance deltas from a real run, not documentation figures.
//
// THE BUYER PAYS, AND THAT IS NOT AN ACCIDENT
//   The mint's rent is a DEPOSIT held by the asset account, recoverable if the
//   copy is ever burned. Whoever funds it should be whoever owns the thing it
//   sits on. If DropRate funded it, DropRate would have capital locked in
//   accounts it does not control, and the OWNER would recover it on burn — a
//   permanent donation of 1.54% of every sale. So: buyer pays, DropRate signs.
//   Verified on mainnet with the DropRate authority holding exactly zero SOL.
//
// WHY THE SERVER BUILDS THE TRANSACTION AND THE CLIENT SIGNS IT
//   A game is bought from the store today and from the launcher tomorrow. If the
//   mint were assembled in the browser, the launcher would need its own
//   implementation of the money path — two codebases, two sets of bugs. Instead
//   the server builds an unsigned transaction (deciding what is minted, into
//   which collection, after checking payment and supply), and ANY client signs
//   it with whatever wallet it has. This mirrors lib/paymulti.js, which already
//   hands buyers unsigned transfers to sign.
//
//   The asset address is a fresh keypair that must itself sign, so the server
//   signs with the asset and with the DropRate authority, and leaves the buyer's
//   signature slot empty via a noop signer. Nothing forgeable reaches the client.
//
// NO DAS API DEPENDENCY
//   Ownership is read straight off the asset account with a plain RPC call. We
//   know every asset address because we recorded it at mint, so we never need to
//   ask "what does this wallet own" — only "who owns this one". That keeps us on
//   ordinary RPC instead of an indexer.
//
// Every @metaplex-foundation/* import is DYNAMIC, exactly as lib/paymulti.js
// does with @solana/*, so the offline test suite needs no packages installed.
//
// Required env:
//   SOLANA_RPC_URL          already set for $DROP
//   CHAIN_AUTHORITY_SECRET  base58 or JSON-array secret key for the wallet that
//                           owns game collections and authorises mints.
//                           Falls back to TREASURY_SECRET if unset.
//
//                           IT NEEDS A LITTLE SOL, but less than you'd think:
//                           it PAYS for collection creation (~0.0021 SOL, once
//                           per game published) and pays NOTHING for mints —
//                           there the buyer is the fee payer and this wallet
//                           only signs. 0.1 SOL covers roughly 47 game launches.
//                           Keep it topped up; a dry authority means a game's
//                           first sale fails at collection creation.
// ============================================================================

// ---- dynamic module loaders ------------------------------------------------
async function umiCore() { return import("@metaplex-foundation/umi"); }
async function umiDefaults() { return import("@metaplex-foundation/umi-bundle-defaults"); }
async function mplCore() { return import("@metaplex-foundation/mpl-core"); }

const RENT_PER_COPY_SOL = 0.003366;      // measured, for quoting the buyer up front
const RENT_PER_GAME_SOL = 0.002105;      // measured, what DropRate pays per publish

export const MINT_COST_SOL = RENT_PER_COPY_SOL;
export const COLLECTION_COST_SOL = RENT_PER_GAME_SOL;

function rpcUrl() {
  const url = (process.env.SOLANA_RPC_URL || "").trim();
  if (!url) throw new Error("chain: SOLANA_RPC_URL not set");
  return url;
}

function authoritySecret() {
  const raw = (process.env.CHAIN_AUTHORITY_SECRET || process.env.TREASURY_SECRET || "").trim();
  if (!raw) throw new Error("chain: CHAIN_AUTHORITY_SECRET not set");
  return raw;
}

/* True when this deployment can do on-chain ownership at all. Callers use it to
   degrade gracefully rather than throwing at a buyer mid-checkout. */
export function chainConfigured() {
  return Boolean(
    (process.env.SOLANA_RPC_URL || "").trim() &&
    (process.env.CHAIN_AUTHORITY_SECRET || process.env.TREASURY_SECRET || "").trim()
  );
}

async function secretToKeypair(umi, raw) {
  let bytes;
  if (raw.startsWith("[")) {
    bytes = Uint8Array.from(JSON.parse(raw));
  } else {
    const bs58 = (await import("bs58")).default;
    bytes = bs58.decode(raw);
  }
  return umi.eddsa.createKeypairFromSecretKey(bytes);
}

/* One configured umi per process. The authority is the identity, so anything
   that does not explicitly override the payer would be paid for by DropRate —
   which is why buildMintTransaction sets the payer explicitly, every time. */
let _umi = null;
async function getUmi() {
  if (_umi) return _umi;
  const { createUmi } = await umiDefaults();
  const { keypairIdentity } = await umiCore();
  const { mplCore: plugin } = await mplCore();
  const umi = createUmi(rpcUrl()).use(plugin());
  const kp = await secretToKeypair(umi, authoritySecret());
  _umi = umi.use(keypairIdentity(kp));
  return _umi;
}

export async function authorityAddress() {
  const umi = await getUmi();
  return String(umi.identity.publicKey);
}

// ---------------------------------------------------------------------------
// COLLECTION — one per game, created when an admin approves it for the store.
//
// The Royalties plugin here does NOT collect royalties; it restricts which
// programs may transfer the asset. We use ProgramDenyList with an EMPTY list:
// every venue works by default, and a marketplace caught routing around the
// developer's cut can be added later with updateCollectionPlugin — no migration,
// no re-mint. Default-allow keeps "it's yours, take it anywhere" literally true,
// and the failure mode is temporary and forward-fixable, unlike an allowlist
// whose failure is structural.
// ---------------------------------------------------------------------------
export async function createGameCollection({ name, uri, royaltyBps, payoutWallet, denyList }) {
  const umi = await getUmi();
  const { generateSigner, publicKey } = await umiCore();
  const { createCollection, ruleSet } = await mplCore();

  const bps = Math.max(0, Math.min(10000, Number(royaltyBps) || 0));
  const deny = Array.isArray(denyList) ? denyList.map((p) => publicKey(p)) : [];
  const collection = generateSigner(umi);

  await createCollection(umi, {
    collection,
    name: String(name || "DropRate game").slice(0, 32),
    uri: String(uri || ""),
    plugins: [{
      type: "Royalties",
      basisPoints: bps,
      creators: [{ address: publicKey(payoutWallet), percentage: 100 }],
      ruleSet: ruleSet("ProgramDenyList", [deny]),
    }],
  }).sendAndConfirm(umi);

  return { collection: String(collection.publicKey) };
}

// ---------------------------------------------------------------------------
// MINT — server builds, buyer signs, anywhere.
//
// Returns a base64 transaction that is already signed by the new asset keypair
// and by the DropRate authority, with only the buyer's signature missing. The
// caller hands it to a browser, the launcher, or anything else with a wallet.
// ---------------------------------------------------------------------------
export async function buildMintTransaction({ collectionAddress, buyerWallet, name, uri, attributes }) {
  const umi = await getUmi();
  const { generateSigner, publicKey, createNoopSigner } = await umiCore();
  const { create, fetchCollection } = await mplCore();

  const collection = await fetchCollection(umi, publicKey(collectionAddress));
  const asset = generateSigner(umi);
  // the buyer is the fee payer but is not here to sign — leave the slot open
  const buyer = createNoopSigner(publicKey(buyerWallet));

  const plugins = [];
  if (attributes && Object.keys(attributes).length) {
    plugins.push({
      type: "Attributes",
      attributeList: Object.entries(attributes).map(([key, value]) => ({
        key: String(key).slice(0, 32), value: String(value).slice(0, 64),
      })),
    });
  }

  const builder = create(umi, {
    asset,
    collection,
    name: String(name || "Copy").slice(0, 32),
    uri: String(uri || ""),
    owner: publicKey(buyerWallet),
    payer: buyer,
    authority: umi.identity,
    plugins,
  });

  // Take the blockhash explicitly so we can hand its expiry back to the client,
  // the same shape lib/paymulti.js already returns for $DROP and USDC payments.
  const latest = await umi.rpc.getLatestBlockhash();
  const built = await builder.setFeePayer(buyer).setBlockhash(latest).build(umi);

  // Sign ONLY with the keys we hold. The fee payer's slot is the one signature
  // we must never produce — that is the buyer consenting to spend their SOL.
  let tx = built;
  for (const signer of [asset, umi.identity]) tx = await signer.signTransaction(tx);

  return {
    transaction: Buffer.from(umi.transactions.serialize(tx)).toString("base64"),
    assetAddress: String(asset.publicKey),
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    // what the buyer's wallet is about to be charged, so checkout can say so
    estimatedCostSol: RENT_PER_COPY_SOL,
  };
}

// ---------------------------------------------------------------------------
// VERIFY — the buyer says they minted; check the chain, not their word.
//
// Confirms the asset exists, belongs to the collection we expect, and is owned
// by the wallet that paid. Anything less and a buyer could report a signature
// for someone else's mint.
// ---------------------------------------------------------------------------
export async function verifyMint({ assetAddress, collectionAddress, buyerWallet }) {
  const umi = await getUmi();
  const { publicKey } = await umiCore();
  const { fetchAsset } = await mplCore();

  let asset;
  try {
    asset = await fetchAsset(umi, publicKey(assetAddress));
  } catch (e) {
    return { ok: false, reason: "asset not found on-chain yet" };
  }

  const owner = String(asset.owner);
  if (owner !== String(buyerWallet)) {
    return { ok: false, reason: `asset is owned by ${owner}, not the buyer`, owner };
  }

  const belongs = asset.updateAuthority &&
    String(asset.updateAuthority.address || asset.updateAuthority) === String(collectionAddress);
  if (!belongs) {
    return { ok: false, reason: "asset does not belong to this game's collection", owner };
  }

  return { ok: true, owner };
}

// ---------------------------------------------------------------------------
// OWNERSHIP — the play gate's predicate.
//
// Reads live owner state, so a copy sold five minutes ago fails here even though
// our database still remembers the old owner. That is the point: resale revokes
// access without anyone having to revoke anything.
// ---------------------------------------------------------------------------
export async function ownerOf(assetAddress) {
  const umi = await getUmi();
  const { publicKey } = await umiCore();
  const { fetchAsset } = await mplCore();
  try {
    const asset = await fetchAsset(umi, publicKey(assetAddress));
    return String(asset.owner);
  } catch {
    return null;
  }
}

/* True if `wallet` still holds at least one of the copies we minted them.
   Checked newest-first: a buyer with several copies usually still holds the
   most recent, so the common case costs one RPC call. */
export async function walletStillOwns(assetAddresses, wallet) {
  const want = String(wallet);
  for (const addr of assetAddresses) {
    if ((await ownerOf(addr)) === want) return { owns: true, asset: addr };
  }
  return { owns: false, asset: null };
}
