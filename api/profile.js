"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  classifyUrl, collectTags, safeName, extensionFromUrl, mimeFromFilename,
  applyDownloadFilenames, attachDownloadTokens
} = require("../lib/core");
const { createRateLimiter } = require("../lib/rate-limit");
const wavy = require("../lib/wavy");
const { requestTikwm, requestMusicalDown } = require("./extract");

const rateLimit = createRateLimiter({ max: 20 });
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;
const GLOBAL_DEADLINE_MS = 45000;
const PROBE_TIMEOUT_MS = 5000;
const WAVY_CONCURRENCY = 5;
const PROFILE_INFO_URL = "https://www.tikwm.com/api/user/info";
const PROFILE_INFO_TIMEOUT_MS = 9000;
const TIKTOK_PROFILE_FEED_URL = "https://www.tiktok.com/api/creator/item_list/";
const TIKTOK_FEED_TIMEOUT_MS = 7000;
const TIKTOK_FEED_PAGE_SIZE = 15;
const TIKTOK_OLDEST_MAX_PAGES = 60;
const THIRTY_DAYS_MS = 30 * 86_400_000;
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

async function fetchProfileInfo(classified) {
  const handle = String(classified.handle || "").replace(/^@/, "");
  if (classified.platform !== "tiktok" || !handle) return null;
  try {
    const body = new URLSearchParams({ unique_id: handle });
    const response = await fetch(PROFILE_INFO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
      signal: AbortSignal.timeout(PROFILE_INFO_TIMEOUT_MS)
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.code !== 0 || !payload?.data?.user) return null;
    const { user, stats } = payload.data;
    return {
      id: String(user.id || ""),
      secUid: String(user.secUid || ""),
      platform: classified.platform,
      username: user.uniqueId || handle,
      nickname: user.nickname || handle,
      avatar: user.avatarMedium || user.avatarLarger || user.avatarThumb || null,
      bio: user.signature || "",
      verified: Boolean(user.verified),
      followers: Number(stats?.followerCount) || 0,
      following: Number(stats?.followingCount) || 0,
      likes: Number(stats?.heartCount) || 0,
      mediaCount: Number(stats?.videoCount) || 0
    };
  } catch {
    return null;
  }
}

function accountCreatedAtFromId(id) {
  if (!/^\d{15,20}$/.test(String(id || ""))) return 0;
  try {
    const timestamp = Number(BigInt(id) >> 32n) * 1000;
    return timestamp >= Date.UTC(2016, 0, 1) && timestamp <= Date.now() ? timestamp : 0;
  } catch {
    return 0;
  }
}

function tiktokFeedQuery(secUid, cursor, deviceId) {
  return {
    aid: "1988", app_language: "en", app_name: "tiktok_web", browser_language: "en-US",
    browser_name: "Mozilla", browser_online: "true", browser_platform: "Win32",
    browser_version: "5.0 (Windows)", channel: "tiktok_web", cookie_enabled: "true",
    count: String(TIKTOK_FEED_PAGE_SIZE), cursor: String(cursor), device_id: deviceId,
    device_platform: "web_pc", focus_state: "true", from_page: "user", history_len: "2",
    is_fullscreen: "false", is_page_visible: "true", language: "en", os: "windows",
    region: "US", screen_height: "1080", screen_width: "1920", secUid, type: "1",
    tz_name: "UTC", verifyFp: `verify_${Math.random().toString(16).slice(2, 9)}`, webcast_language: "en"
  };
}

