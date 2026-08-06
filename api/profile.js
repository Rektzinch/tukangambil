"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  classifyUrl, collectTags, safeName, extensionFromUrl, mimeFromFilename,
  validateResult, applyDownloadFilenames, attachDownloadTokens
} = require("../lib/core");
const { createRateLimiter } = require("../lib/rate-limit");
const wavy = require("../lib/wavy");

const rateLimit = createRateLimiter({ max: 20 });
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;
const GLOBAL_DEADLINE_MS = 45000;
const PROBE_TIMEOUT_MS = 5000;
const WAVY_CONCURRENCY = 5;
const MAX_YTDLP_ATTEMPTS = 3;
let extractor;

function runtimeExtractor() {
  if (extractor) return extractor;
  const youtubeDlPackage = require("youtube-dl-exec");
  const bundled = youtubeDlPackage.constants.YOUTUBE_DL_PATH;
  const runtime = path.join("/tmp", "tukangambil-yt-dlp");
  if (!fs.existsSync(runtime) || fs.statSync(runtime).size !== fs.statSync(bundled).size) fs.copyFileSync(bundled, runtime);
  fs.chmodSync(runtime, 0o755);
  extractor = youtubeDlPackage.create(runtime);
  return extractor;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function probeDownloadable(url) {
  try {
    const headers = { "User-Agent": "Mozilla/5.0 Chrome/127", "Accept-Encoding": "identity", Range: "bytes=0-0" };
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("tiktok")) headers.Referer = "https://www.tiktok.com/";
    else if (host.includes("instagram")) headers.Referer = "https://www.instagram.com/";
    else if (host.includes("fbcdn")) headers.Referer = "https://www.facebook.com/";
    const response = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return response.status === 200 || response.status === 206;
  } catch {
    return false;
  }
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function buildCandidateUrls(item) {
  const candidates = [];
  for (const format of Array.isArray(item._formats) ? item._formats : []) {
    if (format?.url) candidates.push({ url: format.url, height: Number(format.height) || 0 });
  }
  if (item._sourceUrl) candidates.push({ url: item._sourceUrl, source: true });
  return candidates;
}

async function resolveWavyItem(item) {
  try {
    const source = item._sourceUrl;
    if (!source) return null;
    const result = await wavy.requestWavy({ platform: "tiktok", kind: "post", url: source }, "auto");
    const replacement = result.items.find(candidate => candidate?.url);
    if (!replacement?.url) return null;
    return { ...replacement, id: item.id || replacement.id, thumb: item.thumb || replacement.thumb, filename: item.filename };
  } catch {
    return null;
  }
}

async function applyWavyFallback(raw) {
  if (raw.platform !== "tiktok" || !raw.items?.length) return raw;
  const resolved = await mapWithConcurrency(raw.items, WAVY_CONCURRENCY, resolveWavyItem);
  let wavyCount = 0;
  const items = raw.items.map((item, index) => {
    const replacement = resolved[index];
    let final;
    if (replacement?.url) {
      wavyCount += 1;
      final = replacement;
    } else {
      final = item;
    }
    const { _sourceUrl, _formats, ...clean } = final;
    if (!clean.url) clean.url = item.url;
    return clean;
  });
  return {
    ...raw,
    provider: wavyCount ? "yt-dlp+wavy" : raw.provider,
    items,
    warnings: [...(raw.warnings || []), wavyCount ? `Unduhan diambil via Wavy (${wavyCount}/${raw.items.length}).` : ""]
  };
}

function normalizeYtdlp(data, classified, limit, offset) {
  const entries = (Array.isArray(data?.entries) ? data.entries : [data]).filter(Boolean).slice(0, limit);
  const items = [];
  for (const [index, entry] of entries.entries()) {
    const formats = (Array.isArray(entry.formats) ? entry.formats : [])
      .filter(f => f?.url && f?.vcodec && f?.vcodec !== "none" && f?.acodec && f?.acodec !== "none");
    const selected = [...formats]
      .sort((a, b) => ((Number(b.height) || 0) * 1_000_000 + (Number(b.width) || 0)) - ((Number(a.height) || 0) * 1_000_000 + (Number(a.width) || 0)))[0] || null;
    const ext = selected?.ext || (selected?.url ? extensionFromUrl(selected.url, "mp4") : "mp4");
    const item = {
      id: entry.id || undefined,
      type: "video",
      url: selected?.url || "",
      thumb: entry.thumbnail || data.thumbnail || null,
      filename: `${safeName(entry.title || data.title || `${classified.handle}-${index + 1}`)}.${ext}`,
      mime: mimeFromFilename(`media.${ext}`),
      quality: selected?.width && selected?.height ? `${selected.width}×${selected.height}` : selected?.height ? `${selected.height}p` : "Kualitas tertinggi",
      hasAudio: selected ? selected.acodec !== "none" : true,
      codec: selected?.vcodec || undefined,
      height: Number(selected?.height) || undefined,
      width: Number(selected?.width) || undefined
    };
    if (classified.platform === "tiktok") {
      if (formats.length) item._formats = formats;
      const sourceUrl = entry.webpage_url || (entry.id ? `https://www.tiktok.com/@${encodeURIComponent(classified.handle)}/video/${entry.id}` : "");
      if (sourceUrl) item._sourceUrl = sourceUrl;
    }
    items.push(item);
  }
  const hasMore = classified.kind === "profile" && entries.length >= limit;
  return {
    platform: classified.platform,
    provider: "yt-dlp",
    resourceKind: classified.kind,
    collection: classified.kind === "profile",
    partial: hasMore,
    title: data.title || entries[0]?.title || `${classified.platform} media`,
    description: data.description || entries[0]?.description || "",
    tags: collectTags(data.tags || [], data.description || ""),
    author: data.uploader || data.channel || entries[0]?.uploader || classified.handle || "",
    pagination: { offset, limit, hasMore },
    items
  };
}

async function requestYtdlp(classified, { limit, offset }) {
  const cookiePath = process.env.YTDLP_COOKIES_B64 ? "/tmp/tukangambil-cookies.txt" : null;
  if (cookiePath && !fs.existsSync(cookiePath)) fs.writeFileSync(cookiePath, Buffer.from(process.env.YTDLP_COOKIES_B64, "base64"), { mode: 0o600 });
  const isTiktok = classified.platform === "tiktok";
  const base = {
    dumpSingleJson: true, skipDownload: true, noWarnings: true, ignoreNoFormatsError: true,
    socketTimeout: 12, retries: 2, extractorRetries: 2, geoBypass: true,
    yesPlaylist: true, playlistStart: offset + 1, playlistEnd: offset + limit,
    ...(cookiePath ? { cookies: cookiePath } : {})
  };
  // For TikTok, prefer flat playlist (one profile-page request, then resolve
  // each URL via Wavy). This avoids per-video webpage fetches that trigger
  // TikTok anti-bot on server IPs. Fall back to full extraction if needed.
  const modes = isTiktok
    ? [{ label: "flat", options: { ...base, flatPlaylist: true } }, { label: "full", options: base }]
    : [{ label: "full", options: base }];
  let lastError = null;
  for (const mode of modes) {
    for (let attempt = 0; attempt < MAX_YTDLP_ATTEMPTS; attempt += 1) {
      try {
        const data = await runtimeExtractor()(classified.url, mode.options, { timeout: GLOBAL_DEADLINE_MS - 3000 });
        return normalizeYtdlp(data, classified, limit, offset);
      } catch (error) {
        lastError = error;
        const message = String(error?.message || "");
        const retriable = /secondary user ID|Unexpected response|HTTP Error 4\d\d|unable to extract|timed out|Requested format/i.test(message);
        if (retriable && attempt + 1 < MAX_YTDLP_ATTEMPTS) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        if (retriable) break;
        throw error;
      }
    }
  }
  throw lastError || new Error("Gagal membaca daftar media profil.");
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") return res.status(405).json({ error: "Metode tidak didukung." });
  const limited = await rateLimit.check(req);
  if (!limited.ok) {
    res.setHeader("Retry-After", String(limited.retryAfter || 60));
    return res.status(429).json({ error: "Terlalu banyak permintaan. Coba lagi sebentar." });
  }
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  const rawLimit = Number(req.body?.limit);
  const rawOffset = Number(req.body?.offset);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), MAX_LIMIT) : DEFAULT_LIMIT;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  const classified = classifyUrl(url);
  if (!classified || classified.kind !== "profile") return res.status(400).json({ error: "URL profil tidak dikenali atau tidak didukung.", code: "UNSUPPORTED_URL" });
  if (!["tiktok", "instagram", "facebook", "threads", "x"].includes(classified.platform)) return res.status(400).json({ error: "Profil platform ini belum didukung.", code: "UNSUPPORTED_PLATFORM" });
  try {
    const raw = await requestYtdlp(classified, { limit, offset });
    const rawResult = await applyWavyFallback(raw);
    const result = validateResult(rawResult, { mode: "auto" });
    result.pagination = rawResult.pagination || { offset, limit, hasMore: false };
    applyDownloadFilenames(result);
    attachDownloadTokens(result);
    result.downloadSecurity = process.env.DOWNLOAD_TOKEN_SECRET ? "signed" : "same-origin";
    return res.status(200).json(result);
  } catch (error) {
    console.warn("profile_failed", { platform: classified.platform, handle: classified.handle, code: error.code || "FAILED" });
    const status = error.code === "GLOBAL_TIMEOUT" ? 504 : 502;
    return res.status(status).json({ error: error.message, code: error.code || "PROFILE_EXTRACT_FAILED" });
  }
};

module.exports.normalizeYtdlp = normalizeYtdlp;
module.exports.requestYtdlp = requestYtdlp;
module.exports.runtimeExtractor = runtimeExtractor;
module.exports.probeDownloadable = probeDownloadable;
module.exports.applyWavyFallback = applyWavyFallback;
module.exports.resolveWavyItem = resolveWavyItem;
module.exports.mapWithConcurrency = mapWithConcurrency;
