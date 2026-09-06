// ============================================================================
// DROPRATE — pairing a desktop launcher to a wallet.
//
// THE PROBLEM THE LAUNCHER HAS
//   Phantom and Solflare are browser extensions. A desktop app has no access to
//   them. So a launcher has three options: ship its own keypair (a game client
//   holding money keys — no), embed a browser and hope (fragile, and still the
//   extension's rules), or hand off to the browser the person already uses.
//
//   This is the handoff. It's the same shape as pairing a TV to a streaming
//   account, and it's deliberate: the wallet never leaves the browser, the
//   launcher never sees a private key, and the person approves a named device
//   they can see rather than a faceless request.
//
// THE FLOW
//   1. Launcher asks for a pairing  ->  gets a short CODE and a private POLL TOKEN
//   2. Person opens droprate.xyz/pair.html, signs with their wallet
//   3. Launcher, polling with its token, receives a long-lived DEVICE TOKEN
//   4. Everything after that is authenticated with the device token
//
// WHY THREE DIFFERENT TOKENS
//   The CODE is short so a human can read it off a screen and type it — which
//   also means it is weak, so it lives ten minutes and dies on first use.
//   The POLL TOKEN is the launcher's proof that IT started this pairing, so an
//   attacker who shoulder-surfs the code still cannot collect the result.
//   The DEVICE TOKEN is long, stored only as a hash, and is the actual key to
//   the account from then on. Conflating any two of these breaks the flow.
//
// WHAT A PAIRED DEVICE CAN AND CANNOT DO
//   Can: list the games that wallet owns, and fetch download links for them.
//   Cannot: spend anything, sign anything, or move an asset. Buying still
//   happens in the browser where the wallet lives. A stolen device token costs
//   its owner some downloads, not their library.
// ============================================================================

import { randomBytes, createHash } from "node:crypto";
import { sql } from "./db.js";
import { verifyWalletSignature } from "./vault.js";

const SIG_TTL = Number(process.env.DEV_SIG_TTL_SEC || 300);
const PAIR_TTL_SEC = Number(process.env.LAUNCHER_PAIR_TTL_SEC || 600);        // 10 minutes to approve
const DEVICE_TTL_DAYS = Number(process.env.LAUNCHER_DEVICE_TTL_DAYS || 180);  // re-pair twice a year
const MAX_DEVICES = Number(process.env.LAUNCHER_MAX_DEVICES || 10);

const httpErr = (code, msg) => { const e = new Error(msg); e.status = code; throw e; };

/* Human-typeable: no 0/O/1/I/L, grouped for reading aloud. Short because a
   person copies it by eye — and safe to be short because it expires in ten
   minutes, dies on first use, and cannot be redeemed without the poll token. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function makeCode() {
  const b = randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
const makeSecret = () => randomBytes(32).toString("base64url");

/* Device tokens are stored hashed, like passwords. A leaked database read then
   yields nothing usable — the same reason we never store a Steam key in clear. */
const tokenSalt = () =>
  process.env.LAUNCHER_TOKEN_SALT || process.env.KEY_HASH_SALT || process.env.ADMIN_SECRET || "droprate";
const hashToken = (t) => createHash("sha256").update(`${tokenSalt()}:${t}`).digest("hex");

// ---- signed-request auth, same contract as everywhere else -----------------
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
async function migrateDevices() {
  if (migrated) return;
  await sql`CREATE TABLE IF NOT EXISTS dev_devices(
    id serial PRIMARY KEY,
    code text,                                  -- short, human-typed, cleared on use
    poll_hash text NOT NULL,                    -- hash of the launcher's private poll token
    token_hash text,                            -- hash of the long-lived device token
    wallet text,                                -- bound at approval
    name text NOT NULL DEFAULT 'Desktop',
    platform text NOT NULL DEFAULT 'unknown',
    status text NOT NULL DEFAULT 'pending',     -- pending | approved | active | revoked | expired
    created_at timestamptz NOT NULL DEFAULT now(),
    approved_at timestamptz,
    last_seen_at timestamptz,
    expires_at timestamptz NOT NULL
  )`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_device_code ON dev_devices(code) WHERE code IS NOT NULL`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_device_token ON dev_devices(token_hash) WHERE token_hash IS NOT NULL`;
  await sql`CREATE INDEX IF NOT EXISTS idx_device_wallet ON dev_devices(wallet)`;
  migrated = true;
}

