// ============================================================================
// DROPRATE — buying a native game, and the copy that proves you own it.
//
// The Steam-key market sells a SECRET (a code, revealed once). This sells an
// ASSET: an on-chain Core copy in the buyer's own wallet, which they keep,
// resell, and carry to any venue that will trade it. Different thing, so it gets
// its own tables rather than being bent into dev_orders.
//
// THE STATE MACHINE
//   created  -> a copy slot is claimed and a price is locked. Nothing paid yet.
//   paid     -> the buyer's transfer is found on-chain and bound to this order.
//   minting  -> a mint transaction has been handed out; we're waiting on chain.
//   complete -> the copy exists and the buyer owns it. Terminal.
//   expired / failed -> the claimed slot is released back to supply.
//
// WHY A CLAIMED SLOT, NOT A LOCKED KEY
//   There is no inventory to lock — a finite run is a counter, not a shelf of
//   codes. So "claiming" is an atomic conditional increment of minted_count that
//   refuses to pass supply_cap. Two buyers racing for the last copy: one UPDATE
//   matches, one doesn't. The loser gets a clean 409 instead of an oversold game.
//   A slot that isn't paid for in time is released by the expiry sweep.
//
// WHY THE MINT IS A SEPARATE STEP FROM THE PAYMENT
//   They are two transactions signed by the buyer, and the second one can fail
//   for reasons that have nothing to do with the first (wallet closed, blockhash
//   expired, out of SOL for rent). Collapsing them would mean a buyer who paid
//   but never minted has no way back. Instead, payment is recorded permanently,
//   and native-buy-mint can be retried until it lands.
//
// Dispatched from lib/nativemarket.js for any action starting "native-buy-",
// plus "native-owns". That in turn arrives via ns:"devmarket" -> devmarket() ->
// nativemarket(), so api/crate.js needs no change.
// ============================================================================

import { randomBytes } from "node:crypto";
import { sql } from "./db.js";
import { verifyWalletSignature } from "./vault.js";
import { currentDropUsd } from "./oracle.js";
import { buildDirectPaymentTx, findPaymentByReference, resolveWalletAta } from "./solana.js";
import { validateTransfer } from "./payment.js";
import {
  currentSolUsd, USDC_DECIMALS, SOL_DECIMALS,
  buildDirectPaymentMulti, findDirectPayment, resolveUsdcAta,
} from "./paymulti.js";
import {
  chainConfigured, createGameCollection, buildMintTransaction, verifyMint,
  ownerOf, walletStillOwns, MINT_COST_SOL,
} from "./chain.js";

const CCY = ["DROP", "USDC", "SOL"];
const DROP_DECIMALS = Number(process.env.DROP_DECIMALS || 6);
const SIG_TTL = Number(process.env.DEV_SIG_TTL_SEC || 300);
const QUOTE_TTL_SEC = Number(process.env.DEV_QUOTE_TTL_SEC || 900);   // 15m price lock
const BUYER_DROP_DISCOUNT_BPS = Number(process.env.DEV_BUYER_DROP_DISCOUNT_BPS || 500);

/* Platform fee on a native sale, by payout currency. $DROP is cheapest — that is
   the flywheel, same as the key marketplace.

   Defaults CHAIN to the key marketplace's own settings, so native and Steam-key
   sales charge the same thing unless you deliberately say otherwise. Two knobs
   quietly drifting apart is how a storefront ends up promising devs one number
   and paying them another.

   The buyer's $DROP discount is sized to the gap between these: 700 − 150 = 550
   bps, and the discount is 500. So a dev nets a hair MORE on a $DROP sale than a
   USDC one, the buyer pays less, and the treasury never subsidises either. Change
   one of these numbers without the other and that balance breaks. */
const NATIVE_FEE_BPS = {
  DROP: Number(process.env.NATIVE_FEE_BPS_DROP ?? process.env.DEV_FEE_BPS_DROP ?? 150), // 1.5%
  USDC: Number(process.env.NATIVE_FEE_BPS_USDC ?? process.env.DEV_FEE_BPS_USDC ?? 700), // 7%
  SOL: Number(process.env.NATIVE_FEE_BPS_SOL ?? process.env.DEV_FEE_BPS_SOL ?? 700),    // 7%
};
const feeBpsFor = (cur) => NATIVE_FEE_BPS[cur] ?? NATIVE_FEE_BPS.USDC;

