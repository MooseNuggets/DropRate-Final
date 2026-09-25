// ============================================================================
// DROPRATE — Game SDK: achievements, cloud saves, leaderboards.
//
// The Steamworks layer. A game never sees a wallet key; it sees a short-lived
// TICKET that names one wallet and one game, issued by something that already
// proved ownership (the paired launcher, or the web player with a signed
// wallet). Every SDK call carries that ticket. The server ties the call to the
// wallet+game inside it and refuses anything else, so a game cannot unlock an
// achievement for someone else, read another game's saves, or post a score to
// a board it doesn't own.
//
// Reachable two ways, same handler:
//   POST /sdk/v1/<action>            — for games (vercel.json rewrites to /api/crate?sdk=<action>)
//   POST /api/crate {ns:"devmarket", action:"sdk-<action>"} — for our own pages
//
// Ticket format: base64url(json).base64url(hmac-sha256)  (a compact, stateless
// token — nothing to store, nothing to revoke except by expiry; 12h default).
// Secret: SDK_TICKET_SECRET, or derived from CODE_VAULT_KEY if unset.
// ============================================================================

import { createHmac, timingSafeEqual } from "node:crypto";
import { sql } from "./db.js";
import { verifyWalletSignature } from "./vault.js";

const TICKET_TTL = Number(process.env.SDK_TICKET_TTL_SEC || 12 * 3600);
const SIG_TTL = Number(process.env.DEV_SIG_TTL_SEC || 300);
const MAX_ACH = 200;              // achievements per game
const MAX_BOARDS = 50;            // leaderboards per game
const MAX_SAVE_BYTES = 1_000_000; // per slot (base64 length counted after decode)
const MAX_SLOTS = 8;              // save slots per wallet per game
const KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;

const httpErr = (code, msg) => { const e = new Error(msg); e.status = code; throw e; };
const b64u = (buf) => Buffer.from(buf).toString("base64url");

function secret() {
  const s = process.env.SDK_TICKET_SECRET;
  if (s) return s;
  const k = process.env.CODE_VAULT_KEY;
  if (!k) httpErr(500, "SDK is not configured (SDK_TICKET_SECRET)");
  return createHmac("sha256", k).update("droprate-sdk-ticket").digest("hex");
}

// ---- tickets ---------------------------------------------------------------
export function issueTicket({ wallet, productId, source }, ttl = TICKET_TTL) {
  const now = Math.floor(Date.now() / 1000);
  const body = { w: String(wallet), p: Number(productId), s: String(source || "web"), iat: now, exp: now + ttl };
  const payload = b64u(JSON.stringify(body));
  const sig = createHmac("sha256", secret()).update(payload).digest("base64url");
  return { ticket: `${payload}.${sig}`, expires_at: body.exp * 1000, wallet: body.w, product_id: body.p };
}
export function verifyTicket(ticket) {
  if (typeof ticket !== "string" || !ticket.includes(".")) httpErr(401, "ticket required");
  const [payload, sig] = ticket.split(".");
  const want = createHmac("sha256", secret()).update(payload).digest("base64url");
  const a = Buffer.from(sig || ""), b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) httpErr(401, "ticket signature invalid");
  let body;
  try { body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { httpErr(401, "ticket malformed"); }
  if (!body || !body.w || !body.p) httpErr(401, "ticket malformed");
  if (Math.floor(Date.now() / 1000) > Number(body.exp)) httpErr(401, "ticket expired — relaunch the game");
  return { wallet: body.w, productId: Number(body.p), source: body.s || "web", exp: body.exp };
}
function ticketFrom(req, b) {
  const h = String((req && req.headers && req.headers.authorization) || "");
  const t = h.startsWith("Bearer ") ? h.slice(7).trim() : (b && b.ticket);
  return verifyTicket(t);
}

