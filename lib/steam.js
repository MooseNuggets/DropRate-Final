// ============================================================================
// DROPRATE — Steam price + metadata lookup (ADDITIVE, gacha only)
//
// Resolves a game name / store URL / appid to its MSRP, current price, and cover
// art via Steam's public storefront API (no key required). Used by the key-loader
// to auto-suggest a rarity tier and to show "$X value" on pulls.
//
// The network call is injectable (fetchJson) so the whole thing is unit-testable
// offline. Every function fails soft — a missing price returns null, never throws,
// so the loader can always fall back to manual entry.
// ============================================================================

const DEFAULT_FETCH = async (url) => {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`steam http ${res.status}`);
  return res.json();
};

// "1145360" | "https://store.steampowered.com/app/1145360/Hades/" | "Hades"
export function parseAppInput(input) {
  const s = String(input || "").trim();
  if (!s) return {};
  if (/^\d+$/.test(s)) return { appid: Number(s) };
  const m = s.match(/store\.steampowered\.com\/app\/(\d+)/i);
  if (m) return { appid: Number(m[1]) };
  return { name: s };
}

// Name -> best-guess appid via Steam's app search endpoint.
export async function searchAppId(name, fetchJson = DEFAULT_FETCH) {
  const url = `https://steamcommunity.com/actions/SearchApps/${encodeURIComponent(name)}`;
  let list;
  try {
    list = await fetchJson(url);
  } catch {
    return null;
  }
  if (!Array.isArray(list) || list.length === 0) return null;
  const lower = name.toLowerCase();
  const exact = list.find((a) => String(a.name || "").toLowerCase() === lower);
  const chosen = exact || list[0];
  return chosen && chosen.appid != null ? Number(chosen.appid) : null;
}

// appid -> normalized details. Prices are in cents already (Steam gives cents).
export async function fetchAppDetails(appid, fetchJson = DEFAULT_FETCH, cc = "us") {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=${cc}`;
  let j;
  try {
    j = await fetchJson(url);
  } catch {
    return null;
  }
  const entry = j && j[String(appid)];
  if (!entry || !entry.success || !entry.data) return null;
  const d = entry.data;
  const po = d.price_overview;
  return {
    appid: Number(appid),
    name: d.name || null,
    isFree: !!d.is_free,
    msrpCents: po ? po.initial : d.is_free ? 0 : null,      // list price
    currentCents: po ? po.final : d.is_free ? 0 : null,     // after discount
    discountPct: po ? po.discount_percent : 0,
    image: d.header_image || null,
  };
}

// One-shot: any input -> details (or null if it can't be resolved).
export async function lookupGame(input, fetchJson = DEFAULT_FETCH, cc = "us") {
  const parsed = parseAppInput(input);
  let appid = parsed.appid;
  if (!appid && parsed.name) appid = await searchAppId(parsed.name, fetchJson);
  if (!appid) return null;
  return fetchAppDetails(appid, fetchJson, cc);
}