const httpErr = (code, msg) => { const e = new Error(msg); e.status = code; throw e; };
const ccyDecimals = (cur) => (cur === "SOL" ? SOL_DECIMALS : cur === "USDC" ? USDC_DECIMALS : DROP_DECIMALS);

function quoteRaw(usd, cur, prices) {
  const unit = cur === "USDC" ? 1 : cur === "SOL" ? prices.sol : prices.drop;
  if (!unit) return null;
  return BigInt(Math.round((usd / unit) * Math.pow(10, ccyDecimals(cur))));
}

function requireTreasury() {
  const v = process.env.TREASURY_WALLET;
  if (!v) httpErr(500, "TREASURY_WALLET not set");
  return v;
}

// base58 of 32 random bytes — the Solana-Pay reference the buyer tags their
// transfer with, so we can find that exact payment on-chain later.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function makeReference() {
  const bytes = randomBytes(32);
  let zeros = 0; while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [0];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

// ---- signed-request auth (same contract as the rest of the dev market) -----
function assertSig(b) {
  const { wallet, message, signature } = b;
  if (!wallet || !message || !signature) httpErr(400, "wallet, message, signature required");
  if (!message.includes(`wallet:${wallet}`)) httpErr(401, "message/wallet mismatch");
  const m = /ts:(\d+)/.exec(message);
  const ts = m ? Number(m[1]) : 0;
  if (!ts || Math.abs(Date.now() / 1000 - ts) > SIG_TTL) httpErr(401, "signature expired — retry");
  let ok = false;
  try { ok = verifyWalletSignature(message, String(signature), wallet); } catch { ok = false; }
  if (!ok) httpErr(401, "signature verification failed");
  return wallet;
}

