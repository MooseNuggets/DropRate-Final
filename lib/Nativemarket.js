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

import { sql } from "./db.js";
import { verifyWalletSignature } from "./vault.js";

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
const RUNTIMES = ["web", "native"]; // playable in-browser vs downloadable-via-launcher
const SUPPLY_MODELS = ["finite", "infinite"];
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
      const seller = await approvedSeller(b);
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
          supply_model, supply_cap, runtime, mobile_ready, genres)
        VALUES (${seller.id}, ${title}, ${slugify(title)}, ${b.tagline || null}, ${desc}, ${b.image || null},
          ${JSON.stringify(cleanMedia(b.media))}::jsonb, ${JSON.stringify(cleanVideos(b.videos))}::jsonb,
          ${cents}, ${royalty}, ${floor}, ${cooldown},
          ${supply_model}, ${supply_cap}, ${runtime},
          ${mobileFor(runtime, b.mobile_ready === true)}, ${JSON.stringify(cleanGenres(b.genres))}::jsonb)
        RETURNING id, slug, title, active`;
      return res.status(200).json({ ok: true, product: r.rows[0] });
    }

    // ---- SELLER: edit a native listing ----------------------------------
    if (b.action === "native-set") {
      const seller = await approvedSeller(b);
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
      const seller = await approvedSeller(b);
      const pid = Number(b.product_id);
      const r = await sql`UPDATE dev_native_products SET active = ${!!b.active}, updated_at = now()
        WHERE id = ${pid} AND seller_id = ${seller.id} AND deleted = false RETURNING id, active`;
      if (!r.rows.length) return res.status(404).json({ error: "no such game" });
      return res.status(200).json({ ok: true, active: r.rows[0].active });
    }

    // ---- SELLER: soft-delete a listing ---------------------------------
    if (b.action === "native-delete") {
      const seller = await approvedSeller(b);
      const pid = Number(b.product_id);
      const r = await sql`UPDATE dev_native_products SET deleted = true, active = false, updated_at = now()
        WHERE id = ${pid} AND seller_id = ${seller.id} RETURNING id`;
      if (!r.rows.length) return res.status(404).json({ error: "no such game" });
      return res.status(200).json({ ok: true, deleted: pid });
    }

    // ---- SELLER: my native games ---------------------------------------
    if (b.action === "native-mine") {
      const seller = await approvedSeller(b);
      const rows = await sql`SELECT * FROM dev_native_products
        WHERE seller_id = ${seller.id} AND deleted = false ORDER BY created_at DESC`;
      return res.status(200).json({ ok: true, games: rows.rows.map((p) => ({ ...publicProduct(p), active: p.active, web_bundle_url: p.web_bundle_url, builds: p.builds, resale_cooldown_hours: p.resale_cooldown_hours })) });
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
