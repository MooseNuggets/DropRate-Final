// ============================================================================
// DROPRATE — Native game catalog + launcher foundation.
//
// Native games are DropRate's own launcher-delivered titles: ownership is an
// on-chain NFT (added in a later brick), so they get real ownership + resale
// with dev royalties — unlike Steam keys, which are one-time and never wrapped.
//
// THIS module is the FOUNDATION only: the product data model, the dev listing
// flow, and the public storefront reads. It deliberately does NOT yet do minting,
// purchase, resale, or file hosting — those bolt on once the NFT standard is
// chosen (mint) and Cloudflare R2 exists (builds). The build/bundle columns are
// present now as empty pointers so storage drops in later with zero rework.
//
// Reuses the SHARED dev_sellers identity from the Steam-key marketplace (a dev is
// a dev), but native games live in their own table and their own storefront.
//
// Dispatched via ns:"devmarket" from api/crate.js -> devmarket() -> here, for any
// action beginning "native-". So api/crate.js needs no change.
// ============================================================================

import { createHmac } from "node:crypto";
import { sql } from "./db.js";
import { verifyWalletSignature } from "./vault.js";
import {
  r2Configured, presignUrl, publicUrl,
  multipartCreate, multipartPartUrl, multipartComplete, multipartAbort,
} from "./r2.js";

const SIG_TTL = Number(process.env.DEV_SIG_TTL_SEC || 300); // 5m signed-request freshness

// ---- house guardrails (the "baseline" that bounds dev freedom) --------------
const ROYALTY_MIN_BPS = 0;
const ROYALTY_MAX_BPS = 2000;   // 20% cap on resale royalty
const ROYALTY_DEFAULT_BPS = 1000; // 10%
const FLOOR_MIN_BPS = 0;
const FLOOR_MAX_BPS = 10000;    // resale floor as % of primary; 100% = can't resell below new
const FLOOR_DEFAULT_BPS = 6000; // 60%
const COOLDOWN_MAX_HOURS = 24 * 365;
const MAX_DESC = 8000;
const MAX_IMG = 3_000_000;      // resized data:URL or a URL
const MAX_MEDIA = 12;
const MAX_VIDEOS = 6;
// ---- upload limits ---------------------------------------------------------
// Bytes never pass through this function: we sign, the browser uploads to R2.
const PLATFORMS = ["win", "mac", "linux"];
const MAX_WEB_FILE   = 250 * 1024 * 1024;        // one asset inside a web bundle
const MAX_WEB_FILES  = 400;                       // files per bundle
const MAX_BUNDLE     = 2 * 1024 * 1024 * 1024;   // whole web bundle
const MAX_BUILD      = 10 * 1024 * 1024 * 1024;  // one desktop build archive
const PART_SIZE      = 32 * 1024 * 1024;         // multipart chunk the client should use
// Extension allowlist for web bundles. Anything not here is refused — a bundle is
// game assets, not a place to host arbitrary files.
const WEB_EXT = new Set(["html","htm","js","mjs","wasm","data","json","css","map","txt","xml","ico",
  "png","jpg","jpeg","gif","webp","svg","avif","bmp",
  "mp3","ogg","wav","m4a","mp4","webm",
  "woff","woff2","ttf","otf","eot",
  "bin","unityweb","br","gz","mem","symbols","pck","zip","glb","gltf","atlas","fnt","cur"]);

const extOf = (name) => {
  const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
};
/** Reject anything that could escape the product's prefix or poison a key. */
function safeRelPath(raw) {
  let v = String(raw || "").replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!v || v.length > 200) return null;
  if (/[\x00-\x1f\x7f]/.test(v)) return null;
  if (v.includes("//")) return null;
  if (v.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  if (!WEB_EXT.has(extOf(v))) return null;
  return v;
}
const safeFileName = (raw) => {
  const v = String(raw || "").split(/[\\/]/).pop().replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return v && v !== "." && v !== ".." ? v : null;
};
/* Bundle paths used to be guessable (games/12/v3/index.html), so anyone could walk
   the ids and pull every game on the platform without ever visiting the store. The
   version now carries an HMAC-derived suffix that can't be guessed without the
   server secret. Deterministic, so sign and commit derive the same path with no
   extra state and no trusting the client.

   Be clear-eyed about what this is: obscurity. It stops trawling and casual
   link-sharing. It does NOT stop someone who legitimately loads the game from
   saving the files — only the ownership gate in front of a private bucket does
   that, and even then a paying player can always keep a copy. */
const pathSalt = () =>
  process.env.R2_PATH_SALT || process.env.KEY_HASH_SALT || process.env.R2_SECRET_ACCESS_KEY || "droprate";
const slugFor = (...parts) =>
  createHmac("sha256", pathSalt()).update(parts.join(":")).digest("base64url").slice(0, 12);
const webVer   = (pid, ver) => `v${ver}-${slugFor("web", pid, ver)}`;
const buildVer = (pid, ver, plat) => `v${ver}-${slugFor("build", pid, plat, ver)}`;
const webKey   = (pid, ver, rel) => `games/${pid}/${webVer(pid, ver)}/${rel}`;
const buildKey = (pid, ver, plat, file) => `builds/${pid}/${buildVer(pid, ver, plat)}/${plat}/${file}`;
/** A client-supplied key is only ever trusted after this. */
const ownsKey = (key, pid) =>
  typeof key === "string" && (key.startsWith(`games/${pid}/`) || key.startsWith(`builds/${pid}/`));