// ---- schema ----------------------------------------------------------------
let migrated = false;
async function migrateBuy() {
  if (migrated) return;                       // once per warm lambda, not per call
  await sql`ALTER TABLE dev_native_products ADD COLUMN IF NOT EXISTS collection_address text`;
  await sql`ALTER TABLE dev_native_products ADD COLUMN IF NOT EXISTS collection_at timestamptz`;

  await sql`CREATE TABLE IF NOT EXISTS dev_native_orders(
    id serial PRIMARY KEY,
    product_id int NOT NULL REFERENCES dev_native_products(id),
    seller_id int NOT NULL,
    buyer text NOT NULL,                       -- wallet that will own the copy
    pay_currency text NOT NULL,
    price_cents int NOT NULL,
    pay_amount_raw text NOT NULL,
    pay_decimals int NOT NULL,
    payout_amount_raw text NOT NULL,           -- net of platform fee, owed to the dev
    fee_bps int NOT NULL,
    reference text NOT NULL,
    status text NOT NULL DEFAULT 'created',    -- created|paid|minting|complete|expired|failed
    copy_number int NOT NULL,                  -- which copy of the run this is
    paid_sig text,
    asset_address text,                        -- the Core asset, once minted
    mint_sig text,
    quote_expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    paid_at timestamptz,
    minted_at timestamptz
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_nord_buyer ON dev_native_orders(buyer)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_nord_product ON dev_native_orders(product_id)`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_nord_ref ON dev_native_orders(reference)`;
  /* One on-chain payment settles exactly one order. Without this a buyer could
     submit the same signature against two orders and get two copies for one. */
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_nord_paidsig
    ON dev_native_orders(paid_sig) WHERE paid_sig IS NOT NULL`;

  await sql`CREATE TABLE IF NOT EXISTS dev_native_copies(
    id serial PRIMARY KEY,
    product_id int NOT NULL REFERENCES dev_native_products(id),
    order_id int NOT NULL REFERENCES dev_native_orders(id),
    asset_address text NOT NULL,
    collection_address text NOT NULL,
    first_owner text NOT NULL,                 -- who bought it; NOT who owns it now
    copy_number int NOT NULL,
    minted_at timestamptz NOT NULL DEFAULT now()
  )`;
  /* The asset address is the identity of a copy. A duplicate means we tried to
     record the same mint twice, which must fail rather than double-count. */
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_ncopy_asset ON dev_native_copies(asset_address)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ncopy_owner ON dev_native_copies(first_owner)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ncopy_product ON dev_native_copies(product_id)`;
  migrated = true;
}

/* Release slots claimed by orders that were never paid for. Runs opportunistically
   on buy-open, which is the only moment anyone is competing for supply — so a
   sold-out finite run frees itself up the instant somebody tries to buy. */
async function sweepExpired(productId) {
  const dead = await sql`
    UPDATE dev_native_orders SET status = 'expired'
    WHERE product_id = ${productId} AND status = 'created' AND quote_expires_at < now()
    RETURNING id`;
  if (dead.rows.length) {
    await sql`UPDATE dev_native_products
      SET minted_count = GREATEST(0, minted_count - ${dead.rows.length})
      WHERE id = ${productId}`;
  }
  return dead.rows.length;
}

/* Atomically take one copy from the run. Returns the copy number, or null when
   the game is sold out / not purchasable. The WHERE clause is the lock: two
   concurrent claims on the last copy cannot both match. */
async function claimCopy(productId) {
  const r = await sql`
    UPDATE dev_native_products
    SET minted_count = minted_count + 1, updated_at = now()
    WHERE id = ${productId}
      AND active = true AND deleted = false AND review_status = 'approved'
      AND (supply_model <> 'finite' OR supply_cap IS NULL OR minted_count < supply_cap)
    RETURNING minted_count`;
  return r.rows.length ? Number(r.rows[0].minted_count) : null;
}
async function releaseCopy(productId) {
  await sql`UPDATE dev_native_products
    SET minted_count = GREATEST(0, minted_count - 1) WHERE id = ${productId}`;
}

// ---------------------------------------------------------------------------
// COLLECTION — created lazily, the first time a copy of a game is bought.
//
// Deliberately not at approval time: a game that never sells shouldn't cost
// DropRate $0.19, and doing it here means the cost is only ever incurred
// alongside revenue. Idempotent — a second caller reuses the stored address.
// ---------------------------------------------------------------------------
async function ensureCollection(product) {
  if (product.collection_address) return product.collection_address;
  if (!chainConfigured()) httpErr(503, "on-chain ownership is not configured on this deployment");

  const seller = await sql`SELECT wallet FROM dev_sellers WHERE id = ${product.seller_id}`;
  const payout = seller.rows[0]?.wallet;
  if (!payout) httpErr(500, "developer has no payout wallet on file");

  const { collection } = await createGameCollection({
    name: product.title,
    uri: product.image && /^https?:\/\//i.test(product.image) ? product.image : "",
    royaltyBps: Number(product.royalty_bps || 0),
    payoutWallet: payout,
    denyList: [],                   // default-allow; see the ownership standard
  });

  /* Only the first writer wins. If two buyers raced and both created one, the
     loser's collection is simply orphaned rather than overwriting a live one
     that copies may already point at. */
  const w = await sql`
    UPDATE dev_native_products SET collection_address = ${collection}, collection_at = now()
    WHERE id = ${product.id} AND collection_address IS NULL
    RETURNING collection_address`;
  if (w.rows.length) return collection;
  const cur = await sql`SELECT collection_address FROM dev_native_products WHERE id = ${product.id}`;
  return cur.rows[0].collection_address;
}

async function loadProduct(pid) {
  const r = await sql`
    SELECT p.*, s.status AS seller_status, s.wallet AS seller_wallet, s.accepted_currencies
    FROM dev_native_products p JOIN dev_sellers s ON s.id = p.seller_id
    WHERE p.id = ${pid}`;
  return r.rows[0] || null;
}

const availableOf = (p) => p.supply_model === "finite"
  ? Math.max(0, (Number(p.supply_cap) || 0) - (Number(p.minted_count) || 0))
  : null;

// ---------------------------------------------------------------------------
// OWNERSHIP — the play gate's question, answered against the chain.
//
// We look up the copies we minted this wallet, then ask the chain who owns each
// one NOW. A copy sold an hour ago fails here even though our row still names
// the old buyer. That is exactly what makes resale revoke access with nobody
// revoking anything: the next play token is simply refused.
// ---------------------------------------------------------------------------
export async function walletOwnsCopy(productId, wallet) {
  if (!wallet || !chainConfigured()) return { owns: false, asset: null };
  const r = await sql`
    SELECT asset_address FROM dev_native_copies
    WHERE product_id = ${productId} AND first_owner = ${wallet}
    ORDER BY minted_at DESC LIMIT 12`;
  if (!r.rows.length) return { owns: false, asset: null };
  return walletStillOwns(r.rows.map((x) => x.asset_address), wallet);
}

// ---------------------------------------------------------------------------
export async function nativebuy(req, res, action, b) {
  await migrateBuy();

  // ---- QUOTE: what does this cost, and is there one left? ------------------
  if (action === "native-buy-quote") {
    const p = await loadProduct(Number(b.product_id));
    if (!p || !p.active || p.deleted || p.review_status !== "approved" || p.seller_status !== "approved") {
      return res.status(404).json({ error: "not available" });
    }
    const [dropUsd, solUsd] = await Promise.all([
      currentDropUsd().catch(() => null),
      currentSolUsd().catch(() => null),
    ]);
    const usd = p.price_cents / 100;
    const prices = { drop: dropUsd, sol: solUsd };
    const quotes = {};
    for (const cur of CCY) {
      const effUsd = cur === "DROP" ? usd * (1 - BUYER_DROP_DISCOUNT_BPS / 10000) : usd;
      const raw = quoteRaw(effUsd, cur, prices);
      if (raw != null && raw > 0n) {
        quotes[cur] = { amount_raw: raw.toString(), decimals: ccyDecimals(cur), usd: Number(effUsd.toFixed(4)) };
      }
    }
    return res.status(200).json({
      ok: true, title: p.title, price_cents: p.price_cents,
      supply_model: p.supply_model, available: availableOf(p),
      quotes,
      // The buyer pays this on top, in SOL, for the copy's on-chain rent. Say it
      // at quote time — a surprise wallet debit at signing reads as sketchy.
      network_fee_sol: MINT_COST_SOL,
      drop_discount_bps: BUYER_DROP_DISCOUNT_BPS,
    });
  }

  // ---- OPEN: claim a copy, lock a price, open the order --------------------
  if (action === "native-buy-open") {
    const buyer = String(b.buyer || "").trim();
    if (!buyer) return res.status(400).json({ error: "buyer wallet required" });
    const pid = Number(b.product_id);
    const cur = CCY.includes(b.pay_currency) ? b.pay_currency : "DROP";

    const p = await loadProduct(pid);
    if (!p || !p.active || p.deleted || p.review_status !== "approved" || p.seller_status !== "approved") {
      return res.status(404).json({ error: "not available" });
    }
    const accepted = p.accepted_currencies || CCY;
    if (!accepted.includes(cur)) return res.status(400).json({ error: `this developer doesn't accept ${cur}` });
    if (!chainConfigured()) return res.status(503).json({ error: "purchases are temporarily unavailable" });

    await sweepExpired(pid);

    const dropUsd = cur === "DROP" ? await currentDropUsd().catch(() => null) : null;
    const solUsd = cur === "SOL" ? await currentSolUsd().catch(() => null) : null;
    if (cur === "DROP" && !dropUsd) return res.status(503).json({ error: "price feed unavailable — try again" });
    if (cur === "SOL" && !solUsd) return res.status(503).json({ error: "SOL price feed unavailable — try again" });

    const usd = p.price_cents / 100;
    const effUsd = cur === "DROP" ? usd * (1 - BUYER_DROP_DISCOUNT_BPS / 10000) : usd;
    const grossRaw = quoteRaw(effUsd, cur, { drop: dropUsd, sol: solUsd });
    if (grossRaw == null || grossRaw <= 0n) return res.status(503).json({ error: "could not price this order — try again" });

    const feeBps = feeBpsFor(cur);
    const netRaw = grossRaw - (grossRaw * BigInt(feeBps)) / 10000n;

    // the collection must exist before anyone can own a copy of this game
    let collection;
    try { collection = await ensureCollection(p); }
    catch (e) { return res.status(e.status || 500).json({ error: e.message }); }

    const copyNumber = await claimCopy(pid);
    if (copyNumber == null) return res.status(409).json({ error: "sold out" });

    const reference = makeReference();
    const expires = new Date(Date.now() + QUOTE_TTL_SEC * 1000).toISOString();
    let order;
    try {
      order = await sql`
        INSERT INTO dev_native_orders(product_id, seller_id, buyer, pay_currency, price_cents,
          pay_amount_raw, pay_decimals, payout_amount_raw, fee_bps, reference, status, copy_number, quote_expires_at)
        VALUES (${pid}, ${p.seller_id}, ${buyer}, ${cur}, ${p.price_cents},
          ${grossRaw.toString()}, ${ccyDecimals(cur)}, ${netRaw.toString()}, ${feeBps}, ${reference},
          'created', ${copyNumber}, ${expires})
        RETURNING id`;
    } catch (e) {
      await releaseCopy(pid);         // never leak a slot on a failed insert
      throw e;
    }

    return res.status(200).json({
      ok: true, order_id: order.rows[0].id, reference, treasury: requireTreasury(),
      pay_currency: cur, pay_amount_raw: grossRaw.toString(), decimals: ccyDecimals(cur),
      copy_number: copyNumber, collection, expires_at: expires, title: p.title,
      network_fee_sol: MINT_COST_SOL,
    });
  }

  // ---- BUILDPAY: the buyer-signed transfer to the treasury ------------------
  if (action === "native-buy-buildpay") {
    const r = await sql`SELECT * FROM dev_native_orders WHERE id = ${Number(b.order_id)}`;
    const o = r.rows[0];
    if (!o) return res.status(404).json({ error: "order not found" });
    if (o.status !== "created") return res.status(409).json({ error: `order is ${o.status}` });
    if (new Date(o.quote_expires_at).getTime() < Date.now()) {
      return res.status(410).json({ error: "quote expired — start again" });
    }
    const payer = String(b.payer || o.buyer);
    const built = o.pay_currency === "DROP"
      ? await buildDirectPaymentTx(payer, o.reference, requireTreasury(), o.pay_amount_raw)
      : await buildDirectPaymentMulti(payer, o.reference, requireTreasury(), o.pay_amount_raw, o.pay_currency);
    return res.status(200).json({ ok: true, ...built });
  }

  // ---- VERIFY: find the payment on-chain and bind it to this order ----------
  if (action === "native-buy-verify") {
    const r = await sql`SELECT * FROM dev_native_orders WHERE id = ${Number(b.order_id)}`;
    const o = r.rows[0];
    if (!o) return res.status(404).json({ error: "order not found" });
    if (o.status === "complete") return res.status(200).json({ ok: true, state: "complete" });
    if (o.status !== "created" && o.status !== "paid") return res.status(409).json({ error: `order is ${o.status}` });
    if (o.status === "paid") return res.status(200).json({ ok: true, state: "paid", order_id: o.id });

    let found, sender;
    if (o.pay_currency === "DROP") {
      found = await findPaymentByReference(o.reference);
      if (!found) return res.status(402).json({ error: "payment-not-found" });
      const treasuryAta = await resolveWalletAta(requireTreasury());
      const leg = (found.legs || [])
        .filter((l) => String(l.destination) === String(treasuryAta))
        .reduce((a, l) => a + BigInt(l.amountRaw), 0n);
      const v = validateTransfer(
        { mint: found.mint, destination: treasuryAta, amountRaw: leg.toString(), reference: o.reference, sender: found.sender },
        { mint: process.env.DROP_MINT, destination: treasuryAta, amountRaw: String(o.pay_amount_raw),
          reference: o.reference, expiresAt: new Date(o.quote_expires_at).getTime() + 3600000 },
        { nowMs: Date.now(), underpayToleranceBps: 0 }
      );
      if (!v.ok) return res.status(400).json({ error: "invalid-payment", reasons: v.reasons });
      sender = found.sender;
    } else {
      found = await findDirectPayment(o.reference, o.pay_currency);
      if (!found) return res.status(402).json({ error: "payment-not-found" });
      const dest = o.pay_currency === "SOL" ? requireTreasury() : await resolveUsdcAta(requireTreasury());
      const paid = (found.legs || [])
        .filter((l) => String(l.destination) === String(dest))
        .reduce((a, l) => a + BigInt(l.amountRaw), 0n);
      if (paid < BigInt(o.pay_amount_raw)) {
        return res.status(400).json({ error: "invalid-payment", reasons: ["underpaid or wrong destination"] });
      }
      sender = found.sender;
    }

    // the unique index on paid_sig is what stops one payment settling two orders
    try {
      const bound = await sql`
        UPDATE dev_native_orders
        SET status = 'paid', paid_sig = ${found.signature}, paid_at = now(),
            buyer = ${sender || o.buyer}
        WHERE id = ${o.id} AND paid_sig IS NULL
        RETURNING id`;
      if (!bound.rows.length) return res.status(409).json({ error: "order already settled" });
    } catch {
      return res.status(409).json({ error: "payment-already-used" });
    }

    return res.status(200).json({ ok: true, state: "paid", order_id: o.id });
  }

  // ---- MINT: hand the buyer an unsigned mint they can sign anywhere ---------
  // Retryable by design. Every call issues a fresh transaction with a fresh
  // asset address, so a buyer whose wallet died mid-signature just asks again.
  if (action === "native-buy-mint") {
    const r = await sql`SELECT * FROM dev_native_orders WHERE id = ${Number(b.order_id)}`;
    const o = r.rows[0];
    if (!o) return res.status(404).json({ error: "order not found" });
    if (o.status === "complete") {
      return res.status(409).json({ error: "this copy is already minted", asset: o.asset_address });
    }
    if (o.status !== "paid" && o.status !== "minting") {
      return res.status(409).json({ error: `order is ${o.status} — pay first` });
    }
    const p = await loadProduct(o.product_id);
    if (!p?.collection_address) return res.status(500).json({ error: "this game has no collection" });

    const built = await buildMintTransaction({
      collectionAddress: p.collection_address,
      buyerWallet: o.buyer,
      name: `${p.title} #${o.copy_number}`.slice(0, 32),
      uri: p.image && /^https?:\/\//i.test(p.image) ? p.image : "",
      attributes: {
        copy: String(o.copy_number),
        edition: p.supply_model === "finite" ? String(p.supply_cap) : "open",
        build: String(p.bundle_version || 0),
      },
    });

    await sql`UPDATE dev_native_orders SET status = 'minting', asset_address = ${built.assetAddress}
      WHERE id = ${o.id}`;

    return res.status(200).json({
      ok: true, order_id: o.id,
      transaction: built.transaction,          // base64, partially signed
      versioned: built.versioned,              // tells the client how to decode it
      asset_address: built.assetAddress,
      blockhash: built.blockhash,
      last_valid_block_height: built.lastValidBlockHeight,
      network_fee_sol: built.estimatedCostSol,
    });
  }

  // ---- CONFIRM: check the chain, then record the copy ----------------------
  if (action === "native-buy-confirm") {
    const r = await sql`SELECT * FROM dev_native_orders WHERE id = ${Number(b.order_id)}`;
    const o = r.rows[0];
    if (!o) return res.status(404).json({ error: "order not found" });
    if (o.status === "complete") {
      return res.status(200).json({ ok: true, state: "complete", asset_address: o.asset_address });
    }
    if (o.status !== "minting") return res.status(409).json({ error: `order is ${o.status}` });

    const asset = String(b.asset_address || o.asset_address || "");
    if (!asset) return res.status(400).json({ error: "asset_address required" });

    const p = await loadProduct(o.product_id);
    const check = await verifyMint({
      assetAddress: asset,
      collectionAddress: p.collection_address,
      buyerWallet: o.buyer,
    });
    // Not an error the buyer caused — the chain may simply not have caught up.
    if (!check.ok) return res.status(202).json({ ok: false, state: "minting", reason: check.reason });

    try {
      await sql`
        INSERT INTO dev_native_copies(product_id, order_id, asset_address, collection_address, first_owner, copy_number)
        VALUES (${o.product_id}, ${o.id}, ${asset}, ${p.collection_address}, ${o.buyer}, ${o.copy_number})`;
    } catch {
      return res.status(409).json({ error: "this copy is already recorded" });
    }
    await sql`UPDATE dev_native_orders
      SET status = 'complete', asset_address = ${asset}, mint_sig = ${b.mint_sig || null}, minted_at = now()
      WHERE id = ${o.id}`;

    return res.status(200).json({ ok: true, state: "complete", asset_address: asset, copy_number: o.copy_number });
  }

  // ---- LIBRARY: what this wallet owns, checked against the chain ------------
  if (action === "native-buy-library") {
    const wallet = assertSig(b);
    const rows = await sql`
      SELECT c.asset_address, c.copy_number, c.minted_at, p.id AS product_id, p.title, p.slug, p.image, p.runtime
      FROM dev_native_copies c JOIN dev_native_products p ON p.id = c.product_id
      WHERE c.first_owner = ${wallet} ORDER BY c.minted_at DESC LIMIT 100`;
    const out = [];
    for (const row of rows.rows) {
      const owner = await ownerOf(row.asset_address);
      out.push({ ...row, still_owned: owner === wallet, current_owner: owner });
    }
    return res.status(200).json({ ok: true, copies: out });
  }

  // ---- OWNS: the gate predicate, exposed for the player page ----------------
  if (action === "native-owns") {
    const wallet = assertSig(b);
    const r = await walletOwnsCopy(Number(b.product_id), wallet);
    return res.status(200).json({ ok: true, owns: r.owns, asset: r.asset });
  }

  return res.status(400).json({ error: `unknown action ${action}` });
}
