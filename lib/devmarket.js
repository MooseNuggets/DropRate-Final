// ============================================================================
// DROPRATE — Developer Key Marketplace (Phase 1, crypto rails: $DROP / USDC / SOL)
//
// A first-party storefront where VERIFIED developers consign their own Steam keys
// and DropRate custodies both the keys and the money until a trade is proven good.
// This file is the foundation: seller onboarding, encrypted + globally-deduped key
// ingest, product listing, and the public browse feed. The escrow order engine
// (buy -> hold -> deliver/reveal -> confirm/dispute -> payout) lands in a second
// pass and reuses these same tables + the treasury escrow we built for won keys.
//
// SECURITY POSTURE (the whole point of this product):
//  - Keys are envelope-encrypted at ingest (lib/vault.encryptCode). ONLY ciphertext
//    is ever stored. A full DB leak yields blobs, not keys.
//  - Every key is salted-hashed into a GLOBAL UNIQUE index. The same key can never
//    be listed or sold twice, platform-wide; duplicate uploads are rejected on sight.
//  - Plaintext is decrypted exactly once, at delivery, to the paying buyer only
//    (that path lives in the order engine). It is never logged, never bulk-exported.
//  - Admins never see a whole key — inventory surfaces masked (····-····-A7X4).
//  - Only admin-approved sellers can list. Onboarding is apply + manual review.
//
// Required env: CODE_VAULT_KEY (key encryption), KEY_HASH_SALT (dedup hashing),
// ADMIN_SECRET (admin review), DROP_DECIMALS (default 6). Oracle via lib/oracle.js.
// ============================================================================
import { createHash, randomBytes } from "node:crypto";
import { sql } from "./db.js";
import { encryptCode, decryptCode, verifyWalletSignature } from "./vault.js";
import { currentDropUsd } from "./oracle.js";
import { buildDirectPaymentTx, findPaymentByReference, resolveWalletAta, sendTreasuryTransfer } from "./solana.js";
import { validateTransfer } from "./payment.js";
import { currentSolUsd, USDC_DECIMALS, SOL_DECIMALS, buildDirectPaymentMulti, findDirectPayment, sendTreasuryMulti, resolveUsdcAta } from "./paymulti.js";

const DECIMALS = Number(process.env.DROP_DECIMALS || 6);
// The three accepted rails. $DROP is preferred (lowest fee + buyer discount);
// USDC/SOL settle same-currency so the treasury carries no FX risk on open orders.
const CCY = ["DROP", "USDC", "SOL"];
function ccyDecimals(cur) { return cur === "SOL" ? SOL_DECIMALS : cur === "USDC" ? USDC_DECIMALS : DECIMALS; }
// USD -> base-unit amount for a currency, given live per-unit USD prices.
// Returns null if the needed price is missing.
function quoteRaw(usd, cur, prices) {
  const unit = cur === "USDC" ? 1 : cur === "SOL" ? prices.sol : prices.drop;
  if (!unit) return null;
  return BigInt(Math.round((usd / unit) * Math.pow(10, ccyDecimals(cur))));
}
const SIG_TTL = 300; // seconds a signed seller action stays valid
const PAYOUT_CCYS = ["DROP", "USDC", "SOL"];
// Cap on an image field (URL or resized data: URL). ~3MB of text keeps a
// client-resized JPEG comfortably in bounds while rejecting raw multi-MB dumps.
const MAX_IMG_CHARS = 3_000_000;
const MAX_BIO_CHARS = 2000;
const MAX_DESC_CHARS = 6000;
const MAX_MEDIA = 8;     // gallery images per product
const MAX_VIDEOS = 6;    // trailer/video links per product

// Clean an incoming gallery array: strings only, each within the image cap,
// capped at MAX_MEDIA entries. Accepts data: URLs (resized client-side) or http URLs.
function cleanMedia(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter((x) => typeof x === "string" && x && x.length <= MAX_IMG_CHARS).slice(0, MAX_MEDIA);
}
// Clean video links: http(s) URLs only, deduped, capped. No file bytes here —
// file uploads land later once object storage exists; this stores the resulting URL.
function cleanVideos(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr) {
    const s = String(x || "").trim();
    if (/^https?:\/\/[^\s]{4,500}$/i.test(s) && !out.includes(s)) out.push(s);
    if (out.length >= MAX_VIDEOS) break;
  }
  return out;
}
// Clean a dev's accepted-currency list to a valid non-empty subset of CCY.
// Returns null when nothing valid was provided (caller keeps the existing value).
function cleanAccepted(arr) {
  if (!Array.isArray(arr)) return null;
  const out = [...new Set(arr.filter((c) => CCY.includes(c)))];
  return out.length ? out : null;
}

// Fee taken from the dev's proceeds, by PAYOUT currency (bps). $DROP is cheapest —
// that's the flywheel. Fiat (500) arrives in a later phase. All env-overridable.
const FEE_BPS = {
  DROP: Number(process.env.DEV_FEE_BPS_DROP || 150), // 1.5%
  USDC: Number(process.env.DEV_FEE_BPS_USDC || 400), // 4%
  SOL:  Number(process.env.DEV_FEE_BPS_SOL  || 400), // 4%
};
// Buyer-side incentive: paying in $DROP shaves this off the price (funded as a
// $DROP-demand mechanism, NOT out of the dev's cut). Preview shown on the market.
const BUYER_DROP_DISCOUNT_BPS = Number(process.env.DEV_BUYER_DROP_DISCOUNT_BPS || 500); // 5%

// Escrow timing. The dev's payout is held for the buyer's dispute window; the
// buyer's price quote is only locked for a short window before it must be re-quoted.
const HOLD_SECONDS  = Number(process.env.DEV_HOLD_SECONDS  || 259200); // 72h dispute window
const QUOTE_TTL_SEC = Number(process.env.DEV_QUOTE_TTL_SEC || 900);    // 15m quote lock

const httpErr = (code, msg) => { const e = new Error(msg); e.http = code; throw e; };
function requireTreasury() { const v = process.env.TREASURY_WALLET; if (!v) httpErr(500, "TREASURY_WALLET not set"); return v; }

// Self-contained Solana-Pay reference (base58 of 32 random bytes) — the buyer tags
// their escrow transfer with it so we can find the exact payment on-chain. Inlined
// (same approach as api/crate.js) so this route never depends on payment.js exports.
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
  for (let k = digits.length - 1; k >= 0; k--) out += B58[digits[k]];
  return out;
}

// ---- Steam key normalization + hashing -------------------------------------
// Canonical Steam CD key = 15 alphanumerics rendered XXXXX-XXXXX-XXXXX. We strip
// to the 15 alnum for hashing/dedup so "abcde-fghij-klmno" and "ABCDEFGHIJKLMNO"
// collide, and re-render the pretty form for storage/reveal.
function normalizeKey(raw) { return String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }
function keyFormatOk(norm) { return /^[A-Z0-9]{15}$/.test(norm); }
function prettyKey(norm) { return norm.slice(0, 5) + "-" + norm.slice(5, 10) + "-" + norm.slice(10, 15); }
function maskKey(norm) { return "····-····-" + norm.slice(-4); }
// Salted so a stolen DB can't be rainbow-tabled back to keys, and so the hash is
// useless without KEY_HASH_SALT. Global unique index is built on this value.
function keyHash(norm) {
  return createHash("sha256").update(String(process.env.KEY_HASH_SALT || "") + ":" + norm).digest("hex");
}

