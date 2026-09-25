# DROPRATE

Hold $DROP, get tickets, win game keys. Landing page + snapshot service + eligibility checker.

## What's in here

```
index.html              landing page (edit CONFIG block at top of its <script>)
check.html              eligibility checker page
api/snapshot-tick.js    scheduler endpoint — GitHub Actions hits this every 15 min
api/check.js            eligibility lookup for the checker page
api/snapshots.js        public snapshot list (transparency)
lib/config.js           ALL tunables: 10k/ticket, 100 cap, 6h windows, K=4
lib/snapshot.js         window math, random offset, Helius fetch, aggregation
lib/merkle.js           snapshot merkle roots + inclusion proofs
lib/db.js               Postgres schema + queries (auto-migrates on first tick)
test/unit.test.js       run with: npm test
.github/workflows/      the 15-min cron
```

## Deploy steps (one time)

1. **Push this folder to a new GitHub repo**, import it into Vercel as usual.
2. **Add Vercel Postgres**: Vercel dashboard → your project → Storage → Create → Postgres.
   This auto-adds the `POSTGRES_*` env vars. Tables create themselves on first tick.
3. **Vercel env vars** (project → Settings → Environment Variables):
   - `HELIUS_API_KEY` — from helius.dev
   - `CRON_SECRET` — any long random string (generate one: `openssl rand -hex 32`)
   - `DROP_MINT` — leave unset until the pump.fun token exists; the tick idles until set
   - `ELIGIBILITY_START` — set to an ISO timestamp at graduation (e.g. `2026-08-20T00:00:00Z`);
     snapshots before it never count toward eligibility
4. **GitHub repo secrets** (repo → Settings → Secrets and variables → Actions):
   - `SITE_URL` — your deployed URL, e.g. `https://droprate.vercel.app` (no trailing slash)
   - `CRON_SECRET` — same value as in Vercel
5. **Exclusion list**: after the token exists, insert the pump.fun bonding curve address
   (and later the LP address) into the `exclusions` table via the Vercel Postgres query tab:
   ```sql
   INSERT INTO exclusions(wallet, label) VALUES ('CURVE_ADDRESS_HERE', 'pumpfun curve');
   ```

## At launch

- Edit the `CONFIG` block at the top of `index.html`'s script: launch timestamp, CA, pump.fun URL, socials. Push.
- Set `DROP_MINT` and `ELIGIBILITY_START` in Vercel. Redeploy (or it picks up on next request).
- Trigger a manual test tick: repo → Actions → snapshot-tick → Run workflow.

## How the random snapshots work

Every 15 minutes GitHub Actions pokes `/api/snapshot-tick`. On the first poke of each
6-hour window, the server draws a CSPRNG random offset (5–350 min) and stores it in the
DB — never returned in any response. Once the offset time passes, the next poke takes
the snapshot: fetch all holders via Helius, drop exclusions, combine balances per owner,
compute tickets (`floor(balance / 10,000)`, capped at 100), and publish the merkle root.
The actual `taken_at` time becomes public only after the fact.

Eligibility = present with ≥1 ticket in the last 4 consecutive taken snapshots (~24h).

## Tests

```
npm test
```
Covers: ticket floor/cap math, per-owner aggregation, exclusions, window boundaries,
offset bounds, due-time logic, merkle determinism and inclusion proofs.

## Raffle engine, free entry, claims (built)

New pieces:
```
api/draw-tick.js         commits future drand rounds, runs due draws, expires+redraws
api/draws.js             public draw list with seeds/winners
api/free-entry.js        free entry lane (1 ticket, one per wallet per draw)
api/claim.js             nonce + signature-verified one-time code delivery
api/snapshot-entries.js  public snapshot data (needed for third-party verification)
api/free-entries.js      public free-entry list per draw
draws.html               upcoming draws + free entry form + completed draw receipts
claim.html               winner claim page (Phantom/Solflare signMessage)
lib/draw.js              drand round math + deterministic weighted selection
lib/vault.js             AES-256-GCM code vault + ed25519 signature verify (zero deps)
scripts/verify-draw.js   anyone reproduces any draw: node scripts/verify-draw.js <site> <id>
```

### Randomness: drand

Each draw commits to a **future drand round number** (public 3-second randomness
beacon run by Cloudflare/EPFL/League of Entropy) the moment it's scheduled. The
randomness for that round does not exist until draw time, so nobody — including us —
can know or influence it. At draw time the server fetches the round from **three
independent relays and requires agreement**. Anyone can fetch the same round from
drand directly and re-run `scripts/verify-draw.js` to reproduce the winners.
(Switchboard VRF on Solana remains a documented upgrade path if on-chain seeds are
ever wanted.)

### Additional env vars

- `ADMIN_SECRET` — long random string for the admin API
- `CODE_VAULT_KEY` — 64 hex chars: `openssl rand -hex 32`. **Back this up** — codes
  are unrecoverable without it.