const RUNTIMES = ["web", "native"]; // playable in-browser vs downloadable-via-launcher
const SUPPLY_MODELS = ["finite", "infinite"];
const REVIEW_STATES = ["draft", "pending", "approved", "rejected"];
const isAdmin = (req) => req.headers.authorization === `Bearer ${process.env.ADMIN_SECRET}`;
function requireAdmin(req) {
  if (!process.env.ADMIN_SECRET) throw Object.assign(new Error("admin is not configured"), { status: 500 });
  if (!isAdmin(req)) throw Object.assign(new Error("forbidden"), { status: 403 });
}
/* A copy someone paid for is not the developer's to take away. Once ANY copy
   exists, hiding and deleting are off the table for the dev — editing the page
   and shipping new builds stay open. Admin keeps an override for abuse/legal. */
const hasOwners = (p) => Number(p.minted_count || 0) > 0;

/* ---- gated play -----------------------------------------------------------
   When R2_GATE_BASE is set the bucket is private and assets are served by the
   Cloudflare Worker in worker/droprate-gate.js. We hand out a signed token that
   is good for one game and a couple of hours. The token rides in the URL PATH so
   that the game's own relative asset requests inherit it — see the Worker for why
   a cookie or query string can't work in a cross-site iframe.

   Today the predicate is "the developer opened this up for free play". When
   purchases exist it becomes "…or this wallet owns a copy", and nothing else
   about the mechanism changes. */
const gateBase = () => (process.env.R2_GATE_BASE || "").trim().replace(/\/+$/, "");
const PLAY_TOKEN_TTL = 2 * 60 * 60; // seconds
function playToken(productId, ttl = PLAY_TOKEN_TTL) {
  const secret = process.env.R2_GATE_SECRET;
  if (!secret) return null;
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const sig = createHmac("sha256", secret).update(`${productId}:${exp}`).digest("base64url");
  return `${productId}.${exp}.${sig}`;
}
/** Where the player's browser should load this game from, or null if it can't. */
function playUrlFor(p) {
  const key = p.web_bundle_key;
  const gated = !!(gateBase() && process.env.R2_GATE_SECRET);
  if (gated) {
    // Bundles uploaded before the gate existed have no key recorded. Once the
    // bucket is private their old public URL is dead, so return nothing rather
    // than hand out a link that is guaranteed to fail — the dev re-uploads and
    // the key gets recorded. Failing visibly beats a broken iframe.
    if (!key) return null;
    const t = playToken(p.id);
    return t ? `${gateBase()}/t/${t}/${key.split("/").map(encodeURIComponent).join("/")}` : null;
  }
  return p.web_bundle_url || null;
}
const MAX_GENRES = 4;
// Curated list — devs pick from these so filtering stays coherent. Deliberately no
// "casual"/"hyper-casual": DropRate takes full games, not mobile-store filler.
const GENRES = [
  "Action", "Adventure", "RPG", "Shooter", "Platformer", "Roguelike", "Metroidvania",
  "Strategy", "Simulation", "Survival", "Horror", "Puzzle", "Racing", "Sports",
  "Fighting", "Rhythm", "Sandbox", "Card & Board", "Visual Novel", "Co-op", "Multiplayer",
];
const cleanGenres = (v) => (Array.isArray(v) ? v : [])
  .map((g) => String(g || "").trim())
  .filter((g, i, a) => GENRES.includes(g) && a.indexOf(g) === i)
  .slice(0, MAX_GENRES);
// Touch support is a property of a WEB game only — a launcher download can't run on a phone.
const mobileFor = (runtime, want) => runtime === "web" && want === true;

const clampBps = (v, def, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, Math.round(n)));
};
const cleanMedia = (a) => Array.isArray(a) ? a.filter((x) => typeof x === "string" && x && x.length <= MAX_IMG).slice(0, MAX_MEDIA) : [];
const cleanVideos = (a) => {
  if (!Array.isArray(a)) return [];
  const out = [];
  for (const x of a) {
    const s = String(x || "").trim();
    if (/^https?:\/\/[^\s]{4,500}$/i.test(s) && !out.includes(s)) out.push(s);
    if (out.length >= MAX_VIDEOS) break;
  }
  return out;
};
const slugify = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

// ---- signed-request auth (mirrors the Steam-key market's contract) ----------
function assertSig(b) {
  const { wallet, message, signature } = b;
  if (!wallet || !message || !signature) { const e = new Error("wallet, message, signature required"); e.status = 400; throw e; }
  if (!message.includes(`wallet:${wallet}`)) { const e = new Error("message/wallet mismatch"); e.status = 401; throw e; }
  const m = /ts:(\d+)/.exec(message);
  const ts = m ? Number(m[1]) : 0;
  if (!ts || Math.abs(Date.now() / 1000 - ts) > SIG_TTL) { const e = new Error("signature expired — retry"); e.status = 401; throw e; }
  let ok = false;
  try { ok = verifyWalletSignature(message, String(signature), wallet); } catch { ok = false; }
  if (!ok) { const e = new Error("signature verification failed"); e.status = 401; throw e; }
  return wallet;
}
async function approvedSeller(b) {
  const wallet = assertSig(b);
  const r = await sql`SELECT * FROM dev_sellers WHERE wallet = ${wallet}`;
  const s = r.rows[0];
  if (!s) { const e = new Error("no seller profile — apply in the dev portal first"); e.status = 403; throw e; }
  if (s.status !== "approved") { const e = new Error(`seller not approved (${s.status})`); e.status = 403; throw e; }
  return s;
}
/* Publishing native games is its own gate. Selling Steam keys says nothing about
   whether someone can be trusted to ship a game to players. */
