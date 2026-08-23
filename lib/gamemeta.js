// ============================================================================
// DROPRATE — the JSON a wallet reads to show your game.
//
// WHY THIS EXISTS
//   A Core asset's `uri` is NOT an image. It points at a JSON document, and the
//   wallet fetches that and reads `.image` out of it. Copy #1 minted with the
//   cover URL in `uri` directly, so Phantom had nothing it could parse and drew
//   a blank card. This module writes the document wallets actually expect.
//
// WHERE IT LIVES
//   R2, served publicly through the Worker's /meta/ route. Metadata has to be
//   world-readable — wallets, explorers and marketplaces all fetch it with no
//   credentials — so it deliberately sits OUTSIDE the token gate that protects
//   the game files themselves. A cover image is marketing; the build is not.
//
// COVER IMAGES
//   Developers can paste a data: URL for a cover (the portal resizes client-side
//   and allows a few MB). A data: URL inside metadata is a bad neighbour: some
//   wallets refuse it, some explorers truncate it, and it bloats every fetch. So
//   a data: cover gets decoded once and stored as a real image file, and the
//   metadata links to that.
// ============================================================================

import { presignUrl } from "./r2.js";

const gateBase = () => (process.env.R2_GATE_BASE || "").trim().replace(/\/+$/, "");

/* Public URL for anything under the metadata prefix. Same host as the game gate,
   different route — the Worker serves /meta/ without requiring a play token. */
export function metaPublicUrl(key) {
  const base = gateBase();
  if (!base) return null;
  return `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

export const collectionMetaKey = (productId) => `meta/games/${productId}/collection.json`;
export const copyMetaKey = (productId, copyNumber) => `meta/games/${productId}/${copyNumber}.json`;
const coverKey = (productId, ext) => `meta/games/${productId}/cover.${ext}`;

/* PUT straight to R2 with a presigned URL. The body never passes through a
   browser here — it's a few hundred bytes of JSON written server-side. */
async function putObject(key, body, contentType) {
  const url = presignUrl({ method: "PUT", key, expires: 300 });
  const res = await fetch(url, {
    method: "PUT",
    headers: { "content-type": contentType },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`R2 write failed for ${key}: ${res.status} ${detail.slice(0, 200)}`);
  }
  return key;
}

const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]+)$/i;
const EXT_FOR = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };

/* Returns a URL a wallet can actually load, or null when there's no cover.
   An https URL is passed through untouched; a data: URL is materialised once. */
async function resolveCover(product) {
  const img = String(product.image || "").trim();
  if (!img) return null;
  if (/^https?:\/\//i.test(img)) return img;

  const m = DATA_URL.exec(img);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const ext = EXT_FOR[mime] || "png";
  const bytes = Buffer.from(m[2].replace(/\s+/g, ""), "base64");
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) return null;

  try {
    const key = coverKey(product.id, ext);
    await putObject(key, bytes, mime);
    return metaPublicUrl(key);
  } catch {
    return null;      // a missing cover is cosmetic; never fail a sale over it
  }
}

/* One cached cover resolution per product per warm lambda. Every copy of the
   same game shares an image, and re-uploading a 3MB data URL on every single
   mint would be absurd. */
const coverCache = new Map();
async function coverFor(product) {
  if (coverCache.has(product.id)) return coverCache.get(product.id);
  const url = await resolveCover(product);
  coverCache.set(product.id, url);
  return url;
}

const clean = (s, n) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);

/* The collection's own metadata — what a wallet shows for the game as a whole. */
export async function writeCollectionMeta(product) {
  const image = await coverFor(product);
  const body = {
    name: clean(product.title, 64),
    description: clean(product.description || product.tagline, 800),
    image: image || undefined,
    external_url: `https://droprate.xyz/store.html?game=${product.id}`,
    properties: {
      category: "image",
      files: image ? [{ uri: image, type: "image/png" }] : [],
    },
  };
  const key = collectionMetaKey(product.id);
  await putObject(key, JSON.stringify(body), "application/json");
  return metaPublicUrl(key);
}

/* One copy's metadata. Carries the serial number, because "copy 12 of 500" is
   the thing that makes an owned game feel like an object rather than a licence. */
export async function writeCopyMeta(product, copyNumber) {
  const image = await coverFor(product);
  const edition = product.supply_model === "finite" && product.supply_cap
    ? `${copyNumber} of ${product.supply_cap}` : `#${copyNumber}`;

  const body = {
    name: `${clean(product.title, 40)} #${copyNumber}`,
    description: clean(
      product.description || product.tagline ||
      `A copy of ${product.title}, bought on DropRate. Yours to keep, play, and resell.`, 800),
    image: image || undefined,
    external_url: `https://droprate.xyz/store.html?game=${product.id}`,
    attributes: [
      { trait_type: "Copy", value: String(copyNumber) },
      { trait_type: "Edition", value: edition },
      { trait_type: "Runtime", value: product.runtime === "web" ? "Browser" : "Download" },
      ...(Array.isArray(product.genres) && product.genres.length
        ? [{ trait_type: "Genre", value: product.genres.join(", ") }] : []),
      { trait_type: "Build", value: String(product.bundle_version || 0) },
    ],
    properties: {
      category: "image",
      files: image ? [{ uri: image, type: "image/png" }] : [],
    },
  };
  const key = copyMetaKey(product.id, copyNumber);
  await putObject(key, JSON.stringify(body), "application/json");
  return metaPublicUrl(key);
}