/* Opportunistic cleanup. Pairings nobody completed are litter, and an expired
   code that still resolves is a code that can still be typed at someone. */
async function sweep() {
  await sql`UPDATE dev_devices SET status = 'expired', code = NULL
    WHERE status = 'pending' AND expires_at < now()`;
  /* Approved but never collected: the person said yes and the launcher never
     came back for it. Same ten-minute window — an approval left lying around is
     a token waiting to be claimed by whoever finds the poll token. */
  await sql`UPDATE dev_devices SET status = 'expired', poll_hash = 'expired'
    WHERE status = 'approved' AND approved_at < now() - interval '10 minutes'`;
  await sql`UPDATE dev_devices SET status = 'expired', token_hash = NULL
    WHERE status = 'active' AND expires_at < now()`;
}

const publicDevice = (d) => ({
  id: d.id, name: d.name, platform: d.platform, status: d.status,
  created_at: d.created_at, approved_at: d.approved_at, last_seen_at: d.last_seen_at,
  expires_at: d.expires_at,
});

/* Resolve a device token to its row, or throw. Every launcher call goes through
   this, so it also refreshes last_seen — which is what makes "this device was
   last used on Tuesday" possible on the revoke screen. */
export async function deviceFor(token) {
  if (!token || typeof token !== "string" || token.length < 20) httpErr(401, "device token required");
  const r = await sql`SELECT * FROM dev_devices WHERE token_hash = ${hashToken(token)}`;
  const d = r.rows[0];
  if (!d) httpErr(401, "this device is not paired — pair it again from the launcher");
  if (d.status !== "active") httpErr(401, `this device was ${d.status} — pair it again`);
  if (new Date(d.expires_at).getTime() < Date.now()) {
    await sql`UPDATE dev_devices SET status = 'expired', token_hash = NULL WHERE id = ${d.id}`;
    httpErr(401, "this device's pairing expired — pair it again");
  }
  await sql`UPDATE dev_devices SET last_seen_at = now() WHERE id = ${d.id}`;
  return d;
}