// ---- signed-request auth (same contract as the rest of the dev portal) ------
function assertSig(b) {
  const { wallet, message, signature } = b;
  if (!wallet || !message || !signature) httpErr(400, "wallet, message, signature required");
  if (!message.includes(`wallet:${wallet}`)) httpErr(401, "message/wallet mismatch");
  const m = /ts:(\d+)/.exec(message); const ts = m ? Number(m[1]) : 0;
  if (!ts || Math.abs(Date.now() / 1000 - ts) > SIG_TTL) httpErr(401, "signature expired — retry");
  let ok = false; try { ok = verifyWalletSignature(message, String(signature), wallet); } catch { ok = false; }
  if (!ok) httpErr(401, "signature verification failed");
  return wallet;
}
/* The developer who owns this product, via signed wallet. */
async function ownerOf(b) {
  const wallet = assertSig(b);
  const pid = Number(b.product_id);
  const r = await sql`
    SELECT p.id, p.title FROM dev_native_products p JOIN dev_sellers s ON s.id = p.seller_id
    WHERE p.id = ${pid} AND p.deleted = false AND s.wallet = ${wallet}`;
  if (!r.rows[0]) httpErr(403, "not your game");
  return { wallet, product: r.rows[0] };
}

// ---- schema ----------------------------------------------------------------
let mig = null;
function migrate() {
  if (!mig) mig = run().catch((e) => { mig = null; throw e; });
  return mig;
}
async function run() {
  await sql`CREATE TABLE IF NOT EXISTS game_achievements(
    id serial PRIMARY KEY,
    product_id int NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    icon text,                                   -- URL or data: image, optional
    hidden boolean NOT NULL DEFAULT false,       -- hidden until unlocked
    points int NOT NULL DEFAULT 10,
    sort int NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(product_id, key)
  )`;
  await sql`CREATE TABLE IF NOT EXISTS player_achievements(
    product_id int NOT NULL,
    wallet text NOT NULL,
    key text NOT NULL,
    unlocked_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(product_id, wallet, key)
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_player_ach_wallet ON player_achievements(wallet, product_id)`;
  await sql`CREATE TABLE IF NOT EXISTS game_saves(
    product_id int NOT NULL,
    wallet text NOT NULL,
    slot text NOT NULL,
    data text NOT NULL,                          -- base64
    bytes int NOT NULL,
    version int NOT NULL DEFAULT 1,
    label text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(product_id, wallet, slot)
  )`;
  await sql`CREATE TABLE IF NOT EXISTS game_boards(
    id serial PRIMARY KEY,
    product_id int NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    sort_dir text NOT NULL DEFAULT 'desc',       -- desc = higher is better, asc = lower (times)
    unit text,                                   -- display hint: "pts", "s", "m", …
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(product_id, key)
  )`;
  await sql`CREATE TABLE IF NOT EXISTS game_scores(
    product_id int NOT NULL,
    board text NOT NULL,
    wallet text NOT NULL,
    score bigint NOT NULL,
    meta text,                                   -- free-form, ≤ 200 chars (replay id, character…)
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(product_id, board, wallet)
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_scores_board ON game_scores(product_id, board, score)`;
}

// ---- helpers ---------------------------------------------------------------
const cleanKey = (k) => { const s = String(k || "").trim(); if (!KEY_RE.test(s)) httpErr(400, `bad key "${s}" — letters, digits, _ . - only, ≤64 chars`); return s.toLowerCase(); };
const shortW = (w) => (w && w.length > 12 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w);

async function achievementsFor(productId, wallet) {
  const defs = await sql`SELECT key, name, description, icon, hidden, points, sort FROM game_achievements WHERE product_id = ${productId} ORDER BY sort, id`;
  const have = wallet
    ? new Map((await sql`SELECT key, unlocked_at FROM player_achievements WHERE product_id = ${productId} AND wallet = ${wallet}`).rows.map((r) => [r.key, r.unlocked_at]))
    : new Map();
  const list = defs.rows.map((a) => {
    const unlocked = have.has(a.key);
    // A hidden achievement stays a mystery until this wallet earns it.
    const secret = a.hidden && !unlocked;
    return {
      key: a.key, name: secret ? "Hidden achievement" : a.name,
      description: secret ? "Keep playing to find out." : a.description,
      icon: secret ? null : a.icon, hidden: !!a.hidden, points: a.points,
      unlocked, unlocked_at: unlocked ? have.get(a.key) : null,
    };
  });
  const total = list.length, got = list.filter((x) => x.unlocked).length;
  const points = list.reduce((a, x) => a + (x.unlocked ? x.points : 0), 0);
  return { achievements: list, total, unlocked: got, points };
}