// ---- seller signature gate --------------------------------------------------
// Seller identity IS their Solana wallet (same wallet receives crypto payouts),
// proven per-action by a signed message — the same model as history/reveal.
// Expected message shape: "DROPRATE devmarket <action> wallet:<wallet> ts:<unix>"
function assertSig(body) {
  const { wallet, message, signature } = body;
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
async function getSeller(wallet) {
  const r = await sql`SELECT * FROM dev_sellers WHERE wallet = ${wallet}`;
  return r.rows[0] || null;
}
async function requireApprovedSeller(body) {
  const wallet = assertSig(body);
  const seller = await getSeller(wallet);
  if (!seller) httpErr(403, "not a registered seller — apply first");
  if (seller.status === "suspended") httpErr(403, "seller suspended");
  if (seller.status !== "approved") httpErr(403, `seller ${seller.status} — awaiting approval`);
  return seller;
}
async function audit(kind, actor, meta, orderId = null, keyId = null) {
  try {
    await sql`INSERT INTO dev_audit(kind, actor, order_id, key_id, meta)
              VALUES (${kind}, ${actor}, ${orderId}, ${keyId}, ${JSON.stringify(meta || {})})`;
  } catch { /* audit must never break the request */ }
}

// Email the admin when a dev applies. Env-gated (Resend): set RESEND_API_KEY +
// ALERT_EMAIL_TO to enable. If unset, this silently no-ops — the application
// still lands in the admin portal's Dev Portal tab regardless. Never throws.
async function notifyNewApplication(s) {
  const key = process.env.RESEND_API_KEY, to = process.env.ALERT_EMAIL_TO;
  const from = process.env.ALERT_EMAIL_FROM || "DropRate <onboarding@resend.dev>";
  if (!key || !to) return;
  try {
    const text = [
      `New developer application on DropRate.`, ``,
      `Studio:        ${s.studio || "—"}`,
      `Wallet:        ${s.wallet}`,
      `Contact email: ${s.contact || "—"}`,
      `Socials:       ${s.socials || "—"}`,
      `Website:       ${s.website || "—"}`,
      `Steam App IDs: ${s.steam_appids || "—"}`,
      `Payout:        ${s.payout_currency || "DROP"}`, ``,
      `Review it in the admin portal → Dev Portal tab (approve / reject there).`,
    ].join("\n");
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from, to: [to],
        subject: `New dev application — ${s.studio || s.wallet.slice(0, 8)}`,
        text,
      }),
    });
  } catch (e) { console.error("application email failed:", e.message); }
}