- `TURNSTILE_SECRET` (optional) — Cloudflare Turnstile for the free-entry form;
  without it a honeypot field is used.

### Payment rails (crates, store, marketplace)

Money flows on three rails. Which one applies is decided per product, not per user:

| Product | Currencies | Split / fee |
|---|---|---|
| Draws | $DROP only | — |
| Crates, paid in $DROP | $DROP | 70% treasury · 10% LP · 10% marketing · 10% burn. **10% off** if the wallet holds ≥ 100,000 $DROP (checked on-chain at quote time). |
| Crates, paid in USDC / SOL | USDC, SOL | 70% treasury · 15% marketing · 15% owner. No burn. **No discount**, even if the wallet holds $DROP. |
| Store + dev marketplace | USDC, SOL (dev picks one or both) | Flat 5% fee, dev keeps 95%. No holder discount, ever. |

Sell-backs refund 70% of what was paid, in the currency it was paid in.

Env vars for the rails:
- `TREASURY_WALLET`, `TREASURY_SECRET` — treasury (receives the 70% leg; signs refunds/payouts)
- `LP_WALLET`, `MARKETING_WALLET` — $DROP crate legs
- `OWNER_WALLET` — **new**: the founder wallet that receives the 15% owner leg on USDC/SOL crates.
  SOL/USDC crate checkout fails with `paymulti: OWNER_WALLET not set` until this exists.
- `USDC_MINT` — mainnet `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- `DEV_FEE_BPS` (default `500`) — the flat store/marketplace fee
- `SOLANA_PRIORITY_MICROLAMPORTS` (default `20000`) — priority fee on every built tx

### Running draws — the easy way: /admin.html

Open `https://YOURSITE/admin.html`, paste your `ADMIN_SECRET` (kept in memory only),
and you get:
- **Load mystery keys**: paste a week's worth, one per line — encrypted on arrival
  into a global pool. Draws pull from the pool automatically; no per-draw stocking.
- **Schedule draws**: pick a start date, days, times (default 3/day) → one click
  creates the whole week. Draws commit their drand rounds within 15 minutes.
- **Stock warning**: the dashboard tells you when the pool has fewer keys than
  upcoming draws need.
- Upcoming draws, recent winners with claim status, and exclusion management.

Mystery keys are the default: `game_title` is optional everywhere, winners see
"Mystery game key" until they redeem. Codes CAN still be pinned to a specific draw
(pass `draw_id` in add-codes) for special named-prize events — pinned codes are
used before pool codes.

### Running a draw (curl alternative)

Create a draw (announce the prize BEFORE the randomness exists — this is the commitment):
```bash
curl -X POST https://YOURSITE/api/admin -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"action":"create-draw","scheduled_at":"2026-08-20T18:00:00Z","prize_title":"Hollow Knight: Silksong (Steam)","n_winners":1}'
```
Stock its codes:
```bash
curl -X POST https://YOURSITE/api/admin -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"action":"add-codes","codes":["XXXXX-XXXXX-XXXXX","YYYYY-YYYYY-YYYYY"]}'   # global mystery pool
```
Add an exclusion (do the pump.fun curve address before the first snapshot):
```bash
curl -X POST https://YOURSITE/api/admin -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"action":"add-exclusion","wallet":"CURVE_ADDRESS","label":"pumpfun curve"}'
```
The GitHub Actions tick handles the rest automatically: commitment, running the draw
at its scheduled time, and 7-day expiry redraws.

### Eligibility timing

Eligibility runs from the very first snapshot — the mint never changes at graduation,
so as long as the curve address is excluded, day-one holders count immediately.
First draws become possible once 4 snapshots exist (~24h after the cron starts).

### Game SDK (achievements, cloud saves, leaderboards)

`lib/gamesdk.js`, reachable at `POST /sdk/v1/<action>` (CORS on; rewritten to
`/api/crate?sdk=<action>` by `vercel.json`) and from our own pages as
`{ns:"devmarket", action:"sdk-<action>"}`. Public docs: `/sdk.html`; browser client:
`/sdk/droprate.js`.

Auth is a **ticket** — an HMAC-signed `{wallet, product_id, exp}` — issued by:
- the launcher (`native-device-ticket`, device-token auth, ownership re-checked) → passed
  to the game as `DROPRATE_TICKET` / `DROPRATE_API` / `DROPRATE_WALLET` / `DROPRATE_PRODUCT` env vars
- the web player (`sdk-ticket-web`, wallet signature) → `postMessage` to the game iframe
- the dev portal (`sdk-ticket-dev`, one hour, for testing)

Env: `SDK_TICKET_SECRET` (any long random string; falls back to a key derived from
`CODE_VAULT_KEY` if unset — set it explicitly so rotating one doesn't invalidate the other).
Tables: `game_achievements`, `player_achievements`, `game_saves`, `game_boards`, `game_scores`.