async function fetchTikTokProfilePage(profileInfo, cursor, deviceId) {
  const endpoint = new URL(TIKTOK_PROFILE_FEED_URL);
  for (const [key, value] of Object.entries(tiktokFeedQuery(profileInfo.secUid, cursor, deviceId))) endpoint.searchParams.set(key, value);
  const response = await fetch(endpoint, {
    headers: {
      Accept: "application/json",
      Referer: `https://www.tiktok.com/@${encodeURIComponent(profileInfo.username)}`,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/127 Safari/537.36"
    },
    signal: AbortSignal.timeout(TIKTOK_FEED_TIMEOUT_MS)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.statusCode !== 0 || !Array.isArray(payload.itemList)) {
    throw Object.assign(new Error("Halaman lama profil TikTok tidak dapat dibaca."), { code: "TIKTOK_OLDEST_PAGE_FAILED" });
  }
  return payload;
}

function normalizeTikTokOldest(entries, classified, profileInfo, { limit, offset }) {
  const ordered = [...entries]
    .filter(entry => entry?.id && Number(entry.createTime))
    .sort((a, b) => Number(a.createTime) - Number(b.createTime) || String(a.id).localeCompare(String(b.id)));
  const selected = ordered.slice(offset, offset + limit);
  const items = selected.map((entry, index) => {
    const sourceUrl = `https://www.tiktok.com/@${encodeURIComponent(classified.handle)}/video/${entry.id}`;
    const cover = entry.video?.cover?.urlList?.[0] || entry.video?.originCover?.urlList?.[0] || null;
    return {
      id: String(entry.id), type: "video", url: "", thumb: cover,
      filename: `${safeName(entry.desc || `${classified.handle}-${offset + index + 1}`)}.mp4`,
      mime: "video/mp4", quality: "Kualitas tertinggi", hasAudio: true,
      publishedAt: new Date(Number(entry.createTime) * 1000).toISOString(), _sourceUrl: sourceUrl
    };
  });
  const hasMore = profileInfo.mediaCount ? offset + items.length < profileInfo.mediaCount : ordered.length > offset + items.length;
  return {
    platform: "tiktok", provider: "tiktok-oldest", resourceKind: "profile", collection: true,
    partial: hasMore, title: `${profileInfo.nickname || profileInfo.username} (@${profileInfo.username})`,
    description: profileInfo.bio || "", author: profileInfo.username, tags: collectTags(profileInfo.bio || ""),
    pagination: { offset, limit, hasMore, order: "oldest" }, items
  };
}

async function requestTikTokOldest(classified, { limit, offset }, profileInfo) {
  const createdAt = accountCreatedAtFromId(profileInfo?.id);
  if (!createdAt || !profileInfo?.secUid) throw Object.assign(new Error("Identitas profil TikTok tidak lengkap."), { code: "TIKTOK_PROFILE_ID_MISSING" });

  const targetCount = offset + limit;
  const deviceId = String(7250000000000000000n + BigInt(Math.floor(Math.random() * 7_509_989_577)));
  let windowMs = THIRTY_DAYS_MS;
  let pagesRead = 0;
  let collected = [];

  while (pagesRead < TIKTOK_OLDEST_MAX_PAGES) {
    let cursor = Math.min(createdAt + windowMs, Date.now());
    const entries = [];
    const seen = new Set();
    let reachedOldest = false;
    while (pagesRead < TIKTOK_OLDEST_MAX_PAGES) {
      const page = await fetchTikTokProfilePage(profileInfo, cursor, deviceId);
      pagesRead += 1;
      const batch = page.itemList.filter(item => item?.id && Number(item.createTime));
      for (const item of batch) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        entries.push(item);
      }
      if (!batch.length || !page.hasMorePrevious) {
        reachedOldest = true;
        break;
      }
      const nextCursor = Number(batch.at(-1).createTime) * 1000;
      if (!nextCursor || nextCursor >= cursor) break;
      cursor = nextCursor;
    }
    collected = entries;
    if (reachedOldest && collected.length >= targetCount) break;
    if (createdAt + windowMs >= Date.now()) break;
    windowMs *= 2;
  }

  const result = normalizeTikTokOldest(collected, classified, profileInfo, { limit, offset });
  if (!result.items.length) throw Object.assign(new Error("Media paling lama tidak ditemukan pada profil ini."), { code: "TIKTOK_OLDEST_EMPTY" });
  return result;
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

function toMediaItem(replacement, item) {
  if (!replacement?.url) return null;
  const ext = extensionFromUrl(replacement.url, "mp4") || "mp4";
  return {
    id: item.id || replacement.id,
    type: replacement.type || "video",
    url: replacement.url,
    thumb: item.thumb || replacement.thumb || null,
    filename: item.filename || `${safeName(replacement.title || item.title || `media-${item.id || "video"}`)}.${ext}`,
    mime: replacement.mime || mimeFromFilename(`media.${ext}`),
    quality: replacement.quality || "Kualitas tertinggi",
    bestQuality: replacement.bestQuality || undefined,
    size: replacement.size || undefined,
    hasAudio: replacement.type === "video" ? replacement.hasAudio !== false : undefined,
    codec: replacement.codec || undefined,
    height: Number(replacement.height) || undefined,
    width: Number(replacement.width) || undefined,
    publishedAt: item.publishedAt || replacement.publishedAt || undefined
  };
}

async function resolveWavyItem(item) {
  const source = item._sourceUrl;
  if (!source) return null;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await wavy.requestWavy({ platform: "tiktok", kind: "post", url: source }, "auto");
      const replacement = result.items.find(candidate => candidate?.url);
      return toMediaItem(replacement, item);
    } catch (error) {
      lastError = error;
      if (attempt === 0) await sleep(1200);
    }
  }
  return null;
}