// ---- schema (idempotent) ----------------------------------------------------
async function migrate() {
  await sql`CREATE TABLE IF NOT EXISTS dev_sellers(
    id serial PRIMARY KEY,
    wallet text UNIQUE NOT NULL,
    studio text,
    contact text,
    website text,
    socials text,
    steam_appids text,
    payout_currency text NOT NULL DEFAULT 'DROP',
    status text NOT NULL DEFAULT 'pending',   -- pending | approved | rejected | suspended
    standing text NOT NULL DEFAULT 'new',      -- new | trusted  (drives holdback tier)
    dispute_count int NOT NULL DEFAULT 0,
    sold_count int NOT NULL DEFAULT 0,
    notes text,                                -- admin notes / rejection reason
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    reviewed_at timestamptz
  )`;
  await sql`ALTER TABLE dev_sellers ADD COLUMN IF NOT EXISTS socials text`;
  await sql`ALTER TABLE dev_sellers ADD COLUMN IF NOT EXISTS avatar text`;
  await sql`ALTER TABLE dev_sellers ADD COLUMN IF NOT EXISTS bio text`;
  await sql`ALTER TABLE dev_sellers ADD COLUMN IF NOT EXISTS accepted_currencies jsonb NOT NULL DEFAULT '["DROP","USDC","SOL"]'::jsonb`;
  await sql`CREATE TABLE IF NOT EXISTS dev_products(
    id serial PRIMARY KEY,
    seller_id int NOT NULL REFERENCES dev_sellers(id),
    title text NOT NULL,
    appid text,
    image text,
    edition text,
    region text NOT NULL DEFAULT 'GLOBAL',
    price_cents int NOT NULL,
    steam_price_cents int,                     -- for the Valve pricing-parity guardrail
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`ALTER TABLE dev_products ADD COLUMN IF NOT EXISTS deleted boolean NOT NULL DEFAULT false`;
  await sql`ALTER TABLE dev_products ADD COLUMN IF NOT EXISTS description text`;
  await sql`ALTER TABLE dev_products ADD COLUMN IF NOT EXISTS media jsonb NOT NULL DEFAULT '[]'::jsonb`;
  await sql`ALTER TABLE dev_products ADD COLUMN IF NOT EXISTS videos jsonb NOT NULL DEFAULT '[]'::jsonb`;
  await sql`CREATE TABLE IF NOT EXISTS dev_key_inventory(
    id serial PRIMARY KEY,
    product_id int NOT NULL REFERENCES dev_products(id),
    seller_id int NOT NULL REFERENCES dev_sellers(id),
    code_encrypted text NOT NULL,              -- envelope ciphertext ONLY, never plaintext
    key_hash text NOT NULL,                     -- salted sha256; global unique below
    last4 text,                                 -- for masked admin display
    status text NOT NULL DEFAULT 'available',   -- available | locked | sold | void
    order_id int,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_devkey_hash ON dev_key_inventory(key_hash)`;
  await sql`CREATE TABLE IF NOT EXISTS dev_orders(
    id serial PRIMARY KEY,
    product_id int NOT NULL REFERENCES dev_products(id),
    seller_id int NOT NULL REFERENCES dev_sellers(id),
    key_id int REFERENCES dev_key_inventory(id),
    buyer text NOT NULL,
    pay_currency text NOT NULL,                 -- DROP | USDC | SOL
    payout_currency text NOT NULL,              -- snapshot of seller's payout choice
    price_cents int NOT NULL,
    pay_amount_raw numeric,                      -- locked quote buyer pays (pay_currency base units)
    pay_decimals int,
    payout_amount_raw numeric,                   -- locked NET to seller after fee (payout_currency)
    fee_bps int NOT NULL,
    reference text NOT NULL,
    status text NOT NULL DEFAULT 'created',      -- created|paid|delivered|confirmed|released|disputed|refunded|expired
    hold_until timestamptz,
    quote_expires_at timestamptz,
    paid_sig text,
    payout_sig text,
    refund_sig text,
    delivered_at timestamptz,
    revealed_at timestamptz,
    released_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_devorder_paid_sig ON dev_orders(paid_sig) WHERE paid_sig IS NOT NULL`;
  await sql`CREATE TABLE IF NOT EXISTS dev_disputes(
    id serial PRIMARY KEY,
    order_id int NOT NULL REFERENCES dev_orders(id),
    buyer text NOT NULL,
    reason text,
    evidence text,
    status text NOT NULL DEFAULT 'open',         -- open | refunded | denied
    resolver text,
    created_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz
  )`;
  await sql`CREATE TABLE IF NOT EXISTS dev_payouts(
    id serial PRIMARY KEY,
    order_id int NOT NULL REFERENCES dev_orders(id),
    seller_id int NOT NULL REFERENCES dev_sellers(id),
    gross_raw numeric, fee_raw numeric, net_raw numeric,
    payout_currency text,
    rail text NOT NULL DEFAULT 'treasury',
    external_ref text,
    status text NOT NULL DEFAULT 'pending',      -- pending | sent | failed
    created_at timestamptz NOT NULL DEFAULT now(),
    sent_at timestamptz
  )`;
  await sql`CREATE TABLE IF NOT EXISTS dev_fx_settlements(
    id serial PRIMARY KEY,
    order_id int REFERENCES dev_orders(id),
    in_currency text, out_currency text,
    in_amount_raw numeric, out_amount_raw numeric,
    quote_source text, quoted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS dev_audit(
    id serial PRIMARY KEY,
    kind text NOT NULL,                          -- ingest|reveal|payout|dispute|seller-review|payout-dest-change
    actor text,
    order_id int,
    key_id int,
    meta jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
  // What the buyer OWNS = the Steam key. A plain, ONE-TIME, NON-transferable record
  // (this is also the buyer's library). There is deliberately NO NFT layer here:
  // wrapping a Steam key in an NFT is pointless and cheatable — a reseller can redeem
  // the key and still sell the token, and a redeemed key can never be clawed back.
  // The native-platform product is a SEPARATE model added later, with its own on-chain
  // ownership + launcher-enforced transfer; it will NOT share this table.
  await sql`CREATE TABLE IF NOT EXISTS dev_entitlements(
    id serial PRIMARY KEY,
    order_id int NOT NULL REFERENCES dev_orders(id),
    buyer text NOT NULL,
    product_id int NOT NULL REFERENCES dev_products(id),
    key_id int REFERENCES dev_key_inventory(id),
    kind text NOT NULL DEFAULT 'steam_key',
    revealed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_dev_entitlements_buyer ON dev_entitlements(buyer)`;
}

// Pay the dev their NET ($DROP) from the treasury; the fee stays in treasury as
// accumulated revenue. A one-shot status claim (delivered -> releasing) makes this
// idempotent so a buyer's early-confirm and the sweep can never double-pay.
async function releaseOrder(orderId) {
  const claim = await sql`UPDATE dev_orders SET status = 'releasing' WHERE id = ${orderId} AND status = 'delivered' RETURNING *`;
  if (!claim.rows.length) return { skipped: true };
  const o = claim.rows[0];
  const s = await sql`SELECT wallet FROM dev_sellers WHERE id = ${o.seller_id}`;
  const dest = s.rows[0]?.wallet;
  const net = String(o.payout_amount_raw);
  const feeRaw = String(BigInt(o.pay_amount_raw) - BigInt(o.payout_amount_raw));
  const cur = o.payout_currency || "DROP";
  try {
    const sig = cur === "DROP" ? await sendTreasuryTransfer(dest, net) : await sendTreasuryMulti(dest, net, cur);
    await sql`UPDATE dev_orders SET status = 'released', payout_sig = ${sig}, released_at = now() WHERE id = ${o.id}`;
    await sql`INSERT INTO dev_payouts(order_id, seller_id, gross_raw, fee_raw, net_raw, payout_currency, rail, external_ref, status, sent_at)
              VALUES (${o.id}, ${o.seller_id}, ${o.pay_amount_raw}, ${feeRaw}, ${net}, ${cur}, 'treasury', ${sig}, 'sent', now())`;
    await sql`UPDATE dev_sellers SET sold_count = sold_count + 1 WHERE id = ${o.seller_id}`;
    await audit("payout", dest, { order_id: o.id, net }, o.id);
    return { sent: true, sig };
  } catch (e) {
    // Revert to 'delivered' so the sweep re-attempts the payout later; no row written.
    await sql`UPDATE dev_orders SET status = 'delivered' WHERE id = ${o.id}`;
    console.error("dev payout deferred, will retry:", e.message);
    return { deferred: true };
  }
}

function feeBpsFor(cur) { return FEE_BPS[cur] ?? FEE_BPS.USDC; }

export async function devmarket(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    await migrate();
    const b = req.body ?? {};

    // ---- SELLER: apply / re-apply -----------------------------------------
    // Ties a wallet to a seller profile in `pending`. Re-applying updates the
    // profile; an approved seller stays approved, a rejected one returns to pending.
    if (b.action === "seller-apply") {
      const wallet = assertSig(b);
      const payout = PAYOUT_CCYS.includes(b.payout_currency) ? b.payout_currency : "DROP";
      const r = await sql`
        INSERT INTO dev_sellers(wallet, studio, contact, website, socials, steam_appids, payout_currency)
        VALUES (${wallet}, ${b.studio || null}, ${b.contact || null}, ${b.website || null},
                ${b.socials || null}, ${b.steam_appids || null}, ${payout})
        ON CONFLICT (wallet) DO UPDATE SET
          studio = EXCLUDED.studio, contact = EXCLUDED.contact, website = EXCLUDED.website,
          socials = EXCLUDED.socials,
          steam_appids = EXCLUDED.steam_appids, payout_currency = EXCLUDED.payout_currency,
          status = CASE WHEN dev_sellers.status = 'approved' THEN 'approved' ELSE 'pending' END,
          updated_at = now()
        RETURNING id, wallet, status, payout_currency`;
      // Email the admin (env-gated, non-blocking on failure). Fields come from the
      // submitted body since RETURNING keeps the payload lean.
      if (r.rows[0] && r.rows[0].status === "pending") {
        await notifyNewApplication({
          wallet, studio: b.studio, contact: b.contact, socials: b.socials,
          website: b.website, steam_appids: b.steam_appids, payout_currency: payout,
        });
      }
      return res.status(200).json({ ok: true, seller: r.rows[0] });
    }

    // ---- SELLER: my profile + products + inventory counts -----------------
    if (b.action === "seller-status") {
      const wallet = assertSig(b);
      const seller = await getSeller(wallet);
      if (!seller) return res.status(200).json({ ok: true, seller: null });
      const prods = await sql`
        SELECT p.id, p.title, p.appid, p.image, p.edition, p.region, p.price_cents,
               p.steam_price_cents, p.active, p.created_at, p.description, p.media, p.videos,
               count(k.id) FILTER (WHERE k.status = 'available') AS available,
               count(k.id) FILTER (WHERE k.status = 'sold')      AS sold
        FROM dev_products p LEFT JOIN dev_key_inventory k ON k.product_id = p.id
        WHERE p.seller_id = ${seller.id} AND p.deleted = false
        GROUP BY p.id
        ORDER BY p.created_at DESC`;
      return res.status(200).json({
        ok: true,
        seller: {
          wallet: seller.wallet, studio: seller.studio, status: seller.status,
          standing: seller.standing, payout_currency: seller.payout_currency,
          sold_count: seller.sold_count, dispute_count: seller.dispute_count,
          notes: seller.status === "rejected" ? seller.notes : null,
          contact: seller.contact, website: seller.website,
          socials: seller.socials, steam_appids: seller.steam_appids,
          avatar: seller.avatar, bio: seller.bio,
          accepted_currencies: seller.accepted_currencies || ["DROP", "USDC", "SOL"],
        },
        products: prods.rows,
      });
    }

    // ---- SELLER: edit own profile (self-service) --------------------------
    // A dev updating their own studio name, contact, website, socials, Steam IDs.
    // Never touches status or standing — only an admin can change those.
    if (b.action === "profile-set") {
      const wallet = assertSig(b);
      const seller = await getSeller(wallet);
      if (!seller) return res.status(404).json({ error: "no seller profile — apply first" });
      if (b.avatar && String(b.avatar).length > MAX_IMG_CHARS) return res.status(400).json({ error: "profile photo too large — use a smaller image" });
      const bio = b.bio != null ? String(b.bio).slice(0, MAX_BIO_CHARS) : null;
      const acc = cleanAccepted(b.accepted_currencies) || seller.accepted_currencies || ["DROP", "USDC", "SOL"];
      const r = await sql`
        UPDATE dev_sellers SET
          studio = ${b.studio || null}, contact = ${b.contact || null},
          website = ${b.website || null}, socials = ${b.socials || null},
          steam_appids = ${b.steam_appids || null}, avatar = ${b.avatar || null},
          bio = ${bio}, accepted_currencies = ${JSON.stringify(acc)}::jsonb, updated_at = now()
        WHERE wallet = ${wallet}
        RETURNING wallet, studio, contact, website, socials, steam_appids, avatar, bio, accepted_currencies`;
      await audit("profile-set", wallet, { studio: b.studio || null });
      return res.status(200).json({ ok: true, seller: r.rows[0] });
    }

    // ---- ADMIN: review a seller -------------------------------------------
    if (b.action === "seller-review") {
      if (req.headers.authorization !== `Bearer ${process.env.ADMIN_SECRET}`) {
        return res.status(401).json({ error: "unauthorized" });
      }
      const decision = String(b.decision || "");
      const map = { approve: "approved", reject: "rejected", suspend: "suspended", reinstate: "approved" };
      const status = map[decision];
      if (!status || !b.wallet) return res.status(400).json({ error: "wallet + valid decision required" });
      const r = await sql`
        UPDATE dev_sellers SET status = ${status}, notes = ${b.notes || null}, reviewed_at = now(), updated_at = now()
        WHERE wallet = ${b.wallet} RETURNING id, wallet, status`;
      if (!r.rows.length) return res.status(404).json({ error: "no such seller" });
      await audit("seller-review", "admin", { wallet: b.wallet, decision, status });
      return res.status(200).json({ ok: true, seller: r.rows[0] });
    }

    // ---- ADMIN: edit an existing seller's profile fields ------------------
    // Lets you fix or update a dev after approval (studio, contact, socials,
    // website, steam ids, payout rail, and standing/holdback tier). Status is
    // NOT touched here — use seller-review to approve/suspend/reject.
    if (b.action === "seller-edit") {
      if (req.headers.authorization !== `Bearer ${process.env.ADMIN_SECRET}`) {
        return res.status(401).json({ error: "unauthorized" });
      }
      if (!b.wallet) return res.status(400).json({ error: "wallet required" });
      const payout = PAYOUT_CCYS.includes(b.payout_currency) ? b.payout_currency : "DROP";
      const standing = b.standing === "trusted" ? "trusted" : "new";
      const acc = cleanAccepted(b.accepted_currencies);
      const r = await sql`
        UPDATE dev_sellers SET
          studio = ${b.studio || null}, contact = ${b.contact || null},
          website = ${b.website || null}, socials = ${b.socials || null},
          steam_appids = ${b.steam_appids || null}, payout_currency = ${payout},
          standing = ${standing},
          accepted_currencies = COALESCE(${acc ? JSON.stringify(acc) : null}::jsonb, accepted_currencies),
          updated_at = now()
        WHERE wallet = ${b.wallet}
        RETURNING id, wallet, status, standing`;
      if (!r.rows.length) return res.status(404).json({ error: "no such seller" });
      await audit("seller-edit", "admin", { wallet: b.wallet, standing, payout });
      return res.status(200).json({ ok: true, seller: r.rows[0] });
    }

    // ---- ADMIN: list sellers (for the review queue) -----------------------
    if (b.action === "seller-queue") {
      if (req.headers.authorization !== `Bearer ${process.env.ADMIN_SECRET}`) {
        return res.status(401).json({ error: "unauthorized" });
      }
      const rows = await sql`
        SELECT wallet, studio, contact, website, socials, steam_appids, payout_currency, status,
               standing, sold_count, dispute_count, created_at, reviewed_at
        FROM dev_sellers
        ORDER BY (status = 'pending') DESC, created_at DESC
        LIMIT 500`;
      return res.status(200).json({ ok: true, sellers: rows.rows });
    }

    // ---- SELLER: create a product -----------------------------------------
    if (b.action === "product-create") {
      const seller = await requireApprovedSeller(b);
      const title = String(b.title || "").trim();
      const cents = Math.round(Number(b.price_cents));
      if (!title) return res.status(400).json({ error: "title required" });
      if (!String(b.image || "").trim()) return res.status(400).json({ error: "cover image required" });
      if (String(b.image).length > MAX_IMG_CHARS) return res.status(400).json({ error: "cover image too large — use a smaller image" });
      if (!Number.isFinite(cents) || cents < 1 || cents > 100000000) {
        return res.status(400).json({ error: "price_cents must be a positive USD-cents amount" });
      }
      const steamCents = b.steam_price_cents != null ? Math.round(Number(b.steam_price_cents)) : null;
      const desc = b.description != null ? String(b.description).slice(0, MAX_DESC_CHARS) : null;
      const media = cleanMedia(b.media);
      const videos = cleanVideos(b.videos);
      const r = await sql`
        INSERT INTO dev_products(seller_id, title, appid, image, edition, region, price_cents, steam_price_cents, description, media, videos)
        VALUES (${seller.id}, ${title}, ${b.appid || null}, ${b.image || null}, ${b.edition || null},
                ${b.region || "GLOBAL"}, ${cents}, ${steamCents}, ${desc},
                ${JSON.stringify(media)}::jsonb, ${JSON.stringify(videos)}::jsonb)
        RETURNING id, title, price_cents, region, active`;
      return res.status(200).json({ ok: true, product: r.rows[0] });
    }

    // ---- SELLER: update a product (price / active / store page) -----------
    if (b.action === "product-set") {
      const seller = await requireApprovedSeller(b);
      const pid = Number(b.product_id);
      const own = await sql`SELECT id FROM dev_products WHERE id = ${pid} AND seller_id = ${seller.id}`;
      if (!own.rows.length) return res.status(404).json({ error: "no such product" });
      if (b.price_cents != null) {
        const cents = Math.round(Number(b.price_cents));
        if (!Number.isFinite(cents) || cents < 1) return res.status(400).json({ error: "bad price" });
        await sql`UPDATE dev_products SET price_cents = ${cents} WHERE id = ${pid}`;
      }
      if (b.active != null) await sql`UPDATE dev_products SET active = ${!!b.active} WHERE id = ${pid}`;
      if (typeof b.title === "string" && b.title.trim()) await sql`UPDATE dev_products SET title = ${b.title.trim()} WHERE id = ${pid}`;
      if (typeof b.region === "string" && b.region.trim()) await sql`UPDATE dev_products SET region = ${b.region.trim()} WHERE id = ${pid}`;
      if (b.appid !== undefined) await sql`UPDATE dev_products SET appid = ${b.appid || null} WHERE id = ${pid}`;
      if (typeof b.image === "string" && b.image.trim()) {
        if (b.image.length > MAX_IMG_CHARS) return res.status(400).json({ error: "cover image too large" });
        await sql`UPDATE dev_products SET image = ${b.image} WHERE id = ${pid}`;
      }
      if (b.description !== undefined) await sql`UPDATE dev_products SET description = ${b.description != null ? String(b.description).slice(0, MAX_DESC_CHARS) : null} WHERE id = ${pid}`;
      if (b.media !== undefined) await sql`UPDATE dev_products SET media = ${JSON.stringify(cleanMedia(b.media))}::jsonb WHERE id = ${pid}`;
      if (b.videos !== undefined) await sql`UPDATE dev_products SET videos = ${JSON.stringify(cleanVideos(b.videos))}::jsonb WHERE id = ${pid}`;
      return res.status(200).json({ ok: true });
    }

    // ---- PUBLIC: full game store page (media, description, dev) -----------
    if (b.action === "product-view") {
      const pid = Number(b.product_id);
      const [dropUsd, solUsd] = await Promise.all([
        currentDropUsd().catch(() => null),
        currentSolUsd().catch(() => null),
      ]);
      const r = await sql`
        SELECT p.id, p.title, p.appid, p.image, p.region, p.price_cents, p.steam_price_cents,
               p.description, p.media, p.videos, p.created_at,
               s.wallet AS seller_wallet, s.studio, s.standing, s.avatar, s.bio, s.website, s.socials, s.accepted_currencies,
               count(k.id) FILTER (WHERE k.status = 'available') AS available
        FROM dev_products p
        JOIN dev_sellers s ON s.id = p.seller_id
        LEFT JOIN dev_key_inventory k ON k.product_id = p.id
        WHERE p.id = ${pid} AND p.deleted = false AND s.status = 'approved'
        GROUP BY p.id, s.wallet, s.studio, s.standing, s.avatar, s.bio, s.website, s.socials, s.accepted_currencies`;
      const p = r.rows[0];
      if (!p) return res.status(404).json({ error: "game not found" });
      const usd = p.price_cents / 100;
      const discUsd = usd * (1 - BUYER_DROP_DISCOUNT_BPS / 10000);
      return res.status(200).json({
        ok: true, dropUsd, solUsd, buyer_drop_discount_bps: BUYER_DROP_DISCOUNT_BPS,
        product: {
          id: p.id, title: p.title, appid: p.appid, image: p.image, region: p.region,
          price_cents: p.price_cents, steam_price_cents: p.steam_price_cents,
          description: p.description, media: p.media || [], videos: p.videos || [],
          available: Number(p.available),
          accepted_currencies: p.accepted_currencies || ["DROP", "USDC", "SOL"],
          drop_est: dropUsd ? Math.round(usd / dropUsd) : null,
          drop_est_discounted: dropUsd ? Math.round(discUsd / dropUsd) : null,
          usdc_amount: Number(usd.toFixed(2)),
          sol_est: solUsd ? Number((usd / solUsd).toFixed(4)) : null,
        },
        dev: {
          wallet: p.seller_wallet, studio: p.studio, avatar: p.avatar, bio: p.bio,
          website: p.website, socials: p.socials, trusted: p.standing === "trusted",
        },
      });
    }

    // ---- PUBLIC: a developer's store profile + their live games -----------
    if (b.action === "dev-profile") {
      const w = String(b.wallet || "");
      const s = (await sql`SELECT * FROM dev_sellers WHERE wallet = ${w} AND status = 'approved'`).rows[0];
      if (!s) return res.status(404).json({ error: "developer not found" });
      const prods = await sql`
        SELECT p.id, p.title, p.image, p.region, p.price_cents,
               count(k.id) FILTER (WHERE k.status = 'available') AS available
        FROM dev_products p LEFT JOIN dev_key_inventory k ON k.product_id = p.id
        WHERE p.seller_id = ${s.id} AND p.active = true AND p.deleted = false
        GROUP BY p.id
        HAVING count(k.id) FILTER (WHERE k.status = 'available') > 0
        ORDER BY p.created_at DESC`;
      return res.status(200).json({
        ok: true,
        dev: {
          wallet: s.wallet, studio: s.studio, avatar: s.avatar, bio: s.bio,
          website: s.website, socials: s.socials, trusted: s.standing === "trusted",
          sold_count: s.sold_count,
        },
        products: prods.rows.map((r) => ({
          id: r.id, title: r.title, image: r.image, region: r.region,
          price_cents: r.price_cents, available: Number(r.available),
        })),
      });
    }

    // ---- SELLER: delete a product (soft) ----------------------------------
    // Hides the game from the store and the seller's portal and voids any keys
    // still available. Sold keys / order history are preserved for the buyers
    // and dispute integrity, so this is a soft-delete (deleted=true), not a purge.
    if (b.action === "product-delete") {
      const seller = await requireApprovedSeller(b);
      const pid = Number(b.product_id);
      const own = await sql`SELECT id FROM dev_products WHERE id = ${pid} AND seller_id = ${seller.id}`;
      if (!own.rows.length) return res.status(404).json({ error: "no such product" });
      const voided = await sql`
        UPDATE dev_key_inventory SET status = 'void'
        WHERE product_id = ${pid} AND status = 'available' RETURNING id`;
      await sql`UPDATE dev_products SET deleted = true, active = false WHERE id = ${pid}`;
      await audit("product-delete", seller.wallet, { product_id: pid, voided: voided.rows.length });
      return res.status(200).json({ ok: true, voided: voided.rows.length });
    }

    // ---- SELLER: pull (withdraw) unsold keys ------------------------------
    // Returns the dev their own still-available keys and removes them from sale.
    // Only 'available' keys are eligible — locked/sold keys belong to a buyer and
    // are never returned. The rows are deleted so the codes can be re-listed later.
    if (b.action === "keys-pull") {
      const seller = await requireApprovedSeller(b);
      const pid = Number(b.product_id);
      const own = await sql`SELECT id FROM dev_products WHERE id = ${pid} AND seller_id = ${seller.id}`;
      if (!own.rows.length) return res.status(404).json({ error: "no such product" });
      const lim = Number.isFinite(Number(b.count)) && Number(b.count) > 0 ? Math.min(Number(b.count), 5000) : 5000;
      const rows = await sql`
        SELECT id, code_encrypted FROM dev_key_inventory
        WHERE product_id = ${pid} AND status = 'available'
        ORDER BY id ASC LIMIT ${lim}`;
      const pulled = [];
      for (const row of rows.rows) {
        let code = null;
        try { code = decryptCode(row.code_encrypted, process.env.CODE_VAULT_KEY); } catch { code = null; }
        await sql`DELETE FROM dev_key_inventory WHERE id = ${row.id}`;
        if (code) pulled.push(code);
      }
      await audit("keys-pull", seller.wallet, { product_id: pid, count: pulled.length });
      return res.status(200).json({ ok: true, count: pulled.length, keys: pulled });
    }

    // ---- SELLER: ingest a batch of keys (encrypt + global dedup) ----------
    // The "dump". Each key is normalized -> format-checked -> salted-hashed ->
    // ENVELOPE-ENCRYPTED -> inserted under a GLOBAL UNIQUE(key_hash). Duplicates
    // (in this batch, or anywhere on the platform) are silently rejected. Plaintext
    // is discarded the instant it's encrypted — never stored, never logged, never returned.
    if (b.action === "ingest") {
      const seller = await requireApprovedSeller(b);
      const pid = Number(b.product_id);
      const prod = await sql`SELECT id FROM dev_products WHERE id = ${pid} AND seller_id = ${seller.id}`;
      if (!prod.rows.length) return res.status(404).json({ error: "no such product" });
      if (!Array.isArray(b.keys) || !b.keys.length) return res.status(400).json({ error: "keys[] required" });
      if (b.keys.length > 5000) return res.status(400).json({ error: "max 5000 keys per batch" });
      let added = 0, duplicate = 0, invalid = 0;
      for (const raw of b.keys) {
        const norm = normalizeKey(raw);
        if (!keyFormatOk(norm)) { invalid++; continue; }
        const hash = keyHash(norm);
        let enc;
        try { enc = encryptCode(prettyKey(norm), process.env.CODE_VAULT_KEY); }
        catch { invalid++; continue; }
        const ins = await sql`
          INSERT INTO dev_key_inventory(product_id, seller_id, code_encrypted, key_hash, last4, status)
          VALUES (${pid}, ${seller.id}, ${enc}, ${hash}, ${norm.slice(-4)}, 'available')
          ON CONFLICT (key_hash) DO NOTHING
          RETURNING id`;
        if (ins.rows.length) added++; else duplicate++;
      }
      await audit("ingest", seller.wallet, { product_id: pid, added, duplicate, invalid });
      const avail = await sql`SELECT count(*)::int AS n FROM dev_key_inventory WHERE product_id = ${pid} AND status = 'available'`;
      return res.status(200).json({ ok: true, added, duplicate, invalid, available: avail.rows[0].n });
    }

    // ---- SELLER: masked inventory peek (never full keys) ------------------
    if (b.action === "inventory") {
      const seller = await requireApprovedSeller(b);
      const pid = Number(b.product_id);
      const own = await sql`SELECT id FROM dev_products WHERE id = ${pid} AND seller_id = ${seller.id}`;
      if (!own.rows.length) return res.status(404).json({ error: "no such product" });
      const rows = await sql`
        SELECT last4, status, created_at FROM dev_key_inventory
        WHERE product_id = ${pid} ORDER BY id DESC LIMIT 1000`;
      const keys = rows.rows.map((r) => ({ masked: "····-····-" + (r.last4 || "????"), status: r.status, at: r.created_at }));
      return res.status(200).json({ ok: true, keys });
    }

    // ---- PUBLIC: browse the storefront ------------------------------------
    // Only approved sellers' active products with at least one available key.
    // Returns USD price plus a live $DROP-equivalent and the buyer $DROP-discount
    // preview so the frontend can show "pay in $DROP, save 5%".
    if (b.action === "market") {
      const [dropUsd, solUsd] = await Promise.all([
        currentDropUsd().catch(() => null),
        currentSolUsd().catch(() => null),
      ]);
      const rows = await sql`
        SELECT p.id, p.title, p.appid, p.image, p.edition, p.region, p.price_cents, p.steam_price_cents,
               s.wallet AS seller_wallet, s.studio, s.standing, s.accepted_currencies,
               count(k.id) FILTER (WHERE k.status = 'available') AS available
        FROM dev_products p
        JOIN dev_sellers s ON s.id = p.seller_id
        LEFT JOIN dev_key_inventory k ON k.product_id = p.id
        WHERE p.active = true AND s.status = 'approved'
        GROUP BY p.id, s.wallet, s.studio, s.standing, s.accepted_currencies
        HAVING count(k.id) FILTER (WHERE k.status = 'available') > 0
        ORDER BY p.created_at DESC
        LIMIT 200`;
      const discBps = BUYER_DROP_DISCOUNT_BPS;
      const listings = rows.rows.map((r) => {
        const usd = r.price_cents / 100;
        const discUsd = usd * (1 - discBps / 10000);
        return {
          id: r.id, title: r.title, appid: r.appid, image: r.image, edition: r.edition,
          region: r.region, price_cents: r.price_cents, steam_price_cents: r.steam_price_cents,
          available: Number(r.available), seller: r.seller_wallet, studio: r.studio,
          trusted: r.standing === "trusted",
          accepted_currencies: r.accepted_currencies || ["DROP", "USDC", "SOL"],
          // $DROP amount reflects the discount (what the buyer actually pays in $DROP).
          drop_est: dropUsd ? Math.round(usd / dropUsd) : null,
          drop_est_discounted: dropUsd ? Math.round(discUsd / dropUsd) : null,
          usdc_amount: Number(usd.toFixed(2)),
          sol_est: solUsd ? Number((usd / solUsd).toFixed(4)) : null,
        };
      });
      return res.status(200).json({
        ok: true, dropUsd, solUsd, decimals: DECIMALS,
        buyer_drop_discount_bps: discBps, fee_bps: FEE_BPS,
        listings,
      });
    }

    // ======================================================================
    // ESCROW ORDER ENGINE ($DROP-only). Buyer pays $DROP to the treasury; the key
    // is delivered on payment; the dev's payout is HELD for the dispute window and
    // released (net of 1.5%) on buyer-confirm or window-expiry. USDC/SOL rails and
    // the buyer $DROP discount layer on later — same state machine.
    // ======================================================================

    // ---- BUY: quote + lock a key + open an escrow order -------------------
    if (b.action === "buy-open") {
      if (!b.buyer) return res.status(400).json({ error: "buyer wallet required" });
      const pid = Number(b.product_id);
      const cur = CCY.includes(b.pay_currency) ? b.pay_currency : "DROP";
      const pr = await sql`
        SELECT p.*, s.status AS seller_status, s.accepted_currencies FROM dev_products p
        JOIN dev_sellers s ON s.id = p.seller_id WHERE p.id = ${pid}`;
      const product = pr.rows[0];
      if (!product || !product.active || product.seller_status !== "approved") {
        return res.status(404).json({ error: "not available" });
      }
      const accepted = product.accepted_currencies || ["DROP", "USDC", "SOL"];
      if (!accepted.includes(cur)) return res.status(400).json({ error: `this developer doesn't accept ${cur}` });
      // Live prices only for the rails we actually need this order.
      const dropUsd = cur === "DROP" ? await currentDropUsd().catch(() => null) : null;
      const solUsd = cur === "SOL" ? await currentSolUsd().catch(() => null) : null;
      if (cur === "DROP" && !dropUsd) return res.status(503).json({ error: "price feed unavailable — try again" });
      if (cur === "SOL" && !solUsd) return res.status(503).json({ error: "SOL price feed unavailable — try again" });
      const usd = product.price_cents / 100;
      // The $DROP discount is now REAL: paying in $DROP costs less USD-equivalent.
      // USDC/SOL pay full price. This is the incentive that steers buyers to $DROP.
      const effUsd = cur === "DROP" ? usd * (1 - BUYER_DROP_DISCOUNT_BPS / 10000) : usd;
      const grossRaw = quoteRaw(effUsd, cur, { drop: dropUsd, sol: solUsd });
      if (grossRaw == null || grossRaw <= 0n) return res.status(503).json({ error: "could not price this order — try again" });
      const decimals = ccyDecimals(cur);
      const feeBps = feeBpsFor(cur);
      const feeRaw = (grossRaw * BigInt(feeBps)) / 10000n;
      const netRaw = grossRaw - feeRaw;
      // Atomically claim one available key (row-locked; the status guard makes a
      // concurrent claim on the same row fail rather than double-sell).
      const claim = await sql`
        UPDATE dev_key_inventory SET status = 'locked'
        WHERE id = (SELECT id FROM dev_key_inventory WHERE product_id = ${pid} AND status = 'available' ORDER BY id LIMIT 1)
          AND status = 'available'
        RETURNING id`;
      if (!claim.rows.length) return res.status(409).json({ error: "out of stock" });
      const keyId = claim.rows[0].id;
      const reference = makeReference();
      const expires = new Date(Date.now() + QUOTE_TTL_SEC * 1000).toISOString();
      const ord = await sql`
        INSERT INTO dev_orders(product_id, seller_id, key_id, buyer, pay_currency, payout_currency, price_cents,
          pay_amount_raw, pay_decimals, payout_amount_raw, fee_bps, reference, status, quote_expires_at)
        VALUES (${pid}, ${product.seller_id}, ${keyId}, ${b.buyer}, ${cur}, ${cur}, ${product.price_cents},
          ${grossRaw.toString()}, ${decimals}, ${netRaw.toString()}, ${feeBps}, ${reference}, 'created', ${expires})
        RETURNING id`;
      await sql`UPDATE dev_key_inventory SET order_id = ${ord.rows[0].id} WHERE id = ${keyId}`;
      return res.status(200).json({
        ok: true, order_id: ord.rows[0].id, reference, treasury: requireTreasury(),
        pay_currency: cur, pay_amount_raw: grossRaw.toString(), decimals, expires_at: expires, title: product.title,
      });
    }

    // ---- BUY: build the buyer-signed $DROP escrow transfer ----------------
    if (b.action === "buy-buildpay") {
      const r = await sql`SELECT * FROM dev_orders WHERE id = ${Number(b.order_id)}`;
      const o = r.rows[0];
      if (!o) return res.status(404).json({ error: "no such order" });
      if (o.status !== "created") return res.status(409).json({ error: `order ${o.status}` });
      if (new Date(o.quote_expires_at).getTime() < Date.now()) return res.status(409).json({ error: "quote expired — start over" });
      const payer = b.buyer || o.buyer;
      const built = o.pay_currency === "DROP"
        ? await buildDirectPaymentTx(payer, o.reference, requireTreasury(), String(o.pay_amount_raw))
        : await buildDirectPaymentMulti(payer, o.reference, requireTreasury(), String(o.pay_amount_raw), o.pay_currency);
      return res.status(200).json({ ok: true, ...built, reference: o.reference, pay_currency: o.pay_currency });
    }

    // ---- BUY: confirm payment on-chain, deliver, open the hold ------------
    if (b.action === "buy-confirm") {
      const r = await sql`SELECT * FROM dev_orders WHERE id = ${Number(b.order_id)}`;
      const o = r.rows[0];
      if (!o) return res.status(404).json({ error: "no such order" });
      if (["delivered", "releasing", "released", "disputed", "refunded"].includes(o.status)) {
        return res.status(200).json({ ok: true, state: "delivered", already: true, order_id: o.id });
      }
      if (o.status !== "created") return res.status(409).json({ error: `order ${o.status}` });
      let found, sender;
      if (o.pay_currency === "DROP") {
        found = await findPaymentByReference(o.reference);
        if (!found) return res.status(402).json({ error: "payment-not-found" }); // not on-chain yet -> client retries
        const treasuryAta = await resolveWalletAta(requireTreasury());
        const legToTreasury = (found.legs || [])
          .filter((l) => String(l.destination) === String(treasuryAta))
          .reduce((a, l) => a + BigInt(l.amountRaw), 0n);
        const v = validateTransfer(
          { mint: found.mint, destination: treasuryAta, amountRaw: legToTreasury.toString(), reference: o.reference, sender: found.sender },
          { mint: process.env.DROP_MINT, destination: treasuryAta, amountRaw: String(o.pay_amount_raw),
            reference: o.reference, expiresAt: new Date(o.quote_expires_at).getTime() + 3600000 },
          { nowMs: Date.now(), underpayToleranceBps: 0 }
        );
        if (!v.ok) return res.status(400).json({ error: "invalid-payment", reasons: v.reasons });
        sender = found.sender;
      } else {
        // USDC (to treasury USDC ATA) or SOL (to the treasury wallet directly).
        found = await findDirectPayment(o.reference, o.pay_currency);
        if (!found) return res.status(402).json({ error: "payment-not-found" });
        const dest = o.pay_currency === "SOL" ? requireTreasury() : await resolveUsdcAta(requireTreasury());
        const paidToTreasury = (found.legs || [])
          .filter((l) => String(l.destination) === String(dest))
          .reduce((a, l) => a + BigInt(l.amountRaw), 0n);
        if (paidToTreasury < BigInt(o.pay_amount_raw)) {
          return res.status(400).json({ error: "invalid-payment", reasons: ["underpaid or wrong destination"] });
        }
        sender = found.sender;
      }
      // Bind the signature so one payment can't settle two orders (unique index).
      try {
        await sql`UPDATE dev_orders SET paid_sig = ${found.signature} WHERE id = ${o.id} AND paid_sig IS NULL`;
      } catch { return res.status(409).json({ error: "payment-already-used" }); }
      const buyer = found.sender || o.buyer;       // the on-chain payer is authoritative
      const holdUntil = new Date(Date.now() + HOLD_SECONDS * 1000).toISOString();
      await sql`UPDATE dev_orders SET status = 'delivered', buyer = ${buyer}, delivered_at = now(), hold_until = ${holdUntil} WHERE id = ${o.id}`;
      await sql`UPDATE dev_key_inventory SET status = 'sold' WHERE id = ${o.key_id}`;
      await sql`INSERT INTO dev_entitlements(order_id, buyer, product_id, key_id, kind) VALUES (${o.id}, ${buyer}, ${o.product_id}, ${o.key_id}, 'steam_key')`;
      return res.status(200).json({ ok: true, state: "delivered", order_id: o.id, hold_until: holdUntil });
    }

    // ---- BUYER: reveal my key (signed; code only via signed endpoints) ----
    if (b.action === "key-reveal") {
      const wallet = assertSig(b);
      const ent = await sql`
        SELECT e.id, e.buyer, e.key_id, k.code_encrypted
        FROM dev_entitlements e JOIN dev_key_inventory k ON k.id = e.key_id
        WHERE e.order_id = ${Number(b.order_id)}`;
      const e = ent.rows[0];
      if (!e) return res.status(404).json({ error: "no such entitlement" });
      if (e.buyer !== wallet) return res.status(403).json({ error: "not your purchase" });
      let code = null;
      try { code = decryptCode(e.code_encrypted, process.env.CODE_VAULT_KEY); } catch { code = null; }
      if (!code) return res.status(500).json({ error: "vault error" });
      await sql`UPDATE dev_entitlements SET revealed_at = COALESCE(revealed_at, now()) WHERE id = ${e.id}`;
      await audit("reveal", wallet, { order_id: Number(b.order_id) }, Number(b.order_id), e.key_id);
      return res.status(200).json({ ok: true, code });
    }

    // ---- BUYER: my library (signed) ---------------------------------------
    if (b.action === "my-keys") {
      const wallet = assertSig(b);
      const rows = await sql`
        SELECT e.order_id, e.kind, e.created_at, e.revealed_at,
               p.title, p.appid, p.image, p.edition, p.region,
               k.code_encrypted, o.status AS order_status, o.hold_until
        FROM dev_entitlements e
        JOIN dev_products p ON p.id = e.product_id
        LEFT JOIN dev_key_inventory k ON k.id = e.key_id
        JOIN dev_orders o ON o.id = e.order_id
        WHERE e.buyer = ${wallet}
        ORDER BY e.created_at DESC LIMIT 200`;
      const items = rows.rows.map((r) => {
        let code = null;
        if (r.code_encrypted) { try { code = decryptCode(r.code_encrypted, process.env.CODE_VAULT_KEY); } catch { code = null; } }
        return {
          order_id: r.order_id, title: r.title, appid: r.appid, image: r.image, edition: r.edition,
          region: r.region, kind: r.kind, code, status: r.order_status, at: r.created_at,
        };
      });
      return res.status(200).json({ ok: true, items });
    }

    // ---- BUYER: confirm the key works -> release the dev early ------------
    if (b.action === "confirm-received") {
      const wallet = assertSig(b);
      const r = await sql`SELECT * FROM dev_orders WHERE id = ${Number(b.order_id)}`;
      const o = r.rows[0];
      if (!o) return res.status(404).json({ error: "no such order" });
      if (o.buyer !== wallet) return res.status(403).json({ error: "not your order" });
      if (o.status !== "delivered") return res.status(409).json({ error: `order ${o.status}` });
      const rel = await releaseOrder(o.id);
      return res.status(200).json({ ok: true, released: !!rel.sent, deferred: !!rel.deferred });
    }

    // ---- BUYER: open a dispute (pauses the dev's payout) ------------------
    if (b.action === "dispute-open") {
      const wallet = assertSig(b);
      const r = await sql`SELECT * FROM dev_orders WHERE id = ${Number(b.order_id)}`;
      const o = r.rows[0];
      if (!o) return res.status(404).json({ error: "no such order" });
      if (o.buyer !== wallet) return res.status(403).json({ error: "not your order" });
      if (o.status !== "delivered") return res.status(409).json({ error: `cannot dispute (${o.status})` });
      await sql`UPDATE dev_orders SET status = 'disputed' WHERE id = ${o.id}`;
      await sql`INSERT INTO dev_disputes(order_id, buyer, reason, evidence) VALUES (${o.id}, ${wallet}, ${b.reason || null}, ${b.evidence || null})`;
      await audit("dispute", wallet, { order_id: o.id, reason: b.reason || null }, o.id);
      return res.status(200).json({ ok: true, state: "disputed" });
    }

    // ---- ADMIN: resolve a dispute (refund the buyer, or deny -> pay dev) --
    if (b.action === "dispute-resolve") {
      if (req.headers.authorization !== `Bearer ${process.env.ADMIN_SECRET}`) {
        return res.status(401).json({ error: "unauthorized" });
      }
      const r = await sql`SELECT * FROM dev_orders WHERE id = ${Number(b.order_id)}`;
      const o = r.rows[0];
      if (!o) return res.status(404).json({ error: "no such order" });
      if (o.status !== "disputed") return res.status(409).json({ error: `order not disputed (${o.status})` });
      if (b.decision === "refund") {
        // Buyer keeps the revealed key (a key can't be un-revealed) — this is the
        // adjudicated dead-key case, so refund from the held escrow and flag the seller.
        let sig = null, ok = true;
        const rc = o.pay_currency || "DROP";
        try { sig = rc === "DROP" ? await sendTreasuryTransfer(o.buyer, String(o.pay_amount_raw)) : await sendTreasuryMulti(o.buyer, String(o.pay_amount_raw), rc); }
        catch (e) { ok = false; console.error("refund failed:", e.message); }
        await sql`UPDATE dev_orders SET status = ${ok ? "refunded" : "disputed"}, refund_sig = ${sig} WHERE id = ${o.id}`;
        await sql`UPDATE dev_disputes SET status = 'refunded', resolver = 'admin', resolved_at = now() WHERE order_id = ${o.id} AND status = 'open'`;
        await sql`UPDATE dev_sellers SET dispute_count = dispute_count + 1 WHERE id = ${o.seller_id}`;
        await audit("dispute", "admin", { order_id: o.id, decision: "refund", ok }, o.id);
        return res.status(200).json({ ok, state: ok ? "refunded" : "refund-failed", sig });
      }
      if (b.decision === "deny") {
        await sql`UPDATE dev_orders SET status = 'delivered' WHERE id = ${o.id}`;
        await sql`UPDATE dev_disputes SET status = 'denied', resolver = 'admin', resolved_at = now() WHERE order_id = ${o.id} AND status = 'open'`;
        const rel = await releaseOrder(o.id);
        await audit("dispute", "admin", { order_id: o.id, decision: "deny" }, o.id);
        return res.status(200).json({ ok: true, state: "released", released: !!rel.sent });
      }
      return res.status(400).json({ error: "decision must be refund|deny" });
    }

    // ---- ADMIN: list open disputes (for the admin portal) -----------------
    if (b.action === "dispute-queue") {
      if (req.headers.authorization !== `Bearer ${process.env.ADMIN_SECRET}`) {
        return res.status(401).json({ error: "unauthorized" });
      }
      const rows = await sql`
        SELECT d.id, d.order_id, d.buyer, d.reason, d.evidence, d.status, d.created_at,
               o.status AS order_status, o.price_cents, o.pay_currency,
               p.title AS product_title, s.studio, s.wallet AS seller_wallet
        FROM dev_disputes d
        JOIN dev_orders o   ON o.id = d.order_id
        JOIN dev_products p ON p.id = o.product_id
        JOIN dev_sellers s  ON s.id = o.seller_id
        WHERE d.status = 'open'
        ORDER BY d.created_at ASC
        LIMIT 200`;
      return res.status(200).json({ ok: true, disputes: rows.rows });
    }

    // ---- SWEEP (cron): expire stale quotes, auto-release matured holds -----
    if (b.action === "sweep") {
      if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
        return res.status(401).json({ error: "unauthorized" });
      }
      const exp = await sql`SELECT id, key_id FROM dev_orders WHERE status = 'created' AND quote_expires_at < now()`;
      for (const o of exp.rows) {
        await sql`UPDATE dev_orders SET status = 'expired' WHERE id = ${o.id} AND status = 'created'`;
        await sql`UPDATE dev_key_inventory SET status = 'available', order_id = NULL WHERE id = ${o.key_id} AND status = 'locked'`;
      }
      // Matured, undisputed holds -> pay the dev. releaseOrder reverts to 'delivered'
      // on a failed payout, so a stuck payout is simply retried on the next sweep.
      const due = await sql`SELECT id FROM dev_orders WHERE status = 'delivered' AND hold_until IS NOT NULL AND hold_until < now()`;
      let released = 0;
      for (const o of due.rows) { const rr = await releaseOrder(o.id); if (rr.sent) released++; }
      return res.status(200).json({ ok: true, expired: exp.rows.length, released });
    }

    return res.status(400).json({ error: `unknown action ${b.action}` });
  } catch (err) {
    if (err && err.http) return res.status(err.http).json({ error: String(err.message) });
    console.error("devmarket:", err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}
