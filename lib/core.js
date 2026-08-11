"use strict";

const crypto = require("node:crypto");
const { allowedMediaUrl } = require("./media-policy");

const ALLOWED_HOSTS = Object.freeze({
  tiktok: ["tiktok.com", "vm.tiktok.com", "vt.tiktok.com"],
  instagram: ["instagram.com"],
  facebook: ["facebook.com", "fb.watch", "m.facebook.com"],
  threads: ["threads.net", "threads.com"],
  x: ["x.com", "twitter.com", "mobile.twitter.com"]
});

const EXTENSIONS = Object.freeze({
  image: new Set(["jpg", "jpeg", "png", "webp", "avif", "heic", "gif"]),
  video: new Set(["mp4", "m4v", "mov", "webm", "mkv"]),
  audio: new Set(["mp3", "m4a", "aac", "wav", "ogg", "opus", "flac"])
});

const MIME_BY_EXTENSION = Object.freeze({
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  avif: "image/avif", heic: "image/heic", gif: "image/gif",
  mp4: "video/mp4", m4v: "video/x-m4v", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav",
  ogg: "audio/ogg", opus: "audio/opus", flac: "audio/flac"
});

const EXTENSION_TO_MEDIA_TYPE = new Map();
for (const [type, exts] of Object.entries(EXTENSIONS)) {
  for (const ext of exts) {
    EXTENSION_TO_MEDIA_TYPE.set(ext, type);
  }
}

function hostnameMatches(host, domains) {
  return domains.some(domain => host === domain || host.endsWith(`.${domain}`));
}

function platformOf(input) {
  let parsed;
  try { parsed = new URL(input); } catch { return null; }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  return Object.entries(ALLOWED_HOSTS).find(([, domains]) => hostnameMatches(host, domains))?.[0] || null;
}