const clean = (s, n, fallback) => {
  const v = String(s || "").replace(/[^\w \-.'()]/g, "").trim().slice(0, n);
  return v || fallback;
};

// ---------------------------------------------------------------------------
export async function devicepair(req, res, action, b) {
  await migrateDevices();

  // ---- LAUNCHER: begin a pairing -------------------------------------------
  if (action === "native-device-start") {
    await sweep();
    const code = makeCode();
    const pollToken = makeSecret();
    const expires = new Date(Date.now() + PAIR_TTL_SEC * 1000).toISOString();
    const r = await sql`
      INSERT INTO dev_devices(code, poll_hash, name, platform, status, expires_at)
      VALUES (${code}, ${hashToken(pollToken)}, ${clean(b.name, 40, "Desktop")},
              ${clean(b.platform, 20, "unknown")}, 'pending', ${expires})
      RETURNING id, code, expires_at`;
    const base = (process.env.SITE_BASE || "https://droprate.xyz").replace(/\/+$/, "");
    return res.status(200).json({
      ok: true,
      code: r.rows[0].code,
      poll_token: pollToken,                      // the launcher keeps this private
      pair_url: `${base}/pair.html?code=${encodeURIComponent(r.rows[0].code)}`,
      expires_at: r.rows[0].expires_at,
      expires_in: PAIR_TTL_SEC,
    });
  }

  // ---- BROWSER: what am I about to approve? --------------------------------
  // Unauthenticated on purpose: the page has to render the device name BEFORE
  // asking for a signature, or the person is approving something unnamed.
  if (action === "native-device-lookup") {
    await sweep();
    const code = String(b.code || "").trim().toUpperCase();
    if (!code) return res.status(400).json({ error: "code required" });
    const r = await sql`SELECT * FROM dev_devices WHERE code = ${code} AND status = 'pending'`;
    const d = r.rows[0];
    if (!d) return res.status(404).json({ error: "That code isn't valid any more. Start again in the launcher." });
    return res.status(200).json({
      ok: true, name: d.name, platform: d.platform,
      requested_at: d.created_at, expires_at: d.expires_at,
    });
  }

  // ---- BROWSER: approve it, with a wallet signature ------------------------
  if (action === "native-device-approve") {
    await sweep();
    const wallet = assertSig(b);
    const code = String(b.code || "").trim().toUpperCase();
    if (!code) return res.status(400).json({ error: "code required" });

    const r = await sql`SELECT * FROM dev_devices WHERE code = ${code} AND status = 'pending'`;
    const d = r.rows[0];
    if (!d) return res.status(404).json({ error: "That code isn't valid any more. Start again in the launcher." });

    /* A wallet with a hundred paired devices is a wallet somebody is farming.
       Cap it, and make the person retire one deliberately rather than silently
       dropping the oldest — their old machine going dark without explanation is
       worse than being told. */
    const live = await sql`SELECT COUNT(*)::int AS n FROM dev_devices
      WHERE wallet = ${wallet} AND status = 'active'`;
    if (live.rows[0].n >= MAX_DEVICES) {
      return res.status(409).json({
        error: `You've paired ${MAX_DEVICES} devices already. Sign one out first — you can do that from your library.`,
      });
    }

    /* NO device token is created here.

       It is minted at collection time by the launcher, which proves it started
       this pairing by presenting its poll token. That way the token only ever
       exists in the one place it belongs — a browser that never holds it cannot
       leak it, and we never have to store a usable secret while waiting.

       Clearing the code in the same statement is what makes it single-use: a
       second approval finds nothing pending. */
    const expires = new Date(Date.now() + DEVICE_TTL_DAYS * 86400 * 1000).toISOString();
    const done = await sql`
      UPDATE dev_devices
      SET status = 'approved', wallet = ${wallet}, code = NULL,
          approved_at = now(), expires_at = ${expires}
      WHERE id = ${d.id} AND status = 'pending'
      RETURNING id`;
    if (!done.rows.length) return res.status(409).json({ error: "That pairing was already used." });

    return res.status(200).json({ ok: true, name: d.name, platform: d.platform, wallet });
  }

  // ---- LAUNCHER: has it been approved yet? ---------------------------------
  if (action === "native-device-poll") {
    await sweep();
    const poll = String(b.poll_token || "");
    if (!poll) return res.status(400).json({ error: "poll_token required" });
    const r = await sql`SELECT * FROM dev_devices WHERE poll_hash = ${hashToken(poll)}`;
    const d = r.rows[0];
    if (!d) return res.status(404).json({ error: "unknown pairing" });

    if (d.status === "pending") return res.status(200).json({ ok: true, state: "pending" });
    if (d.status === "active") {
      // already handed over on an earlier poll — never issue a second token
      return res.status(200).json({ ok: true, state: "collected", wallet: d.wallet, name: d.name });
    }
    if (d.status !== "approved") return res.status(200).json({ ok: true, state: d.status });

    /* Mint and hand over, exactly once. The status guard is the lock: two polls
       racing each other means one UPDATE matches and the other doesn't, so only
       one caller ever receives a token. The plaintext is returned here and never
       stored — from this moment we hold only its hash. */
    const deviceToken = makeSecret();
    const claimed = await sql`
      UPDATE dev_devices SET status = 'active', token_hash = ${hashToken(deviceToken)},
        last_seen_at = now()
      WHERE id = ${d.id} AND status = 'approved'
      RETURNING id, wallet, name, expires_at`;
    if (!claimed.rows.length) {
      return res.status(200).json({ ok: true, state: "collected", wallet: d.wallet, name: d.name });
    }
    const row = claimed.rows[0];
    return res.status(200).json({
      ok: true, state: "paired",
      device_token: deviceToken,
      wallet: row.wallet, name: row.name, expires_at: row.expires_at,
    });
  }

  // ---- LAUNCHER: who am I? -------------------------------------------------
  if (action === "native-device-me") {
    const d = await deviceFor(b.device_token);
    return res.status(200).json({ ok: true, wallet: d.wallet, device: publicDevice(d) });
  }

  // ---- BROWSER: my paired devices ------------------------------------------
  if (action === "native-device-list") {
    const wallet = assertSig(b);
    const r = await sql`SELECT * FROM dev_devices
      WHERE wallet = ${wallet} AND status IN ('active','approved','expired')
      ORDER BY approved_at DESC NULLS LAST LIMIT 50`;
    return res.status(200).json({ ok: true, devices: r.rows.map(publicDevice) });
  }

  // ---- BROWSER: sign a device out ------------------------------------------
  if (action === "native-device-revoke") {
    const wallet = assertSig(b);
    const id = Number(b.device_id);
    const r = await sql`
      UPDATE dev_devices SET status = 'revoked', token_hash = NULL, code = NULL
      WHERE id = ${id} AND wallet = ${wallet} AND status = 'active'
      RETURNING id`;
    if (!r.rows.length) return res.status(404).json({ error: "no such device" });
    return res.status(200).json({ ok: true, revoked: id });
  }

  /* ---- LAUNCHER: the library, as the launcher needs it ---------------------
     Same ownership truth as the website — read off the chain, not our records —
     but shaped for an app: what's installable, which platforms, which build
     version, so the launcher can tell "you own this" from "you own this and it
     needs updating". */
  if (action === "native-device-library") {
    const d = await deviceFor(b.device_token);
    const { walletOwnsCopy } = await import("./nativebuy.js");
    const rows = await sql`
      SELECT c.asset_address, c.copy_number, c.minted_at,
             p.id AS product_id, p.title, p.slug, p.image, p.runtime,
             p.bundle_version, p.builds, p.tagline
      FROM dev_native_copies c JOIN dev_native_products p ON p.id = c.product_id
      WHERE c.first_owner = ${d.wallet} AND p.deleted = false
      ORDER BY c.minted_at DESC LIMIT 200`;

    const seen = new Set();
    const games = [];
    for (const row of rows.rows) {
      if (seen.has(row.product_id)) continue;     // one entry per game, not per copy
      seen.add(row.product_id);
      const owns = await walletOwnsCopy(row.product_id, d.wallet);
      const builds = row.builds || {};
      games.push({
        product_id: row.product_id, title: row.title, slug: row.slug,
        tagline: row.tagline, image: row.image, runtime: row.runtime,
        copy_number: row.copy_number, asset_address: row.asset_address,
        owned: owns.owns,
        build_version: row.bundle_version || 0,
        platforms: Object.keys(builds).filter((k) => builds[k] && builds[k].url),
      });
    }
    return res.status(200).json({ ok: true, wallet: d.wallet, games });
  }

  /* ---- LAUNCHER: a link to actually download a build ----------------------
     Ownership is re-checked against the chain HERE, not trusted from the
     library call a minute ago. A copy sold between the two is a copy this
     device no longer gets to download. */
  if (action === "native-device-download") {
    const d = await deviceFor(b.device_token);
    const pid = Number(b.product_id);
    const platform = String(b.platform || "").toLowerCase();
    if (!["win", "mac", "linux"].includes(platform)) {
      return res.status(400).json({ error: "platform must be win, mac or linux" });
    }

    const pr = await sql`SELECT * FROM dev_native_products WHERE id = ${pid} AND deleted = false`;
    const p = pr.rows[0];
    if (!p) return res.status(404).json({ error: "game not found" });

    const { walletOwnsCopy } = await import("./nativebuy.js");
    const owns = await walletOwnsCopy(pid, d.wallet);
    if (!owns.owns) {
      return res.status(403).json({ error: "This wallet doesn't own a copy of that game." });
    }

    const build = (p.builds || {})[platform];
    if (!build || !build.key) {
      return res.status(404).json({ error: `No ${platform} build has been uploaded for this game yet.` });
    }

    /* Long enough to FINISH, not just to start.

       This was an hour, which is wrong: a 10GB build on a 5 Mbps line takes
       about four and a half, so the link died mid-download and the launcher had
       no way to tell that from a network fault. Six hours covers a slow
       connection on a large game; anything slower resumes by asking again,
       which is cheap because ownership is re-checked on every request anyway. */
    const DOWNLOAD_TTL = Number(process.env.LAUNCHER_DOWNLOAD_TTL_SEC || 21600);
    const { presignUrl } = await import("./r2.js");
    const url = presignUrl({ method: "GET", key: build.key, expires: DOWNLOAD_TTL });
    return res.status(200).json({
      ok: true, product_id: pid, title: p.title, platform,
      url, expires_in: DOWNLOAD_TTL,
      bytes: build.bytes || null,
      build_version: p.bundle_version || 0,
      sha256: build.sha256 || null,     // present once uploads record it
    });
  }

  // ---- LAUNCHER: sign itself out -------------------------------------------
  if (action === "native-device-forget") {
    const d = await deviceFor(b.device_token);
    await sql`UPDATE dev_devices SET status = 'revoked', token_hash = NULL WHERE id = ${d.id}`;
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: `unknown action ${action}` });
}