async function resolveTikwmItem(item) {
  const source = item._sourceUrl;
  if (!source) return null;
  try {
    const classified = { platform: "tiktok", kind: "post", url: source };
    const result = await requestTikwm(classified, "auto");
    return toMediaItem(result.items[0], item);
  } catch {
    return null;
  }
}

async function resolveMusicalDownItem(item) {
  const source = item._sourceUrl;
  if (!source) return null;
  try {
    const classified = { platform: "tiktok", kind: "post", url: source };
    const result = await requestMusicalDown(classified, "auto");
    return toMediaItem(result.items[0], item);
  } catch {
    return null;
  }
}

async function resolveItem(item) {
  const resolvers = [resolveWavyItem, resolveTikwmItem, resolveMusicalDownItem];
  for (const resolver of resolvers) {
    const replacement = await resolver(item);
    if (replacement?.url) return replacement;
  }
  return null;
}

function finalizeProfileResult(raw, { offset, limit }) {
  const items = raw.items.map(item => {
    const { _sourceUrl, _formats, ...clean } = item;
    const available = Boolean(clean.url && /^https:/i.test(clean.url));
    if (_sourceUrl) {
      clean.sourceUrl = _sourceUrl;
    }
    if (!available && _sourceUrl) {
      clean.fallbackUrl = _sourceUrl;
    }
    return { ...clean, available };
  });
  const availableCount = items.filter(item => item.available).length;
  return {
    platform: raw.platform,
    provider: "profile",
    resourceKind: raw.resourceKind || "profile",
    type: "collection",
    collection: true,
    partial: raw.partial,
    title: raw.title,
    description: raw.description || "",
    tags: raw.tags || [],
    author: raw.author,
    warnings: [...(raw.warnings || []), `${items.length} media ditemukan.`],
    pagination: raw.pagination || { offset, limit, hasMore: false },
    items
  };
}

function publishedAtFromEntry(entry, classified) {
  const timestamp = Number(entry?.timestamp || entry?.release_timestamp);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    const date = new Date(timestamp * 1000);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }

  const uploadDate = String(entry?.upload_date || "");
  if (/^\d{8}$/.test(uploadDate)) {
    const year = uploadDate.slice(0, 4);
    const month = uploadDate.slice(4, 6);
    const day = uploadDate.slice(6, 8);
    const date = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }

  if (classified.platform === "tiktok" && /^\d{15,20}$/.test(String(entry?.id || ""))) {
    try {
      const derived = Number(BigInt(entry.id) >> 32n) * 1000;
      const earliestTikTok = Date.UTC(2016, 0, 1);
      if (derived >= earliestTikTok && derived <= Date.now() + 86_400_000) return new Date(derived).toISOString();
    } catch {}
  }

  return undefined;
}

function normalizeYtdlp(data, classified, limit, offset, order = "newest") {
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
      width: Number(selected?.width) || undefined,
      publishedAt: publishedAtFromEntry(entry, classified)
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
    pagination: { offset, limit, hasMore, order },
    items
  };
}

function playlistItemsForOrder(order, offset, limit) {
  const start = offset + 1;
  const end = offset + limit;
  return `-${start}:-${end}:-1`;
}

function playlistPageOptions(order, offset, limit) {
  if (order === "oldest") return { playlistItems: playlistItemsForOrder(order, offset, limit) };
  return { playlistStart: offset + 1, playlistEnd: offset + limit };
}