function normalizedPathParts(parsed) {
  return parsed.pathname.split("/").filter(Boolean).map(part => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
}

function classifyUrl(input) {
  const platform = platformOf(input);
  if (!platform) return null;
  const parsed = new URL(input);
  parsed.hash = "";
  const parts = normalizedPathParts(parsed);
  const first = String(parts[0] || "").toLowerCase();
  let kind = "unknown";
  let handle = "";

  if (platform === "tiktok") {
    handle = parts.find(part => part.startsWith("@"))?.slice(1) || "";
    if (parts.some(part => /^(?:story|stories)$/i.test(part))) kind = "story";
    else if (parts.length === 1 && first.startsWith("@")) kind = "profile";
    else if (parts.some(part => /^(?:video|photo)$/i.test(part)) || first === "t" || ["vm.tiktok.com", "vt.tiktok.com"].includes(parsed.hostname.toLowerCase())) kind = "post";
  } else if (platform === "instagram") {
    if (first === "stories") { kind = "story"; handle = parts[1] || ""; }
    else if (["p", "reel", "reels", "tv"].includes(first)) kind = first === "p" ? "post" : "reel";
    else if (parts.length === 1 && !["explore", "accounts", "direct"].includes(first)) { kind = "profile"; handle = parts[0] || ""; }
  } else if (platform === "facebook") {
    if (first === "stories" || /\/story\.php$/i.test(parsed.pathname)) kind = "story";
    else if (/\/profile\.php$/i.test(parsed.pathname) && parsed.searchParams.has("id")) { kind = "profile"; handle = parsed.searchParams.get("id") || ""; }
    else if (["reel", "watch"].includes(first) || parsed.hostname.toLowerCase().includes("fb.watch")) kind = "reel";
    else if (/photo(?:s)?(?:\.php)?/i.test(first) || /\/photo\.php$/i.test(parsed.pathname)) kind = "photo";
    else if (["posts", "videos", "permalink.php", "share"].includes(first) || parts.includes("posts") || parts.includes("videos")) kind = "post";
    else if (parts.length === 1 && !["groups", "events", "marketplace", "login.php"].includes(first)) { kind = "profile"; handle = parts[0] || ""; }
  } else if (platform === "threads") {
    handle = parts.find(part => part.startsWith("@"))?.slice(1) || "";
    if (parts.length === 1 && first.startsWith("@")) kind = "profile";
    else if (parts.includes("post") || first === "t" || first === "share") kind = "post";
  } else if (platform === "x") {
    handle = parts[0] || "";
    if (parts.includes("status")) kind = "post";
    else if (parts.length === 1 && !["home", "explore", "search", "messages", "notifications", "i", "intent"].includes(first)) kind = "profile";
  }

  if (kind === "profile") {
    if (platform === "facebook" && /\/profile\.php$/i.test(parsed.pathname)) {
      const id = parsed.searchParams.get("id");
      parsed.search = id ? `?id=${encodeURIComponent(id)}` : "";
    } else {
      parsed.search = "";
      if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
    }
  }

  return { platform, kind, handle: String(handle || "").replace(/^@/, ""), url: parsed.toString() };
}

function canonicalProfileUrl(platform, value) {
  const classified = classifyUrl(value);
  if (!classified || classified.platform !== platform || classified.kind !== "profile") return value;
  return classified.url;
}

function safeName(value, fallback = "media", maxLength = 72) {
  const clean = String(value || fallback)
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const withoutDangerousSuffix = clean.replace(/\.(?:desktop|url|webloc)$/i, "");
  return (withoutDangerousSuffix || fallback).slice(0, maxLength);
}

function safeFilename(value, fallback = "media") {
  return safeName(value, fallback, 96);
}

function extensionFromFilename(value, fallback = "") {
  const match = String(value || "").match(/\.([a-z0-9]{2,5})$/i);
  return match?.[1]?.toLowerCase() || fallback;
}

function extensionFromUrl(value, fallback = "") {
  try {
    const parsed = new URL(value);
    const format = parsed.searchParams.get("format");
    const ext = format || parsed.pathname.match(/\.([a-z0-9]{2,5})(?::[a-z]+)?$/i)?.[1];
    return /^[a-z0-9]{2,5}$/i.test(ext || "") ? String(ext).toLowerCase() : fallback;
  } catch { return fallback; }
}

function mediaTypeFromExtension(ext, fallback = null) {
  const normalized = String(ext || "").toLowerCase();
  return EXTENSION_TO_MEDIA_TYPE.get(normalized) ?? fallback;
}

function mimeFromFilename(filename, upstreamType = "") {
  const cleanType = String(upstreamType || "").split(";", 1)[0].trim().toLowerCase();
  if (/^(?:image|video|audio)\//.test(cleanType)) return cleanType;
  return MIME_BY_EXTENSION[extensionFromFilename(filename)] || cleanType || "application/octet-stream";
}

function collectTags(...values) {
  const tags = new Set();
  for (const value of values.flat(Infinity)) {
    if (typeof value !== "string") continue;
    for (const match of value.matchAll(/#([\p{L}\p{N}_-]+)/gu)) tags.add(match[1]);
  }
  return [...tags].filter(Boolean).slice(0, 16);
}

function sanitizeProviderError(error) {
  const code = String(error?.code || error?.name || "PROVIDER_ERROR").replace(/[^A-Z0-9_-]/gi, "_").slice(0, 48);
  const message = String(error?.message || error || "Provider gagal")
    .replace(/https?:\/\/[^\s)]+/gi, "[url]")
    .replace(/[?&](?:token|key|sig|signature|cookie|session|sessionid)=[^\s&]+/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
  return { code, message };
}

function validateHttpsUrl(value) {
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

function normalizeItem(item, index) {
  if (!item || !["image", "video", "audio"].includes(item.type) || !allowedMediaUrl(item.url)) return null;
  const fallbackExt = item.type === "image" ? "jpg" : item.type === "audio" ? "m4a" : "mp4";
  let ext = extensionFromFilename(item.filename) || extensionFromUrl(item.url) || fallbackExt;
  if (!EXTENSIONS[item.type].has(ext)) ext = fallbackExt;
  const filename = `${safeName(String(item.filename || `media-${index + 1}`).replace(/\.[a-z0-9]{2,5}$/i, ""), `media-${index + 1}`)}.${ext}`;
  const height = Number(item.height);
  const width = Number(item.width);
  return {
    id: item.id ? String(item.id).slice(0, 64) : undefined,
    type: item.type,
    url: item.url,
    thumb: allowedMediaUrl(item.thumb) ? item.thumb : null,
    filename,
    mime: item.mime || MIME_BY_EXTENSION[ext] || "application/octet-stream",
    quality: String(item.quality || "Kualitas tertinggi tersedia").slice(0, 80),
    hasAudio: item.type === "video" ? item.hasAudio !== false : undefined,
    codec: item.codec ? String(item.codec).slice(0, 40) : undefined,
    width: Number.isFinite(width) && width > 0 ? width : undefined,
    height: Number.isFinite(height) && height > 0 ? height : undefined
  };
}

function validateResult(result, { mode = "auto" } = {}) {
  if (!result || typeof result !== "object") throw Object.assign(new Error("Provider tidak memberikan hasil yang valid."), { code: "INVALID_PROVIDER_RESULT" });
  const dedupe = new Map();
  let skipped = 0;
  for (const [index, raw] of (Array.isArray(result.items) ? result.items : []).entries()) {
    const item = normalizeItem(raw, index);
    if (!item) {
      skipped += 1;
      continue;
    }
    if (mode === "image" && item.type !== "image") continue;
    if (mode === "audio" && item.type !== "audio") continue;
    if (mode === "mute" && (item.type !== "video" || item.hasAudio !== false)) continue;
    if (mode === "auto" && item.type === "video" && item.hasAudio === false) continue;
    const key = `${item.type}:${item.url}`;
    if (!dedupe.has(key)) dedupe.set(key, item);
  }
  const items = [...dedupe.values()];
  if (!items.length) throw Object.assign(new Error(mode === "audio" ? "Audio tidak tersedia pada tautan ini." : mode === "image" ? "Gambar tidak tersedia pada tautan ini." : "Tidak ada media kompatibel pada tautan ini."), { code: "NO_COMPATIBLE_MEDIA" });
  return {
    platform: result.platform,
    provider: result.provider || "unknown",
    resourceKind: result.resourceKind || "post",
    type: items.length > 1 ? "carousel" : items[0].type,
    collection: Boolean(result.collection),
    partial: Boolean(result.partial),
    title: String(result.title || "Media publik").slice(0, 220),
    description: String(result.description || "").slice(0, 4000),
    tags: Array.isArray(result.tags) ? result.tags.map(String).slice(0, 16) : [],
    author: String(result.author || "").slice(0, 120),
    warnings: (() => {
      const warnings = Array.isArray(result.warnings) ? result.warnings.map(String).slice(0, 6) : [];
      if (skipped > 0) warnings.push(`${skipped} media dilewati (URL tidak aman atau tidak kompatibel).`);
      return warnings;
    })(),
    items
  };
}

function applyDownloadFilenames(result) {
  const multiple = result.items.length > 1;
  result.items = result.items.map((item, index) => {
    const ext = extensionFromFilename(item.filename, item.type === "image" ? "jpg" : item.type === "audio" ? "m4a" : "mp4");
    return { ...item, filename: `tkangambl${multiple ? `-${index + 1}` : ""}.${ext}` };
  });
  return result;
}

function downloadSecret() {
  return String(process.env.DOWNLOAD_TOKEN_SECRET || "").trim();
}

function signDownloadToken(item, ttlSeconds = 900) {
  const secret = downloadSecret();
  if (!secret) return "";
  const payload = Buffer.from(JSON.stringify({ u: item.url, f: item.filename, e: Math.floor(Date.now() / 1000) + ttlSeconds }), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyDownloadToken(token) {
  const secret = downloadSecret();
  if (!secret || typeof token !== "string") return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest();
  let received;
  try { received = Buffer.from(signature, "base64url"); } catch { return null; }
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const expires = Number(data.e);
    if (!data?.u || !data?.f || !Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return null;
    return { url: String(data.u), filename: safeFilename(data.f) };
  } catch { return null; }
}

function attachDownloadTokens(result) {
  result.items = result.items.map(item => ({ ...item, downloadToken: signDownloadToken(item) || undefined }));
  return result;
}

function publicOrigin(req) {
  const configured = String(process.env.PUBLIC_ORIGIN || "").trim();
  if (configured) {
    try { return new URL(configured).origin; } catch {}
  }
  const production = String(process.env.VERCEL_PROJECT_PRODUCTION_URL || "").trim();
  if (production) return `https://${production}`;
  const host = String(req?.headers?.host || "").trim().toLowerCase();
  if (/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(host)) return `http://${host}`;
  if (/^[a-z0-9.-]+\.vercel\.app$/.test(host)) return `https://${host}`;
  return "";
}

module.exports = {
  ALLOWED_HOSTS, EXTENSIONS, MIME_BY_EXTENSION,
  hostnameMatches, platformOf, classifyUrl, canonicalProfileUrl,
  safeName, safeFilename, extensionFromFilename, extensionFromUrl, mediaTypeFromExtension,
  mimeFromFilename, collectTags, sanitizeProviderError, validateResult, applyDownloadFilenames,
  signDownloadToken, verifyDownloadToken, attachDownloadTokens, publicOrigin, allowedMediaUrl
};
