// ============================================================================
// DROPRATE — Cloudflare R2 storage (S3-compatible) signing helpers.
//
// WHY THIS EXISTS: game files are far too big to pass through a Vercel function
// (bodies cap at a few MB, functions time out). So the bytes NEVER touch our
// server. We only sign short-lived permission slips and the browser uploads
// straight to R2. This module does the signing and nothing else.
//
// NO AWS SDK ON PURPOSE. @aws-sdk/client-s3 is tens of megabytes and would bloat
// every serverless bundle. SigV4 is ~80 lines of node:crypto, so we do it here.
//
// Two signing modes, because S3 needs both:
//   presignUrl()   -> query-string auth. A plain URL the browser can PUT/GET.
//   signedFetch()  -> header auth. For API calls we make server-side
//                     (multipart create/complete/abort), which carry a body.
//
// Env required (all set in Vercel):
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
//   R2_PUBLIC_BASE  e.g. https://games.droprate.xyz  (the SEPARATE origin games
//                   are served from — never droprate.xyz itself, see nativemarket)
// ============================================================================

import { createHash, createHmac } from "node:crypto";

const REGION = "auto";      // R2 always uses "auto"
const SERVICE = "s3";
const ALGO = "AWS4-HMAC-SHA256";

function env(name) {
  const v = process.env[name];
  if (!v) throw Object.assign(new Error(`${name} is not configured`), { status: 500 });
  return v;
}

export const r2Configured = () =>
  !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID &&
     process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET);

const endpoint = () =>
  process.env.R2_ENDPOINT || `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`;

/** Public URL a player's browser will fetch a stored object from. */
export function publicUrl(key) {
  const base = (process.env.R2_PUBLIC_BASE || "").replace(/\/+$/, "");
  if (!base) throw Object.assign(new Error("R2_PUBLIC_BASE is not configured"), { status: 500 });
  return `${base}/${encodeKey(key)}`;
}

const sha256hex = (b) => createHash("sha256").update(b).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

// RFC3986. encodeURIComponent leaves !'()* alone; S3 wants them encoded.
const uriEncode = (str) =>
  encodeURIComponent(str).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/** Encode an object key for a URL path: encode each segment, keep the slashes. */
const encodeKey = (key) => String(key).split("/").map(uriEncode).join("/");

function stamps() {
  const iso = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""); // 20260820T142530Z
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function signingKey(secret, dateStamp) {
  return hmac(hmac(hmac(hmac("AWS4" + secret, dateStamp), REGION), SERVICE), "aws4_request");
}

const canonicalQuery = (params) =>
  Object.keys(params).sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(String(params[k]))}`)
    .join("&");

/**
 * A signed URL the CLIENT can hit directly. Nothing else needed — no headers,
 * no credentials in the browser.
 *
 * @param method   "PUT" | "GET"
 * @param key      object key, e.g. games/12/v3/index.html
 * @param expires  seconds until the URL dies (S3 max is 7 days)
 * @param query    extra query params (multipart uses partNumber + uploadId)
 */
export function presignUrl({ method = "PUT", key, expires = 900, query = {} }) {
  const accessKey = env("R2_ACCESS_KEY_ID");
  const secret = env("R2_SECRET_ACCESS_KEY");
  const bucket = env("R2_BUCKET");
  const { amzDate, dateStamp } = stamps();
  const host = new URL(endpoint()).host;
  const canonicalUri = `/${uriEncode(bucket)}/${encodeKey(key)}`;

  const params = {
    ...query,
    "X-Amz-Algorithm": ALGO,
    "X-Amz-Credential": `${accessKey}/${dateStamp}/${REGION}/${SERVICE}/aws4_request`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(Math.max(1, Math.min(604800, Math.round(expires)))),
    "X-Amz-SignedHeaders": "host",
  };

  const canonicalRequest = [
    method, canonicalUri, canonicalQuery(params),
    `host:${host}\n`, "host", "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    ALGO, amzDate, `${dateStamp}/${REGION}/${SERVICE}/aws4_request`, sha256hex(canonicalRequest),
  ].join("\n");

  const signature = hmac(signingKey(secret, dateStamp), stringToSign).toString("hex");
  return `${endpoint()}${canonicalUri}?${canonicalQuery(params)}&X-Amz-Signature=${signature}`;
}

/**
 * Server-side signed request (Authorization header). Used for the multipart
 * control calls, which carry bodies and can't use query-string auth.
 */
async function signedFetch({ method, key, query = {}, body = "" }) {
  const accessKey = env("R2_ACCESS_KEY_ID");
  const secret = env("R2_SECRET_ACCESS_KEY");
  const bucket = env("R2_BUCKET");
  const { amzDate, dateStamp } = stamps();
  const host = new URL(endpoint()).host;
  const canonicalUri = `/${uriEncode(bucket)}/${encodeKey(key)}`;
  const payloadHash = sha256hex(body || "");

  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

  const canonicalRequest = [
    method, canonicalUri, canonicalQuery(query), canonicalHeaders, signedHeaders, payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [ALGO, amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const signature = hmac(signingKey(secret, dateStamp), stringToSign).toString("hex");

  const qs = canonicalQuery(query);
  const res = await fetch(`${endpoint()}${canonicalUri}${qs ? "?" + qs : ""}`, {
    method,
    headers: {
      host,
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      Authorization: `${ALGO} Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      ...(body ? { "Content-Type": "application/xml" } : {}),
    },
    body: body || undefined,
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`R2 ${method} failed (${res.status}): ${text.slice(0, 300)}`), { status: 502 });
  return text;
}

const xmlTag = (xml, tag) => {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : null;
};

/** Begin a multipart upload. Returns the uploadId parts are signed against. */
export async function multipartCreate(key, contentType) {
  const xml = await signedFetch({ method: "POST", key, query: { uploads: "" } });
  const id = xmlTag(xml, "UploadId");
  if (!id) throw Object.assign(new Error("R2 did not return an UploadId"), { status: 502 });
  return id;
}

/** A URL the browser PUTs one chunk to. partNumber is 1-based. */
export const multipartPartUrl = (key, uploadId, partNumber, expires = 3600) =>
  presignUrl({ method: "PUT", key, expires, query: { partNumber: String(partNumber), uploadId } });

/** Stitch the uploaded chunks into one object. parts = [{PartNumber, ETag}] */
export async function multipartComplete(key, uploadId, parts) {
  const body =
    "<CompleteMultipartUpload>" +
    [...parts].sort((a, b) => a.PartNumber - b.PartNumber)
      .map((p) => `<Part><PartNumber>${p.PartNumber}</PartNumber><ETag>${String(p.ETag).replace(/"/g, "&quot;")}</ETag></Part>`)
      .join("") +
    "</CompleteMultipartUpload>";
  await signedFetch({ method: "POST", key, query: { uploadId }, body });
  return key;
}

/** Throw away an abandoned multipart upload so R2 stops billing for the parts. */
export const multipartAbort = (key, uploadId) =>
  signedFetch({ method: "DELETE", key, query: { uploadId } }).then(() => true).catch(() => false);

export const deleteObject = (key) =>
  signedFetch({ method: "DELETE", key }).then(() => true).catch(() => false);
