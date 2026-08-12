// ============================================================================
// DROPRATE — Key loader (ADDITIVE, gacha only)
//
// Turns "a key + a game name + what I paid" into a ready-to-insert crate_keys
// row: auto-fetches MSRP from Steam, auto-suggests a rarity tier, and encrypts the
// code with the SAME vault the claim flow already uses (encryptCode/decryptCode).
// Pure of any DB — returns a plain record. The admin route does the insert.
// ============================================================================

import { encryptCode } from "./vault.js";
import { lookupGame } from "./steam.js";
import { tierFromMsrpCents } from "./gacha.js";

// Prepare ONE key.
//   input: { code, appInput?|gameName?, msrpCents?, costCents?, tierOverride? }
//   opts:  { vaultKey?, fetchJson?, lookup? }  (lookup:false skips Steam entirely)
export async function prepareKey(input, opts = {}) {
  const vaultKey = opts.vaultKey || process.env.CODE_VAULT_KEY;
  if (!vaultKey) throw new Error("loader: CODE_VAULT_KEY not set");

  const code = String(input.code || "").trim();
  if (!code) throw new Error("loader: empty code");
  // cost is OPTIONAL (skip it on big dumps). null = unknown -> no margin tracking.
  const costCents = Number.isFinite(input.costCents) && input.costCents >= 0 ? input.costCents : null;

let title = input.gameName || null;
  // Allow an inline tier override token in the name, e.g.
  //   "Batman: Arkham Collection | tier:legendary"  or  "... tier:legendary"
  // for bundles/editions Steam can't price. Strip it back out of the title.
  let inlineTier = null;
  if (title) {
    const m = title.match(/(?:^|[|\s])tier:(common|rare|epic|legendary)\b/i);
    if (m) {
      inlineTier = m[1].toLowerCase();
      title = title.replace(/\s*\|?\s*tier:(common|rare|epic|legendary)\b/i, "").trim() || null;
    }
  }
  let appid = null;
  let image = null;
  let msrpCents = input.msrpCents ?? null;

  // Try Steam unless explicitly disabled or nothing to look up.
  const lookupInput = input.appInput || input.gameName;
  if (lookupInput && opts.lookup !== false) {
    const game = await lookupGame(lookupInput, opts.fetchJson).catch(() => null);
    if (game) {
      title = title || game.name;
      appid = game.appid ?? null;
      image = game.image ?? null;
      if (msrpCents == null) msrpCents = game.msrpCents;
    }
  }

  // Tier: explicit override > auto from MSRP > hard error (never guess blindly).
 let rarity = input.tierOverride || inlineTier || null;
  let tierSource = "override";
  if (!rarity) {
    if (msrpCents == null) {
      throw new Error("loader: no MSRP found and no tier override — set one manually");
    }
    rarity = tierFromMsrpCents(msrpCents);
    tierSource = "auto";
  }

  return {
    rarity,
    tierSource,
    game_title: title,
    appid,
    image,
    msrp_cents: msrpCents ?? null,
    cost_cents: costCents,
    code_encrypted: encryptCode(code, vaultKey),
    status: "available",
  };
}

// Parse a pasted batch. One key per line, columns separated by | or a tab.
// Cost is OPTIONAL — if the LAST field looks like money it's read as cost, else
// it's part of the game name. All of these are valid:
//   CODE | Hades | 3.50     -> game "Hades", cost $3.50
//   CODE | Hades            -> game "Hades", no cost   (typical big dump)
//   CODE | 5                -> no game, cost $5
//   CODE                    -> code only (game/tier set later)
const MONEY = /^\$?\d+(\.\d+)?$/;
export function parseBatch(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s*[|\t]\s*/).map((s) => s.trim()).filter(Boolean);
    const code = parts[0];
    if (!code) { out.push({ raw: line, error: "empty code" }); continue; }
    let costCents = null;
    let gameParts = parts.slice(1);
    if (parts.length >= 2 && MONEY.test(parts[parts.length - 1])) {
      costCents = Math.round(parseFloat(parts[parts.length - 1].replace(/[^0-9.]/g, "")) * 100);
      gameParts = parts.slice(1, -1);
    }
    out.push({ raw: line, code, gameName: gameParts.join(" ") || null, costCents, error: null });
  }
  return out;
}
