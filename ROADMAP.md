# DropRate roadmap — brainstorm of Sept 30

Working order, roughly. Each item is independent enough to ship on its own.

## 0. Housekeeping (before anything new)
- Commit and push the current batch: rentals + rent-to-own, play-page sign-in, pre-owned marketplace tab, delist fixes, buyer-screen cleanup.
- Cut a launcher release (v0.1.5) so the library shows "Rented · N days left".
- Live-test resale (list → buy from a second wallet) and a rental end to end on droprate.xyz.
- Still parked: Vercel Pro upgrade, buyback rule, second domain.

## 1. Identity — accounts for everyone
- Embedded wallets: sign up with email, Discord, X or Google and get a non-custodial Solana wallet behind the scenes. Candidates: Privy (best Solana SDK, key export, Stripe onramp; free to 499 MAU then $299/mo) or Web3Auth (cheapest, ~$69/mo for 3k MAU). Wrap behind our own provider interface so it's swappable.
- Crypto-native path stays first-class: connect Phantom / Solflare / Backpack / Ledger and the profile reads the shelf straight from the chain.
- A profile can link several wallets (embedded + hot + cold). Play gate checks all linked wallets; selling still requires the holding wallet to sign.
- Card onramp inside checkout ("Pay $10 with card" → USDC → purchase). The wallet isn't the scary part; funding it is.
- Never say "wallet" during signup. Address shows later on the profile; Settings has "Connect Phantom" and "Export keys".

## 2. Player profiles (native-only — no Steam keys, no crates)
- Handle (droprate.xyz/@name), display name, avatar, bio, header image. Public by default, with per-section privacy (playtime, activity).
- Showcase: pin your best copies — low serials, sold-out runs, limited editions. Verifiable, not cosmetic.
- Level from earned points only (never purchasable). Badges are checkable facts: first purchase, #1 serial holder, 100% a game, sold a copy, rent-to-own convert, etc. Off-chain to start.
- Achievements per game with progress; activity feed (bought, unlocked, listed, sold, rented).
- "Follow this developer" — the only social feature in v1. No friends, comments or groups yet.
- Web: profile menu on the wallet button (Profile, Achievements, Activity, Settings). Launcher: a Profile tab next to Store and Library.

## 3. Library hub
- Click a game in the library → hero art, playtime and last-played, achievement progress, your copy's serial and provenance, Play / Sell / Rent-again, and the developer's update feed underneath.
- Launcher-first; web library mirrors it read-only with "Play in the launcher".

## 4. Developer posts
- Portal "Updates" tab: title, body, optional image, optional version tag / patch notes.
- Shown on the store page, the library hub and the launcher. Owners and followers get notified (open question: push vs passive).

## 5. Playtime tracking
- Launcher reports sessions (process start → exit); web play page sends a heartbeat. Both ride the SDK ticket, no new auth.
- Feeds profile hours / last played, the library hub, and dev analytics in the portal. Prerequisite for trials.

## 6. Dev portal reorganization
- Per-game workspace with tabs: Overview (status, go-live checklist, sales / revenue / players / rentals / resales), Listing (store page + live preview), Pricing & access (price, currencies, supply, rentals, resale, pre-owned visibility — advanced sections collapsed), Builds (per platform, demo build, version history), SDK, Updates.
- Earnings / withdrawals and accepted currencies / payout wallet move to account-level settings.
- First-game wizard: name & price → cover & description → build → submit. Clear "can't go live yet because…" feedback.

## 7. Demo builds in the launcher
- Dev uploads a demo build next to the full build. Anyone with the launcher can install and play; ticket source "demo", saves and achievements stick to the wallet and carry over on purchase.
- Web game page "Play demo" → droprate:// deep link (or the download page if not installed). Web demos remain for devs who have them.

## 8. Timed trials (after playtime lands)
- Full build, free for the first N hours of playtime, then locks. A $0 rental measured in playtime — reuses the rental gate.

## Direction decisions
- Launcher is where people play; the web is where they find and try. Stop investing in web as an ownership surface.
- Steam-key products (crates, raffles, key resale) stay off the native side. When crates migrate to dropping native copies, they fold in.
- Buyer screens are about the game. Fee and royalty breakdowns appear only on the Sell sheet.

## Open questions to settle
- Playtime tracking on by default or opt-in?
- Profile decoration: colors + header image, or full themes?
- Dev posts: push notifications to owners, or passive feed?
- Embedded wallet provider: Privy vs Web3Auth (cost vs SDK quality).