async function nativePublisher(b) {
  const s = await approvedSeller(b);
  if (s.native_status !== "approved") {
    const msg = s.native_status === "pending" ? "your native developer application is still under review"
      : s.native_status === "rejected" ? "your native developer application was not approved"
      : "apply to publish native games first";
    const e = new Error(msg); e.status = 403; throw e;
  }
  return s;
}

// ---- schema (idempotent, additive; never touches other tables) --------------
async function migrateNative() {
  await sql`CREATE TABLE IF NOT EXISTS dev_native_products(
    id serial PRIMARY KEY,
    seller_id int NOT NULL REFERENCES dev_sellers(id),
    title text NOT NULL,
    slug text,
    tagline text,
    description text,
    image text,                                   -- cover art
    media jsonb NOT NULL DEFAULT '[]'::jsonb,      -- screenshots
    videos jsonb NOT NULL DEFAULT '[]'::jsonb,     -- trailer links
    price_cents int NOT NULL,
    royalty_bps int NOT NULL DEFAULT 1000,         -- dev royalty on each resale
    resale_floor_bps int NOT NULL DEFAULT 6000,    -- min resale price as % of primary
    resale_cooldown_hours int NOT NULL DEFAULT 0,  -- can't resell for N hours after buy
    supply_model text NOT NULL DEFAULT 'infinite', -- finite | infinite
    supply_cap int,                                -- null unless finite
    minted_count int NOT NULL DEFAULT 0,           -- how many copies exist (mint bumps this later)
    runtime text NOT NULL DEFAULT 'web',           -- web (browser) | native (launcher download)
    mobile_ready boolean NOT NULL DEFAULT false,   -- web game that also plays on phones/tablets
    bundle_version int NOT NULL DEFAULT 0,         -- live web-bundle version (0 = nothing uploaded)
    demo_public boolean NOT NULL DEFAULT false,    -- dev lets anyone play the web build for free
    web_bundle_key text,                           -- object key of the live index.html (gated serving)
    review_status text NOT NULL DEFAULT 'draft',   -- draft | pending | approved | rejected
    review_note text,                              -- why it was rejected, shown to the dev
    submitted_at timestamptz,
    reviewed_at timestamptz,
    genres jsonb NOT NULL DEFAULT '[]'::jsonb,     -- up to MAX_GENRES from the GENRES list
    web_bundle_url text,                           -- for web games (filled once R2 exists)
    builds jsonb NOT NULL DEFAULT '{}'::jsonb,     -- {win:{url,bytes,version}, mac:{}, linux:{}} for native
    active boolean NOT NULL DEFAULT false,         -- dev toggles the listing live
    deleted boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_native_seller ON dev_native_products(seller_id)`;
  // additive columns for tables created before these fields existed
  await sql`ALTER TABLE dev_native_products ADD COLUMN IF NOT EXISTS mobile_ready boolean NOT NULL DEFAULT false`;
  await sql`ALTER TABLE dev_native_products ADD COLUMN IF NOT EXISTS genres jsonb NOT NULL DEFAULT '[]'::jsonb`;
  await sql`ALTER TABLE dev_native_products ADD COLUMN IF NOT EXISTS bundle_version int NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE dev_native_products ADD COLUMN IF NOT EXISTS demo_public boolean NOT NULL DEFAULT false`;
  await sql`ALTER TABLE dev_native_products ADD COLUMN IF NOT EXISTS web_bundle_key text`;
  await sql`ALTER TABLE dev_native_products ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'draft'`;
  await sql`ALTER TABLE dev_native_products ADD COLUMN IF NOT EXISTS review_note text`;
  await sql`ALTER TABLE dev_native_products ADD COLUMN IF NOT EXISTS submitted_at timestamptz`;
  await sql`ALTER TABLE dev_native_products ADD COLUMN IF NOT EXISTS reviewed_at timestamptz`;
  // native publishing is its own approval, separate from selling keys
  await sql`ALTER TABLE dev_sellers ADD COLUMN IF NOT EXISTS native_status text NOT NULL DEFAULT 'none'`;
  await sql`ALTER TABLE dev_sellers ADD COLUMN IF NOT EXISTS native_note text`;
  await sql`ALTER TABLE dev_sellers ADD COLUMN IF NOT EXISTS native_engine text`;
  await sql`ALTER TABLE dev_sellers ADD COLUMN IF NOT EXISTS native_pitch text`;
  await sql`ALTER TABLE dev_sellers ADD COLUMN IF NOT EXISTS native_prior text`;
  await sql`ALTER TABLE dev_sellers ADD COLUMN IF NOT EXISTS native_playable text`;
  await sql`ALTER TABLE dev_sellers ADD COLUMN IF NOT EXISTS native_applied_at timestamptz`;

  /* One-time backfill. These gates are new; anything that already existed was
     published before they did, so grandfather it rather than yanking live games
     off the store and locking their developers out. Guarded by a marker row
     because migrateNative() runs on every request — an unguarded UPDATE here
     would silently auto-approve every future draft. */
  await sql`CREATE TABLE IF NOT EXISTS dev_native_migrations(
    key text PRIMARY KEY, done_at timestamptz NOT NULL DEFAULT now())`;
  const gf = await sql`SELECT 1 FROM dev_native_migrations WHERE key = 'grandfather_review_v1'`;
  if (!gf.rows.length) {
    await sql`UPDATE dev_sellers SET native_status = 'approved', updated_at = now()
      WHERE native_status = 'none'
        AND id IN (SELECT DISTINCT seller_id FROM dev_native_products WHERE deleted = false)`;
    await sql`UPDATE dev_native_products SET review_status = 'approved', reviewed_at = now()
      WHERE review_status = 'draft' AND deleted = false`;
    await sql`INSERT INTO dev_native_migrations(key) VALUES ('grandfather_review_v1')
      ON CONFLICT (key) DO NOTHING`;
  }
}