// ---------------------------------------------------------------------------
export async function gamesdk(req, res, action, b) {
  b = b || {};
  try {
    await migrate();
    const a = String(action || "").replace(/^sdk-/, "");

    // ======================= TICKETS =======================================
    /* Web player: a wallet that SIGNED for this product gets a ticket, provided
       it owns a copy (or the game is a public demo — then anyone signed-in can
       track progress). Anonymous demo players get no ticket and play as guests. */
    if (a === "ticket-web") {
      const wallet = assertSig(b);
      const pid = Number(b.product_id);
      const r = await sql`SELECT id, demo_public FROM dev_native_products WHERE id = ${pid} AND deleted = false`;
      const p = r.rows[0]; if (!p) httpErr(404, "game not found");
      if (!p.demo_public) {
        const { walletOwnsCopy } = await import("./nativebuy.js");
        const o = await walletOwnsCopy(pid, wallet);
        if (!o.owns) httpErr(403, "this wallet doesn't own a copy");
      }
      return res.status(200).json({ ok: true, ...issueTicket({ wallet, productId: pid, source: "web" }) });
    }
    /* Developer test ticket for their own game — so an SDK integration can be
       exercised before a single copy is sold. Progress is real (it's their wallet). */
    if (a === "ticket-dev") {
      const { wallet, product } = await ownerOf(b);
      return res.status(200).json({ ok: true, ...issueTicket({ wallet, productId: product.id, source: "dev" }, 3600) });
    }
    /* Who am I? Lets a game confirm its ticket is good before showing UI. */
    if (a === "whoami") {
      const t = ticketFrom(req, b);
      return res.status(200).json({ ok: true, wallet: t.wallet, product_id: t.productId, source: t.source, expires_at: t.exp * 1000 });
    }

    // ======================= ACHIEVEMENTS ==================================
    // -- developer: replace the whole definition list (idempotent, ordered) --
    if (a === "ach-set") {
      const { product } = await ownerOf(b);
      const items = Array.isArray(b.achievements) ? b.achievements : [];
      if (items.length > MAX_ACH) httpErr(400, `max ${MAX_ACH} achievements`);
      const keys = new Set();
      const clean = items.map((it, i) => {
        const key = cleanKey(it.key);
        if (keys.has(key)) httpErr(400, `duplicate key ${key}`); keys.add(key);
        const name = String(it.name || "").trim().slice(0, 80); if (!name) httpErr(400, `achievement ${key} needs a name`);
        const icon = it.icon ? String(it.icon).slice(0, 400_000) : null;
        const points = Math.max(0, Math.min(1000, Number(it.points) || 10));
        return { key, name, description: String(it.description || "").trim().slice(0, 300), icon, hidden: it.hidden === true, points, sort: i };
      });
      // Delete definitions that were removed; upsert the rest. Unlocks for a
      // removed key are kept (harmless) so re-adding it later restores them.
      const keep = clean.map((c) => c.key);
      if (keep.length) await sql`DELETE FROM game_achievements WHERE product_id = ${product.id} AND NOT (key = ANY(${keep}))`;
      else await sql`DELETE FROM game_achievements WHERE product_id = ${product.id}`;
      for (const c of clean) {
        await sql`INSERT INTO game_achievements(product_id, key, name, description, icon, hidden, points, sort)
                  VALUES (${product.id}, ${c.key}, ${c.name}, ${c.description}, ${c.icon}, ${c.hidden}, ${c.points}, ${c.sort})
                  ON CONFLICT (product_id, key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
                    icon = EXCLUDED.icon, hidden = EXCLUDED.hidden, points = EXCLUDED.points, sort = EXCLUDED.sort`;
      }
      const stats = await sql`SELECT key, count(*)::int AS n FROM player_achievements WHERE product_id = ${product.id} GROUP BY key`;
      return res.status(200).json({ ok: true, count: clean.length, unlock_counts: Object.fromEntries(stats.rows.map((r) => [r.key, r.n])) });
    }
    // -- developer: read definitions + how many players have each --
    if (a === "ach-dev-list") {
      const { product } = await ownerOf(b);
      const defs = await sql`SELECT key, name, description, icon, hidden, points, sort FROM game_achievements WHERE product_id = ${product.id} ORDER BY sort, id`;
      const stats = await sql`SELECT key, count(*)::int AS n FROM player_achievements WHERE product_id = ${product.id} GROUP BY key`;
      const n = Object.fromEntries(stats.rows.map((r) => [r.key, r.n]));
      return res.status(200).json({ ok: true, achievements: defs.rows.map((d) => ({ ...d, unlocked_by: n[d.key] || 0 })) });
    }
    // -- public: for the store page (optionally personalised by wallet, unsigned is fine: read-only) --
    if (a === "ach-public") {
      const pid = Number(b.product_id);
      const wallet = b.wallet ? String(b.wallet) : null;
      return res.status(200).json({ ok: true, ...(await achievementsFor(pid, wallet)) });
    }
    // -- game: list with this player's progress --
    if (a === "ach-list") {
      const t = ticketFrom(req, b);
      return res.status(200).json({ ok: true, ...(await achievementsFor(t.productId, t.wallet)) });
    }
    // -- game: unlock (idempotent) --
    if (a === "ach-unlock") {
      const t = ticketFrom(req, b);
      const key = cleanKey(b.key);
      const def = await sql`SELECT key, name, description, icon, points FROM game_achievements WHERE product_id = ${t.productId} AND key = ${key}`;
      if (!def.rows[0]) httpErr(404, `no achievement "${key}" defined for this game`);
      const ins = await sql`INSERT INTO player_achievements(product_id, wallet, key) VALUES (${t.productId}, ${t.wallet}, ${key})
                            ON CONFLICT DO NOTHING RETURNING unlocked_at`;
      const fresh = ins.rows.length > 0;
      return res.status(200).json({ ok: true, unlocked: true, new: fresh, achievement: def.rows[0] });
    }

    // ======================= CLOUD SAVES ===================================
    if (a === "save-put") {
      const t = ticketFrom(req, b);
      const slot = cleanKey(b.slot || "default");
      const data = typeof b.data === "string" ? b.data : "";
      let bytes; try { bytes = Buffer.from(data, "base64").length; } catch { httpErr(400, "data must be base64"); }
      if (!data || bytes === 0) httpErr(400, "data required (base64)");
      if (bytes > MAX_SAVE_BYTES) httpErr(413, `save too large (${bytes} > ${MAX_SAVE_BYTES} bytes)`);
      const label = b.label ? String(b.label).slice(0, 120) : null;
      const cur = await sql`SELECT version FROM game_saves WHERE product_id = ${t.productId} AND wallet = ${t.wallet} AND slot = ${slot}`;
      const have = cur.rows[0];
      if (!have) {
        const n = await sql`SELECT count(*)::int AS n FROM game_saves WHERE product_id = ${t.productId} AND wallet = ${t.wallet}`;
        if (n.rows[0].n >= MAX_SLOTS) httpErr(409, `max ${MAX_SLOTS} save slots`);
      }
      /* Optimistic concurrency: a client that says which version it last read
         only wins if that's still current. Two devices can't silently stomp
         each other; the loser re-reads and decides. Omit `version` to force. */
      if (have && b.version != null && Number(b.version) !== Number(have.version)) {
        return res.status(409).json({ error: "save-conflict", current_version: have.version });
      }
      const next = have ? Number(have.version) + 1 : 1;
      await sql`INSERT INTO game_saves(product_id, wallet, slot, data, bytes, version, label, updated_at)
                VALUES (${t.productId}, ${t.wallet}, ${slot}, ${data}, ${bytes}, ${next}, ${label}, now())
                ON CONFLICT (product_id, wallet, slot) DO UPDATE SET data = EXCLUDED.data, bytes = EXCLUDED.bytes,
                  version = EXCLUDED.version, label = EXCLUDED.label, updated_at = now()`;
      return res.status(200).json({ ok: true, slot, version: next, bytes });
    }
    if (a === "save-get") {
      const t = ticketFrom(req, b);
      const slot = cleanKey(b.slot || "default");
      const r = await sql`SELECT data, bytes, version, label, updated_at FROM game_saves WHERE product_id = ${t.productId} AND wallet = ${t.wallet} AND slot = ${slot}`;
      if (!r.rows[0]) return res.status(200).json({ ok: true, slot, exists: false });
      return res.status(200).json({ ok: true, slot, exists: true, ...r.rows[0] });
    }
    if (a === "save-list") {
      const t = ticketFrom(req, b);
      const r = await sql`SELECT slot, bytes, version, label, updated_at FROM game_saves WHERE product_id = ${t.productId} AND wallet = ${t.wallet} ORDER BY updated_at DESC`;
      return res.status(200).json({ ok: true, slots: r.rows, max_slots: MAX_SLOTS, max_bytes: MAX_SAVE_BYTES });
    }
    if (a === "save-delete") {
      const t = ticketFrom(req, b);
      const slot = cleanKey(b.slot || "default");
      const r = await sql`DELETE FROM game_saves WHERE product_id = ${t.productId} AND wallet = ${t.wallet} AND slot = ${slot}`;
      return res.status(200).json({ ok: true, slot, deleted: (r.rowCount || 0) > 0 });
    }

    // ======================= LEADERBOARDS ==================================
    if (a === "board-set") {
      const { product } = await ownerOf(b);
      const items = Array.isArray(b.boards) ? b.boards : [];
      if (items.length > MAX_BOARDS) httpErr(400, `max ${MAX_BOARDS} leaderboards`);
      const keys = new Set();
      const clean = items.map((it) => {
        const key = cleanKey(it.key); if (keys.has(key)) httpErr(400, `duplicate board ${key}`); keys.add(key);
        const name = String(it.name || "").trim().slice(0, 80); if (!name) httpErr(400, `board ${key} needs a name`);
        return { key, name, sort_dir: it.sort === "asc" ? "asc" : "desc", unit: it.unit ? String(it.unit).slice(0, 12) : null };
      });
      const keep = clean.map((c) => c.key);
      if (keep.length) await sql`DELETE FROM game_boards WHERE product_id = ${product.id} AND NOT (key = ANY(${keep}))`;
      else await sql`DELETE FROM game_boards WHERE product_id = ${product.id}`;
      for (const c of clean) {
        await sql`INSERT INTO game_boards(product_id, key, name, sort_dir, unit) VALUES (${product.id}, ${c.key}, ${c.name}, ${c.sort_dir}, ${c.unit})
                  ON CONFLICT (product_id, key) DO UPDATE SET name = EXCLUDED.name, sort_dir = EXCLUDED.sort_dir, unit = EXCLUDED.unit`;
      }
      return res.status(200).json({ ok: true, count: clean.length });
    }
    if (a === "board-dev-list") {
      const { product } = await ownerOf(b);
      const r = await sql`SELECT b.key, b.name, b.sort_dir, b.unit,
                            (SELECT count(*)::int FROM game_scores s WHERE s.product_id = b.product_id AND s.board = b.key) AS entries
                          FROM game_boards b WHERE b.product_id = ${product.id} ORDER BY b.id`;
      return res.status(200).json({ ok: true, boards: r.rows });
    }
    /* Developer moderation: wipe one wallet's entry (cheaters) or a whole board. */
    if (a === "score-remove") {
      const { product } = await ownerOf(b);
      const board = cleanKey(b.board);
      const r = b.wallet_target
        ? await sql`DELETE FROM game_scores WHERE product_id = ${product.id} AND board = ${board} AND wallet = ${String(b.wallet_target)}`
        : await sql`DELETE FROM game_scores WHERE product_id = ${product.id} AND board = ${board}`;
      return res.status(200).json({ ok: true, removed: r.rowCount || 0 });
    }
    // -- game: submit; keeps the player's BEST per board (direction-aware) --
    if (a === "score-submit") {
      const t = ticketFrom(req, b);
      const board = cleanKey(b.board);
      const def = (await sql`SELECT sort_dir FROM game_boards WHERE product_id = ${t.productId} AND key = ${board}`).rows[0];
      if (!def) httpErr(404, `no leaderboard "${board}" defined for this game`);
      const score = Number(b.score);
      if (!Number.isFinite(score) || Math.abs(score) > 9e15) httpErr(400, "score must be a number");
      const s = BigInt(Math.round(score));
      const meta = b.meta ? String(b.meta).slice(0, 200) : null;
      const cur = (await sql`SELECT score FROM game_scores WHERE product_id = ${t.productId} AND board = ${board} AND wallet = ${t.wallet}`).rows[0];
      const better = !cur || (def.sort_dir === "asc" ? s < BigInt(cur.score) : s > BigInt(cur.score));
      if (better) {
        await sql`INSERT INTO game_scores(product_id, board, wallet, score, meta, updated_at) VALUES (${t.productId}, ${board}, ${t.wallet}, ${s.toString()}, ${meta}, now())
                  ON CONFLICT (product_id, board, wallet) DO UPDATE SET score = EXCLUDED.score, meta = EXCLUDED.meta, updated_at = now()`;
      }
      const rank = (await sql`SELECT count(*)::int + 1 AS rank FROM game_scores
        WHERE product_id = ${t.productId} AND board = ${board}
          AND (CASE WHEN ${def.sort_dir} = 'asc' THEN score < ${(better ? s : BigInt(cur.score)).toString()}::bigint ELSE score > ${(better ? s : BigInt(cur.score)).toString()}::bigint END)`).rows[0].rank;
      return res.status(200).json({ ok: true, board, accepted: better, best: (better ? s : BigInt(cur.score)).toString(), rank });
    }
    // -- game / public: top N (ticket optional; if present, includes "me") --
    if (a === "score-top") {
      let pid = Number(b.product_id), me = null;
      try { const t = ticketFrom(req, b); pid = t.productId; me = t.wallet; } catch { /* public read */ }
      const board = cleanKey(b.board);
      const def = (await sql`SELECT name, sort_dir, unit FROM game_boards WHERE product_id = ${pid} AND key = ${board}`).rows[0];
      if (!def) httpErr(404, `no leaderboard "${board}"`);
      const limit = Math.max(1, Math.min(100, Number(b.limit) || 25));
      const rows = def.sort_dir === "asc"
        ? await sql`SELECT wallet, score, meta, updated_at FROM game_scores WHERE product_id = ${pid} AND board = ${board} ORDER BY score ASC, updated_at ASC LIMIT ${limit}`
        : await sql`SELECT wallet, score, meta, updated_at FROM game_scores WHERE product_id = ${pid} AND board = ${board} ORDER BY score DESC, updated_at ASC LIMIT ${limit}`;
      const entries = rows.rows.map((r, i) => ({ rank: i + 1, wallet: r.wallet, player: shortW(r.wallet), score: String(r.score), meta: r.meta, at: r.updated_at, me: me === r.wallet }));
      let mine = null;
      if (me) {
        const cur = (await sql`SELECT score, meta FROM game_scores WHERE product_id = ${pid} AND board = ${board} AND wallet = ${me}`).rows[0];
        if (cur) {
          const rank = (await sql`SELECT count(*)::int + 1 AS rank FROM game_scores WHERE product_id = ${pid} AND board = ${board}
            AND (CASE WHEN ${def.sort_dir} = 'asc' THEN score < ${String(cur.score)}::bigint ELSE score > ${String(cur.score)}::bigint END)`).rows[0].rank;
          mine = { rank, score: String(cur.score), meta: cur.meta };
        }
      }
      const total = (await sql`SELECT count(*)::int AS n FROM game_scores WHERE product_id = ${pid} AND board = ${board}`).rows[0].n;
      return res.status(200).json({ ok: true, board, name: def.name, sort: def.sort_dir, unit: def.unit, total, entries, me: mine });
    }
    if (a === "board-list") {
      let pid = Number(b.product_id);
      try { pid = ticketFrom(req, b).productId; } catch { /* public */ }
      const r = await sql`SELECT key, name, sort_dir AS sort, unit FROM game_boards WHERE product_id = ${pid} ORDER BY id`;
      return res.status(200).json({ ok: true, boards: r.rows });
    }

    // ======================= PLAYER PROFILE (public, read-only) ============
    /* Everything a wallet has earned across all games — for the library page. */
    if (a === "player-summary") {
      const wallet = String(b.wallet || ""); if (!wallet) httpErr(400, "wallet required");
      const r = await sql`
        SELECT pa.product_id, p.title, p.image,
               count(*)::int AS unlocked,
               (SELECT count(*)::int FROM game_achievements g WHERE g.product_id = pa.product_id) AS total,
               coalesce(sum(g.points), 0)::int AS points
        FROM player_achievements pa
        JOIN dev_native_products p ON p.id = pa.product_id
        LEFT JOIN game_achievements g ON g.product_id = pa.product_id AND g.key = pa.key
        WHERE pa.wallet = ${wallet}
        GROUP BY pa.product_id, p.title, p.image ORDER BY max(pa.unlocked_at) DESC`;
      const points = r.rows.reduce((a, x) => a + x.points, 0);
      return res.status(200).json({ ok: true, wallet, points, games: r.rows });
    }

    return res.status(400).json({ error: `unknown sdk action "${a}"` });
  } catch (err) {
    const code = err.status || 500;
    if (code === 500) console.error("gamesdk error:", err);
    return res.status(code).json({ error: String(err.message || err) });
  }
}