async function requestYtdlp(classified, { limit, offset, order }) {
  const cookiePath = process.env.YTDLP_COOKIES_B64 ? "/tmp/tukangambil-cookies.txt" : null;
  if (cookiePath && !fs.existsSync(cookiePath)) fs.writeFileSync(cookiePath, Buffer.from(process.env.YTDLP_COOKIES_B64, "base64"), { mode: 0o600 });
  const isTiktok = classified.platform === "tiktok";
  const base = {
    dumpSingleJson: true, skipDownload: true, noWarnings: true, ignoreNoFormatsError: true,
    socketTimeout: 12, retries: 2, extractorRetries: 2, geoBypass: true,
    yesPlaylist: true, ...playlistPageOptions(order, offset, limit),
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
        return normalizeYtdlp(data, classified, limit, offset, order);
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
  const order = req.body?.order === "oldest" ? "oldest" : "newest";
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), MAX_LIMIT) : DEFAULT_LIMIT;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  const classified = classifyUrl(url);
  if (!classified || classified.kind !== "profile") return res.status(400).json({ error: "URL profil tidak dikenali atau tidak didukung.", code: "UNSUPPORTED_URL" });
  if (!["tiktok", "instagram", "facebook", "threads", "x"].includes(classified.platform)) return res.status(400).json({ error: "Profil platform ini belum didukung.", code: "UNSUPPORTED_PLATFORM" });
  try {
    let raw;
    let profileInfo;
    if (classified.platform === "tiktok" && order === "oldest") {
      profileInfo = await fetchProfileInfo(classified);
      raw = profileInfo
        ? await requestTikTokOldest(classified, { limit, offset }, profileInfo)
        : await requestYtdlp(classified, { limit, offset, order });
    } else {
      [raw, profileInfo] = await Promise.all([
        requestYtdlp(classified, { limit, offset, order }),
        fetchProfileInfo(classified)
      ]);
    }
    let resolved = raw;
    if (raw.platform === "tiktok" && raw.items?.length) {
      const replacements = await mapWithConcurrency(raw.items, WAVY_CONCURRENCY, resolveItem);
      resolved = {
        ...raw,
        items: raw.items.map((item, index) => {
          const replacement = replacements[index];
          if (!replacement || !replacement.url) return item;
          return { ...replacement, _sourceUrl: item._sourceUrl || replacement._sourceUrl };
        })
      };
    }
    const result = finalizeProfileResult(resolved, { offset, limit });
    if (profileInfo) {
      const { id, secUid, ...publicProfile } = profileInfo;
      result.profile = publicProfile;
      result.author = profileInfo.username || result.author;
      result.title = profileInfo.nickname ? `${profileInfo.nickname} (@${profileInfo.username})` : result.title;
    }
    applyDownloadFilenames(result);
    attachDownloadTokens(result);
    result.items = result.items.map(item => item.available ? item : { ...item, downloadToken: undefined, fallbackUrl: item.fallbackUrl || undefined });
    result.downloadSecurity = process.env.DOWNLOAD_TOKEN_SECRET ? "signed" : "same-origin";
    return res.status(200).json(result);
  } catch (error) {
    console.warn("profile_failed", { platform: classified.platform, handle: classified.handle, code: error.code || "FAILED" });
    const status = error.code === "GLOBAL_TIMEOUT" ? 504 : 502;
    return res.status(status).json({ error: error.message, code: error.code || "PROFILE_EXTRACT_FAILED" });
  }
};

module.exports.normalizeYtdlp = normalizeYtdlp;
module.exports.publishedAtFromEntry = publishedAtFromEntry;
module.exports.playlistItemsForOrder = playlistItemsForOrder;
module.exports.playlistPageOptions = playlistPageOptions;
module.exports.requestYtdlp = requestYtdlp;
module.exports.runtimeExtractor = runtimeExtractor;
module.exports.probeDownloadable = probeDownloadable;
module.exports.resolveWavyItem = resolveWavyItem;
module.exports.resolveTikwmItem = resolveTikwmItem;
module.exports.resolveMusicalDownItem = resolveMusicalDownItem;
module.exports.resolveItem = resolveItem;
module.exports.mapWithConcurrency = mapWithConcurrency;
module.exports.finalizeProfileResult = finalizeProfileResult;
module.exports.fetchProfileInfo = fetchProfileInfo;
module.exports.accountCreatedAtFromId = accountCreatedAtFromId;
module.exports.tiktokFeedQuery = tiktokFeedQuery;
module.exports.normalizeTikTokOldest = normalizeTikTokOldest;
module.exports.requestTikTokOldest = requestTikTokOldest;