// available copies for a listing (null cap = infinite)
const availOf = (p) => p.supply_model === "finite"
  ? Math.max(0, (Number(p.supply_cap) || 0) - (Number(p.minted_count) || 0))
  : null; // null = unlimited

function publicProduct(p, seller) {
  return {
    id: p.id, slug: p.slug, title: p.title, tagline: p.tagline,
    description: p.description, image: p.image, media: p.media || [], videos: p.videos || [],
    price_cents: p.price_cents, runtime: p.runtime,
    mobile_ready: !!p.mobile_ready, genres: p.genres || [],
    created_at: p.created_at,
    // has_build says a playable build exists; play_url is only handed out when the
    // developer has actually opted into letting the public play it.
    has_build: !!p.web_bundle_url,
    demo_public: !!p.demo_public,
    play_url: (p.demo_public && (p.web_bundle_key || p.web_bundle_url)) ? playUrlFor(p) : undefined,
    royalty_bps: p.royalty_bps, resale_floor_bps: p.resale_floor_bps,
    supply_model: p.supply_model, supply_cap: p.supply_cap,
    minted_count: p.minted_count, available: availOf(p),
    sold_out: p.supply_model === "finite" && availOf(p) <= 0,
    dev: seller ? { wallet: seller.wallet, studio: seller.studio, avatar: seller.avatar, trusted: seller.standing === "trusted" } : undefined,
  };
}

export async function nativemarket(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    await migrateNative();
    const b = req.body ?? {};

    // ---- SELLER: create a native game listing ---------------------------
    if (b.action === "native-create") {
      const seller = await nativePublisher(b);
      const title = String(b.title || "").trim();
      const cents = Math.round(Number(b.price_cents));
      if (!title) return res.status(400).json({ error: "title required" });
      if (!Number.isFinite(cents) || cents < 1) return res.status(400).json({ error: "valid price required" });
      const runtime = RUNTIMES.includes(b.runtime) ? b.runtime : "web";
      const supply_model = SUPPLY_MODELS.includes(b.supply_model) ? b.supply_model : "infinite";
      let supply_cap = null;
      if (supply_model === "finite") {
        supply_cap = Math.round(Number(b.supply_cap));
        if (!Number.isFinite(supply_cap) || supply_cap < 1) return res.status(400).json({ error: "finite supply needs a cap of 1+" });
      }
      if (b.image && String(b.image).length > MAX_IMG) return res.status(400).json({ error: "cover image too large" });
      const royalty = clampBps(b.royalty_bps, ROYALTY_DEFAULT_BPS, ROYALTY_MIN_BPS, ROYALTY_MAX_BPS);
      const floor = clampBps(b.resale_floor_bps, FLOOR_DEFAULT_BPS, FLOOR_MIN_BPS, FLOOR_MAX_BPS);
      const cooldown = Math.max(0, Math.min(COOLDOWN_MAX_HOURS, Math.round(Number(b.resale_cooldown_hours) || 0)));
      const desc = b.description != null ? String(b.description).slice(0, MAX_DESC) : null;
      const r = await sql`
        INSERT INTO dev_native_products(seller_id, title, slug, tagline, description, image, media, videos,
          price_cents, royalty_bps, resale_floor_bps, resale_cooldown_hours,
          supply_model, supply_cap, runtime, mobile_ready, genres, demo_public)
        VALUES (${seller.id}, ${title}, ${slugify(title)}, ${b.tagline || null}, ${desc}, ${b.image || null},
          ${JSON.stringify(cleanMedia(b.media))}::jsonb, ${JSON.stringify(cleanVideos(b.videos))}::jsonb,
          ${cents}, ${royalty}, ${floor}, ${cooldown},
          ${supply_model}, ${supply_cap}, ${runtime},
          ${mobileFor(runtime, b.mobile_ready === true)}, ${JSON.stringify(cleanGenres(b.genres))}::jsonb,
          ${b.demo_public === true})
        RETURNING id, slug, title, active`;
      return res.status(200).json({ ok: true, product: r.rows[0] });
    }

    // ---- SELLER: edit a native listing ----------------------------------
    if (b.action === "native-set") {
      const seller = await nativePublisher(b);
      const pid = Number(b.product_id);
      const own = await sql`SELECT * FROM dev_native_products WHERE id = ${pid} AND seller_id = ${seller.id} AND deleted = false`;
      const p = own.rows[0];
      if (!p) return res.status(404).json({ error: "no such game" });
      const set = {};
      if (typeof b.title === "string" && b.title.trim()) { set.title = b.title.trim(); set.slug = slugify(b.title); }
      if (b.tagline !== undefined) set.tagline = b.tagline || null;
      if (b.description !== undefined) set.description = b.description != null ? String(b.description).slice(0, MAX_DESC) : null;
      if (typeof b.image === "string" && b.image.trim()) { if (b.image.length > MAX_IMG) return res.status(400).json({ error: "cover too large" }); set.image = b.image; }
      if (b.media !== undefined) set.media = JSON.stringify(cleanMedia(b.media));
      if (b.videos !== undefined) set.videos = JSON.stringify(cleanVideos(b.videos));
      if (b.price_cents !== undefined) { const c = Math.round(Number(b.price_cents)); if (!Number.isFinite(c) || c < 1) return res.status(400).json({ error: "bad price" }); set.price_cents = c; }
      if (b.royalty_bps !== undefined) set.royalty_bps = clampBps(b.royalty_bps, p.royalty_bps, ROYALTY_MIN_BPS, ROYALTY_MAX_BPS);
      if (b.resale_floor_bps !== undefined) set.resale_floor_bps = clampBps(b.resale_floor_bps, p.resale_floor_bps, FLOOR_MIN_BPS, FLOOR_MAX_BPS);
      if (b.resale_cooldown_hours !== undefined) set.resale_cooldown_hours = Math.max(0, Math.min(COOLDOWN_MAX_HOURS, Math.round(Number(b.resale_cooldown_hours) || 0)));
      if (b.runtime !== undefined && RUNTIMES.includes(b.runtime)) set.runtime = b.runtime;
      if (b.genres !== undefined) set.genres = JSON.stringify(cleanGenres(b.genres));
      if (b.demo_public !== undefined) set.demo_public = b.demo_public === true;
      // recompute against whichever runtime ends up applying
      if (b.mobile_ready !== undefined || b.runtime !== undefined) {
        const rt = set.runtime || p.runtime;
        const want = b.mobile_ready !== undefined ? b.mobile_ready === true : !!p.mobile_ready;
        set.mobile_ready = mobileFor(rt, want);
      }
      if (b.web_bundle_url !== undefined) set.web_bundle_url = b.web_bundle_url || null;
      // Supply model can only TIGHTEN once copies exist (can't retro-cap below minted, can't switch away from finite arbitrarily).
      if (b.supply_model !== undefined && SUPPLY_MODELS.includes(b.supply_model)) {
        if (b.supply_model === "finite") {
          const cap = Math.round(Number(b.supply_cap));
          if (!Number.isFinite(cap) || cap < 1) return res.status(400).json({ error: "finite supply needs a cap of 1+" });
          if (cap < (p.minted_count || 0)) return res.status(400).json({ error: `cap can't be below the ${p.minted_count} already minted` });
          set.supply_model = "finite"; set.supply_cap = cap;
        } else { set.supply_model = "infinite"; set.supply_cap = null; }
      }
      // Apply each provided field (parameterized, one statement per field for the sql shim).
      for (const [k, v] of Object.entries(set)) {
        if (k === "media" || k === "videos" || k === "genres") await sql.query(`UPDATE dev_native_products SET ${k} = $1::jsonb, updated_at = now() WHERE id = $2`, [v, pid]);
        else await sql.query(`UPDATE dev_native_products SET ${k} = $1, updated_at = now() WHERE id = $2`, [v, pid]);
      }
      return res.status(200).json({ ok: true, updated: Object.keys(set) });
    }

    // ---- SELLER: toggle a listing live / hidden -------------------------
    if (b.action === "native-set-active") {
      const seller = await nativePublisher(b);
      const pid = Number(b.product_id);
      const own = await sql`SELECT * FROM dev_native_products WHERE id = ${pid} AND seller_id = ${seller.id} AND deleted = false`;
      const p = own.rows[0];
      if (!p) return res.status(404).json({ error: "no such game" });
      const want = b.active === true;
      if (!want && hasOwners(p)) {
        return res.status(409).json({ error: "people own copies of this game — it can't be taken off the store. Edit it or ship a new build instead." });
      }
      if (want && p.review_status !== "approved") {
        return res.status(409).json({ error: "this game hasn't been approved yet — submit it for review first" });
      }
      await sql`UPDATE dev_native_products SET active = ${want}, updated_at = now() WHERE id = ${pid}`;
      return res.status(200).json({ ok: true, active: want });
    }

    if (b.action === "native-delete") {
      const seller = await nativePublisher(b);
      const pid = Number(b.product_id);
      const own = await sql`SELECT * FROM dev_native_products WHERE id = ${pid} AND seller_id = ${seller.id} AND deleted = false`;
      const p = own.rows[0];
      if (!p) return res.status(404).json({ error: "no such game" });
      if (hasOwners(p)) {
        return res.status(409).json({ error: "people own copies of this game — it can't be deleted. Their copies would stop working." });
      }
      await sql`UPDATE dev_native_products SET deleted = true, active = false, updated_at = now() WHERE id = ${pid}`;
      return res.status(200).json({ ok: true, deleted: pid });
    }

    // ---- SELLER: apply to publish native games -------------------------
    if (b.action === "native-apply") {
      const seller = await approvedSeller(b);
      if (seller.native_status === "approved") return res.status(400).json({ error: "you're already approved to publish games" });
      if (seller.native_status === "pending") return res.status(400).json({ error: "your application is already under review" });
      const pitch = String(b.pitch || "").trim();
      if (pitch.length < 40) return res.status(400).json({ error: "tell us a bit more about what you're building (40+ characters)" });
      await sql`UPDATE dev_sellers SET native_status = 'pending', native_note = NULL,
        native_engine = ${String(b.engine || "").slice(0, 120) || null},
        native_pitch = ${pitch.slice(0, 4000)},
        native_prior = ${String(b.prior || "").slice(0, 2000) || null},
        native_playable = ${String(b.playable || "").slice(0, 500) || null},
        native_applied_at = now(), updated_at = now() WHERE id = ${seller.id}`;
      return res.status(200).json({ ok: true, native_status: "pending" });
    }

    // ---- SELLER: submit a game for review -----------------------------
    if (b.action === "native-submit") {
      const seller = await nativePublisher(b);
      const pid = Number(b.product_id);
      const own = await sql`SELECT * FROM dev_native_products WHERE id = ${pid} AND seller_id = ${seller.id} AND deleted = false`;
      const p = own.rows[0];
      if (!p) return res.status(404).json({ error: "no such game" });
      if (p.review_status === "pending") return res.status(400).json({ error: "already waiting on review" });
      if (p.review_status === "approved") return res.status(400).json({ error: "already approved" });
      // nothing goes to review without something to actually play
      const hasBuild = !!p.web_bundle_url || Object.keys(p.builds || {}).length > 0;
      if (!hasBuild) return res.status(400).json({ error: "upload a playable build before submitting for review" });
      if (!p.image) return res.status(400).json({ error: "add a cover image before submitting for review" });
      if (!p.description) return res.status(400).json({ error: "add a description before submitting for review" });
      await sql`UPDATE dev_native_products SET review_status = 'pending', review_note = NULL,
        submitted_at = now(), updated_at = now() WHERE id = ${pid}`;
      return res.status(200).json({ ok: true, review_status: "pending" });
    }

    // ---- ADMIN: native developer applications --------------------------
    if (b.action === "native-dev-queue") {
      requireAdmin(req);
      const r = await sql`SELECT id, wallet, studio, contact, website, socials, status, standing,
          native_status, native_note, native_engine, native_pitch, native_prior, native_playable, native_applied_at
        FROM dev_sellers WHERE native_status <> 'none' ORDER BY
          CASE native_status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, native_applied_at DESC NULLS LAST`;
      return res.status(200).json({ ok: true, devs: r.rows });
    }
    if (b.action === "native-dev-review") {
      requireAdmin(req);
      const decision = ["approved", "rejected", "none"].includes(b.decision) ? b.decision : null;
      if (!decision) return res.status(400).json({ error: "decision must be approved, rejected or none" });
      const r = await sql`UPDATE dev_sellers SET native_status = ${decision},
        native_note = ${b.note ? String(b.note).slice(0, 2000) : null}, updated_at = now()
        WHERE id = ${Number(b.seller_id)} RETURNING id, wallet, studio, native_status`;
      if (!r.rows.length) return res.status(404).json({ error: "no such developer" });
      return res.status(200).json({ ok: true, dev: r.rows[0] });
    }

    // ---- ADMIN: game review queue --------------------------------------
    if (b.action === "native-review-queue") {
      requireAdmin(req);
      const want = REVIEW_STATES.includes(b.status) ? b.status : "pending";
      const r = await sql`
        SELECT p.*, s.wallet AS seller_wallet, s.studio, s.standing, s.native_status
        FROM dev_native_products p JOIN dev_sellers s ON s.id = p.seller_id
        WHERE p.deleted = false AND p.review_status = ${want}
        ORDER BY p.submitted_at DESC NULLS LAST, p.created_at DESC LIMIT 100`;
      return res.status(200).json({ ok: true, games: r.rows.map((p) => ({
        ...publicProduct(p, { wallet: p.seller_wallet, studio: p.studio, standing: p.standing }),
        review_status: p.review_status, review_note: p.review_note, submitted_at: p.submitted_at,
        active: p.active, locked: hasOwners(p),
        // admin can always open the build, whether or not the dev opened it to the public
        test_url: (p.web_bundle_key || p.web_bundle_url)
          ? playUrlFor({ ...p, id: p.id }) : null,
        builds: p.builds || {},
      })) });
    }
    if (b.action === "native-review") {
      requireAdmin(req);
      const decision = ["approved", "rejected", "draft"].includes(b.decision) ? b.decision : null;
      if (!decision) return res.status(400).json({ error: "decision must be approved, rejected or draft" });
      const pid = Number(b.product_id);
      // approving publishes it; rejecting or sending it back pulls it off the store
      const r = await sql`UPDATE dev_native_products
        SET review_status = ${decision},
            review_note = ${b.note ? String(b.note).slice(0, 2000) : null},
            active = ${decision === "approved"},
            reviewed_at = now(), updated_at = now()
        WHERE id = ${pid} AND deleted = false RETURNING id, title, review_status, active`;
      if (!r.rows.length) return res.status(404).json({ error: "no such game" });
      return res.status(200).json({ ok: true, game: r.rows[0] });
    }
    // Admin override — the one way an owned game can be pulled, for abuse or legal reasons.
    if (b.action === "native-delist") {
      requireAdmin(req);
      const r = await sql`UPDATE dev_native_products SET active = false, review_status = 'rejected',
        review_note = ${b.note ? String(b.note).slice(0, 2000) : "delisted by DropRate"}, reviewed_at = now(), updated_at = now()
        WHERE id = ${Number(b.product_id)} AND deleted = false RETURNING id, title`;
      if (!r.rows.length) return res.status(404).json({ error: "no such game" });
      return res.status(200).json({ ok: true, game: r.rows[0] });
    }

    // ---- SELLER: my native games ---------------------------------------
    if (b.action === "native-mine") {
      const seller = await approvedSeller(b);
      const rows = await sql`SELECT * FROM dev_native_products
        WHERE seller_id = ${seller.id} AND deleted = false ORDER BY created_at DESC`;
      return res.status(200).json({ ok: true, seller: { native_status: seller.native_status, native_note: seller.native_note },
        games: rows.rows.map((p) => ({ ...publicProduct(p), active: p.active, web_bundle_url: p.web_bundle_url,
          bundle_version: p.bundle_version, builds: p.builds || {}, resale_cooldown_hours: p.resale_cooldown_hours,
          preview_url: (p.web_bundle_key || p.web_bundle_url) ? playUrlFor(p) : null,
          review_status: p.review_status, review_note: p.review_note, locked: hasOwners(p) })) });
    }

    // ---- SELLER: upload plumbing --------------------------------------
    // Every action here re-checks that the caller owns the product, and that any
    // client-supplied key sits under that product's own prefix.
    const ownedProduct = async (body) => {
      const seller = await nativePublisher(body);
      const pid = Number(body.product_id);
      const r = await sql`SELECT * FROM dev_native_products WHERE id = ${pid} AND seller_id = ${seller.id} AND deleted = false`;
      if (!r.rows[0]) throw Object.assign(new Error("no such game"), { status: 404 });
      return r.rows[0];
    };

    if (b.action === "native-upload-config") {
      return res.status(200).json({ ok: true, ready: r2Configured(),
        max_web_file: MAX_WEB_FILE, max_web_files: MAX_WEB_FILES, max_bundle: MAX_BUNDLE,
        max_build: MAX_BUILD, part_size: PART_SIZE, platforms: PLATFORMS, web_ext: [...WEB_EXT] });
    }

    // Web bundle: one presigned PUT per file. Version is bundle_version+1 until
    // the commit promotes it, so a failed upload never disturbs the live build.
    if (b.action === "native-web-sign") {
      const p = await ownedProduct(b);
      const files = Array.isArray(b.files) ? b.files : [];
      if (!files.length) return res.status(400).json({ error: "no files" });
      if (files.length > MAX_WEB_FILES) return res.status(400).json({ error: `too many files (max ${MAX_WEB_FILES})` });
      let total = 0;
      const out = [];
      for (const f of files) {
        const rel = safeRelPath(f && f.path);
        if (!rel) return res.status(400).json({ error: `refused file path: ${String((f && f.path) || "").slice(0, 80)}` });
        const size = Math.max(0, Number(f.size) || 0);
        if (size > MAX_WEB_FILE) return res.status(400).json({ error: `${rel} is too large` });
        total += size;
        if (total > MAX_BUNDLE) return res.status(400).json({ error: "bundle exceeds the size limit" });
        const version = (p.bundle_version || 0) + 1;
        out.push({ path: rel, key: webKey(p.id, version, rel), url: presignUrl({ method: "PUT", key: webKey(p.id, version, rel), expires: 3600 }) });
      }
      return res.status(200).json({ ok: true, version: (p.bundle_version || 0) + 1, files: out });
    }

    // Promote the uploaded bundle to live. index.html at the root is mandatory —
    // without it there is nothing for the store to load.
    if (b.action === "native-web-commit") {
      const p = await ownedProduct(b);
      const version = Number(b.version);
      if (!Number.isInteger(version) || version !== (p.bundle_version || 0) + 1) return res.status(400).json({ error: "stale upload — start again" });
      const paths = (Array.isArray(b.files) ? b.files : []).map((x) => safeRelPath(x)).filter(Boolean);
      if (!paths.includes("index.html")) return res.status(400).json({ error: "bundle needs an index.html at its top level" });
      const key = webKey(p.id, version, "index.html");
      // publicUrl only works while the bucket is public; the key is what the gate needs
      let url = null; try { url = publicUrl(key); } catch { url = null; }
      await sql`UPDATE dev_native_products SET web_bundle_url = ${url}, web_bundle_key = ${key},
        bundle_version = ${version}, runtime = 'web', updated_at = now() WHERE id = ${p.id}`;
      return res.status(200).json({ ok: true, version, web_bundle_url: url, files: paths.length });
    }

    // Desktop builds are far too big for a single PUT, so they go up in chunks.
    if (b.action === "native-build-start") {
      const p = await ownedProduct(b);
      const plat = PLATFORMS.includes(b.platform) ? b.platform : null;
      if (!plat) return res.status(400).json({ error: "platform must be win, mac or linux" });
      const file = safeFileName(b.filename);
      if (!file) return res.status(400).json({ error: "bad filename" });
      const size = Number(b.size) || 0;
      if (size > MAX_BUILD) return res.status(400).json({ error: "build exceeds the size limit" });
      const prev = (p.builds && p.builds[plat] && Number(p.builds[plat].version)) || 0;
      const key = buildKey(p.id, prev + 1, plat, file);
      const uploadId = await multipartCreate(key, b.content_type || "application/octet-stream");
      return res.status(200).json({ ok: true, key, uploadId, version: prev + 1, part_size: PART_SIZE });
    }

    if (b.action === "native-build-sign") {
      const p = await ownedProduct(b);
      if (!ownsKey(b.key, p.id)) return res.status(403).json({ error: "key does not belong to this game" });
      const n = Number(b.part_number);
      if (!Number.isInteger(n) || n < 1 || n > 10000) return res.status(400).json({ error: "bad part number" });
      if (!b.upload_id) return res.status(400).json({ error: "upload_id required" });
      return res.status(200).json({ ok: true, url: multipartPartUrl(b.key, String(b.upload_id), n) });
    }

    if (b.action === "native-build-complete") {
      const p = await ownedProduct(b);
      if (!ownsKey(b.key, p.id)) return res.status(403).json({ error: "key does not belong to this game" });
      const plat = PLATFORMS.includes(b.platform) ? b.platform : null;
      if (!plat) return res.status(400).json({ error: "bad platform" });
      const parts = (Array.isArray(b.parts) ? b.parts : [])
        .map((x) => ({ PartNumber: Number(x.PartNumber || x.part_number), ETag: String(x.ETag || x.etag || "") }))
        .filter((x) => Number.isInteger(x.PartNumber) && x.ETag);
      if (!parts.length) return res.status(400).json({ error: "no parts to finish" });
      await multipartComplete(b.key, String(b.upload_id), parts);
      const builds = { ...(p.builds || {}) };
      builds[plat] = {
        key: b.key, url: publicUrl(b.key), bytes: Number(b.size) || 0,
        sha256: typeof b.sha256 === "string" ? b.sha256.slice(0, 64) : null,
        version: Number(b.version) || 1, filename: b.key.split("/").pop(),
        uploaded_at: new Date().toISOString(),
      };
      await sql.query(`UPDATE dev_native_products SET builds = $1::jsonb, runtime = 'native', updated_at = now() WHERE id = $2`,
        [JSON.stringify(builds), p.id]);
      return res.status(200).json({ ok: true, builds });
    }

    if (b.action === "native-build-abort") {
      const p = await ownedProduct(b);
      if (!ownsKey(b.key, p.id)) return res.status(403).json({ error: "key does not belong to this game" });
      await multipartAbort(b.key, String(b.upload_id));
      return res.status(200).json({ ok: true });
    }

    if (b.action === "native-build-remove") {
      const p = await ownedProduct(b);
      const plat = PLATFORMS.includes(b.platform) ? b.platform : null;
      if (!plat) return res.status(400).json({ error: "bad platform" });
      const builds = { ...(p.builds || {}) };
      delete builds[plat];
      await sql.query(`UPDATE dev_native_products SET builds = $1::jsonb, updated_at = now() WHERE id = $2`,
        [JSON.stringify(builds), p.id]);
      return res.status(200).json({ ok: true, builds });
    }

    // ---- PUBLIC: the genre vocabulary --------------------------------
    if (b.action === "native-genres") {
      return res.status(200).json({ ok: true, genres: GENRES, max: MAX_GENRES });
    }

    // ---- PUBLIC: native storefront (active, listable games) ------------
    if (b.action === "native-market") {
      const rows = await sql`
        SELECT p.*, s.wallet AS seller_wallet, s.studio, s.avatar, s.standing
        FROM dev_native_products p JOIN dev_sellers s ON s.id = p.seller_id
        WHERE p.active = true AND p.deleted = false AND s.status = 'approved'
          AND p.review_status = 'approved' AND s.native_status = 'approved'
        ORDER BY p.created_at DESC LIMIT 200`;
      const games = rows.rows
        .filter((p) => !(p.supply_model === "finite" && availOf(p) <= 0)) // hide sold-out finite runs
        .map((p) => publicProduct(p, { wallet: p.seller_wallet, studio: p.studio, avatar: p.avatar, standing: p.standing }));
      return res.status(200).json({ ok: true, games });
    }

    // ---- PUBLIC: a single native game page -----------------------------
    if (b.action === "native-view") {
      const pid = Number(b.product_id);
      const r = await sql`
        SELECT p.*, s.wallet AS seller_wallet, s.studio, s.avatar, s.bio, s.website, s.socials, s.standing
        FROM dev_native_products p JOIN dev_sellers s ON s.id = p.seller_id
        WHERE p.id = ${pid} AND p.deleted = false AND s.status = 'approved'`;
      const p = r.rows[0];
      if (!p) return res.status(404).json({ error: "game not found" });
      return res.status(200).json({
        ok: true,
        product: publicProduct(p, { wallet: p.seller_wallet, studio: p.studio, avatar: p.avatar, standing: p.standing }),
        dev: { wallet: p.seller_wallet, studio: p.studio, avatar: p.avatar, bio: p.bio, website: p.website, socials: p.socials, trusted: p.standing === "trusted" },
      });
    }

    return res.status(400).json({ error: "unknown native action" });
  } catch (err) {
    const code = err.status || 500;
    if (code === 500) console.error("nativemarket error:", err);
    return res.status(code).json({ error: String(err.message || err) });
  }
}
