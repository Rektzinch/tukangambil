"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  classifyUrl, collectTags, safeName, extensionFromUrl, mediaTypeFromExtension,
  validateResult, applyDownloadFilenames, attachDownloadTokens,
  sanitizeProviderError
} = require("../lib/core");
const { createRateLimiter } = require("../lib/rate-limit");

const TIKWM_URL = "https://www.tikwm.com/api/";
const THREADSDL_URL = "https://www.threadsdl.app/api/threads";
const INSTAGRAM_PROFILE_URLS = [
  "https://i.instagram.com/api/v1/users/web_profile_info/",
  "https://www.instagram.com/api/v1/users/web_profile_info/"
];
const PROVIDER_TIMEOUT_MS = 15000;
const rateLimit = createRateLimiter({ max: 20 });
const GLOBAL_DEADLINE_MS = 52000;
const PROFILE_LIMIT = 24;
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

function providerEndpoints() {
  return [...new Set([process.env.COBALT_API_URLS, process.env.COBALT_API_URL]
    .filter(Boolean).join(",").split(",").map(v => v.trim().replace(/\/$/, "")).filter(Boolean))]
    .filter(value => { try { return new URL(value).protocol === "https:"; } catch { return false; } });
}

function pickBest(formats, mode) {
  const score = f => {
    const height = Number(f.height) || 0;
    const bitrate = Number(f.tbr || f.abr) || 0;
    const extBonus = f.ext === "mp4" ? 1_000 : f.ext === "m4a" ? 500 : 0;
    const codec = String(f.vcodec || "").toLowerCase();
    const codecBonus = /^(?:avc1|h264)/.test(codec) ? 1_000 : 0;
    return height * 1_000_000 + bitrate * 10_000 + extBonus + codecBonus;
  };
  let candidates = formats.filter(f => f?.url);
  if (mode === "audio") candidates = candidates.filter(f => f.vcodec === "none" && f.acodec && f.acodec !== "none");
  else if (mode === "mute") candidates = candidates.filter(f => f.vcodec && f.vcodec !== "none" && f.acodec === "none");
  else candidates = candidates.filter(f => f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none");
  return candidates.sort((a, b) => score(b) - score(a))[0] || null;
}

function normalizeYtdlp(data, classified, mode) {
  const entries = (Array.isArray(data?.entries) ? data.entries : [data]).filter(Boolean).slice(0, PROFILE_LIMIT);
  const items = [];
  for (const [index, entry] of entries.entries()) {
    const formats = Array.isArray(entry.formats) ? entry.formats : [];
    const selected = mode === "image" ? null : pickBest(formats, mode);
    if (selected?.url) {
      const type = mode === "audio" ? "audio" : "video";
      const ext = selected.ext || (type === "audio" ? "m4a" : "mp4");
      items.push({
        type, url: selected.url, thumb: entry.thumbnail || data.thumbnail || null,
        filename: `${safeName(entry.title || data.title || `${classified.platform}-${index + 1}`)}.${ext}`,
        mime: type === "audio" ? "audio/mp4" : ext === "webm" ? "video/webm" : "video/mp4",
        quality: type === "audio" ? `${Math.round(selected.abr || selected.tbr || 0) || "Original"} kbps` : selected.height ? `${selected.height}p` : "Kualitas tertinggi",
        hasAudio: type === "video" ? selected.acodec !== "none" : undefined,
        codec: selected.vcodec || selected.acodec
      });
      continue;
    }
    if (["auto", "image"].includes(mode) && entry.thumbnail) {
      const ext = extensionFromUrl(entry.thumbnail, "jpg");
      items.push({ type: "image", url: entry.thumbnail, thumb: entry.thumbnail, filename: `${safeName(entry.title || `image-${index + 1}`)}.${ext}`, quality: entry.width && entry.height ? `${entry.width}×${entry.height}` : "Original" });
    }
  }
  return {
    platform: classified.platform, provider: "yt-dlp", resourceKind: classified.kind,
    collection: classified.kind === "profile", partial: classified.kind === "profile" && entries.length >= PROFILE_LIMIT,
    title: data.title || entries[0]?.title || `${classified.platform} media`,
    description: data.description || entries[0]?.description || "", tags: collectTags(data.tags || [], data.description || ""),
    author: data.uploader || data.channel || entries[0]?.uploader || classified.handle || "", items
  };
}

async function requestYtdlp(classified, mode) {
  const cookiePath = process.env.YTDLP_COOKIES_B64 ? "/tmp/tukangambil-cookies.txt" : null;
  if (cookiePath && !fs.existsSync(cookiePath)) fs.writeFileSync(cookiePath, Buffer.from(process.env.YTDLP_COOKIES_B64, "base64"), { mode: 0o600 });
  const options = {
    dumpSingleJson: true, skipDownload: true, noWarnings: true, ignoreNoFormatsError: true,
    socketTimeout: 12, retries: 1, extractorRetries: 1, geoBypass: true,
    ...(classified.kind === "profile" ? { yesPlaylist: true, playlistEnd: PROFILE_LIMIT } : {}),
    ...(cookiePath ? { cookies: cookiePath } : {})
  };
  const data = await runtimeExtractor()(classified.url, options, { timeout: classified.kind === "profile" ? 42000 : 25000 });
  return normalizeYtdlp(data, classified, mode);
}

async function requestTikwm(classified, mode) {
  if (classified.platform !== "tiktok" || mode === "mute" || classified.kind === "profile") throw new Error("TikWM tidak cocok untuk URL ini.");
  const body = new URLSearchParams({ url: classified.url, hd: "1" });
  const response = await fetch(TIKWM_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.code !== 0 || !payload.data) throw new Error(payload?.msg || `TikWM gagal (${response.status}).`);
  const data = payload.data;
  if (mode === "audio") return { platform: "tiktok", provider: "tikwm", resourceKind: classified.kind, title: data.title || "TikTok audio", author: data.author?.nickname || "", items: [{ type: "audio", url: data.music, thumb: data.cover, filename: `${safeName(data.title || "tiktok")}.mp3`, quality: "Original audio" }] };
  if (Array.isArray(data.images) && data.images.length) return { platform: "tiktok", provider: "tikwm", resourceKind: classified.kind, title: data.title || "TikTok slideshow", author: data.author?.nickname || "", items: data.images.map((url, i) => ({ type: "image", url, thumb: url, filename: `${safeName(data.title || "tiktok")}-${i + 1}.jpg`, quality: "Original" })) };
  const url = data.hdplay || data.play;
  if (!url) throw new Error("Video TikTok tidak tersedia.");
  return { platform: "tiktok", provider: "tikwm", resourceKind: classified.kind, title: data.title || "TikTok video", author: data.author?.nickname || "", items: [{ type: "video", url, thumb: data.cover, filename: `${safeName(data.title || "tiktok")}.mp4`, quality: url === data.hdplay ? "HD" : "Standard", hasAudio: true, codec: "h264" }] };
}

async function requestThreads(classified, mode) {
  if (classified.platform !== "threads" || mode !== "auto" || classified.kind === "profile") throw new Error("Provider Threads tidak cocok untuk URL ini.");
  const response = await fetch(THREADSDL_URL, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ url: classified.url }), signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  const data = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(data?.medias)) throw new Error(data?.error || `Threads gagal (${response.status}).`);
  const items = [];
  for (const [index, media] of data.medias.entries()) {
    const video = Array.isArray(media.videos) ? media.videos.filter(v => v?.url).at(-1) : null;
    const image = Array.isArray(media.images) ? media.images.filter(v => v?.url).sort((a,b)=>(b.width||0)*(b.height||0)-(a.width||0)*(a.height||0))[0] : null;
    if (video) items.push({ type: "video", url: video.url, thumb: media.cover || null, filename: `threads-${index + 1}.mp4`, quality: media.height ? `${media.height}p` : "HD", hasAudio: true });
    else if (image) items.push({ type: "image", url: image.url, thumb: image.url, filename: `threads-${index + 1}.jpg`, quality: image.width && image.height ? `${image.width}×${image.height}` : "Original" });
  }
  return { platform: "threads", provider: "threadsdl", resourceKind: classified.kind, title: String(data.text || "Threads media").split("\n")[0], description: data.text || "", author: data.username || classified.handle || "", tags: collectTags(data.text || ""), items };
}

async function requestInstagramProfile(classified) {
  if (classified.platform !== "instagram" || classified.kind !== "profile") throw new Error("Bukan profil Instagram.");
  const username = classified.handle;
  const headers = { Accept: "application/json", "Accept-Language": "en-US,en;q=0.9", Referer: `https://www.instagram.com/${encodeURIComponent(username)}/`, "User-Agent": "Mozilla/5.0 Chrome/127", "X-IG-App-ID": "936619743392459", "X-Requested-With": "XMLHttpRequest" };
  for (const base of INSTAGRAM_PROFILE_URLS) {
    const endpoint = new URL(base); endpoint.searchParams.set("username", username);
    const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
    const payload = await response.json().catch(() => null);
    const user = payload?.data?.user;
    if (!response.ok || !user || user.is_private) continue;
    const items = [];
    for (const edge of user.edge_owner_to_timeline_media?.edges || []) {
      const node = edge?.node; if (!node) continue;
      const children = node.edge_sidecar_to_children?.edges?.map(e => e?.node).filter(Boolean) || [node];
      for (const media of children) {
        const type = media.is_video && media.video_url ? "video" : "image";
        const url = type === "video" ? media.video_url : media.display_url;
        if (!url) continue;
        items.push({ type, url, thumb: media.display_url || null, filename: `instagram-${username}-${items.length + 1}.${type === "video" ? "mp4" : extensionFromUrl(url,"jpg")}`, quality: media.dimensions ? `${media.dimensions.width}×${media.dimensions.height}` : "Original", hasAudio: type === "video" ? true : undefined });
        if (items.length >= PROFILE_LIMIT) break;
      }
      if (items.length >= PROFILE_LIMIT) break;
    }
    if (items.length) return { platform: "instagram", provider: "instagram-profile", resourceKind: "profile", collection: true, partial: Boolean(user.edge_owner_to_timeline_media?.page_info?.has_next_page), title: `Koleksi media @${username}`, description: user.biography || "", author: username, tags: collectTags(user.biography || ""), items };
  }
  throw new Error("Profil Instagram tidak dapat dibaca tanpa sesi.");
}

async function requestCobalt(classified, mode, endpoint) {
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (process.env.COBALT_API_KEY) headers.Authorization = `${process.env.COBALT_AUTH_SCHEME || "Api-Key"} ${process.env.COBALT_API_KEY}`;
  const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ url: classified.url, downloadMode: mode === "audio" ? "audio" : mode === "mute" ? "mute" : "auto", videoQuality: "max", filenameStyle: "pretty" }), signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.error?.code || `Cobalt gagal (${response.status}).`);
  if (["redirect", "tunnel"].includes(data.status)) {
    const ext = extensionFromUrl(data.url) || String(data.filename || "").split(".").pop().toLowerCase();
    const type = mode === "audio" ? "audio" : mediaTypeFromExtension(ext, "video");
    return { platform: classified.platform, provider: "cobalt", resourceKind: classified.kind, title: String(data.filename || `${classified.platform} media`).replace(/\.[a-z0-9]{2,5}$/i,""), items: [{ type, url: data.url, filename: data.filename || `media.${type === "audio" ? "m4a" : type === "image" ? "jpg" : "mp4"}`, quality: "MAX", hasAudio: type === "video" ? mode !== "mute" : undefined }] };
  }
  if (data.status === "picker") return { platform: classified.platform, provider: "cobalt", resourceKind: classified.kind, title: `${classified.platform} media`, items: (data.picker || []).map((item,i)=>({ type: item.type === "photo" ? "image" : "video", url: item.url, thumb: item.thumb || null, filename: `media-${i+1}.${item.type === "photo" ? "jpg" : "mp4"}`, quality: "MAX", hasAudio: item.type === "photo" ? undefined : true })) };
  throw new Error(data.error?.code || "Cobalt tidak memberikan media.");
}

async function raceProviders(attempts, mode) {
  const startedAt = Date.now();
  const failures = [];
  return new Promise((resolve, reject) => {
    let pending = attempts.length;
    if (!pending) return reject(Object.assign(new Error("Tidak ada provider yang tersedia."), { code: "NO_PROVIDER" }));
    const timer = setTimeout(() => reject(Object.assign(new Error("Batas waktu pemrosesan tercapai."), { code: "GLOBAL_TIMEOUT", details: failures })), GLOBAL_DEADLINE_MS);
    for (const attempt of attempts) {
      Promise.resolve().then(attempt.run).then(raw => validateResult(raw, { mode })).then(result => {
        clearTimeout(timer); resolve({ result, provider: attempt.name, durationMs: Date.now() - startedAt });
      }).catch(error => {
        failures.push({ provider: attempt.name, ...sanitizeProviderError(error) });
        pending -= 1;
        if (!pending) { clearTimeout(timer); reject(Object.assign(new Error("Semua mesin gagal memproses tautan tersebut."), { code: "ALL_PROVIDERS_FAILED", details: failures })); }
      });
    }
  });
}

function buildAttempts(classified, mode) {
  const attempts = [];
  if (classified.kind === "profile" && classified.platform === "instagram") attempts.push({ name: "instagram-profile", run: () => requestInstagramProfile(classified) });
  if (classified.platform === "tiktok") attempts.push({ name: "tikwm", run: () => requestTikwm(classified, mode) });
  if (classified.platform === "threads") attempts.push({ name: "threadsdl", run: () => requestThreads(classified, mode) });
  attempts.push({ name: "yt-dlp", run: () => requestYtdlp(classified, mode) });
  for (const endpoint of providerEndpoints()) attempts.push({ name: `cobalt:${new URL(endpoint).hostname}`, run: () => requestCobalt(classified, mode, endpoint) });
  return attempts;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") return res.status(405).json({ error: "Metode tidak didukung." });
  const limited = rateLimit.check(req);
  if (!limited.ok) {
    res.setHeader("Retry-After", "60");
    return res.status(429).json({ error: "Terlalu banyak permintaan. Coba lagi sebentar." });
  }
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  const mode = ["auto", "image", "audio", "mute"].includes(req.body?.mode) ? req.body.mode : "auto";
  const classified = classifyUrl(url);
  if (!classified || classified.kind === "unknown") return res.status(400).json({ error: "URL publik tidak dikenali atau tidak didukung.", code: "UNSUPPORTED_URL" });
  if (classified.kind === "profile" && mode !== "auto") return res.status(400).json({ error: "Profil hanya mendukung mode otomatis.", code: "PROFILE_MODE_UNSUPPORTED" });
  try {
    const { result, durationMs } = await raceProviders(buildAttempts(classified, mode), mode);
    result.durationMs = durationMs;
    applyDownloadFilenames(result);
    attachDownloadTokens(result);
    result.downloadSecurity = process.env.DOWNLOAD_TOKEN_SECRET ? "signed" : "same-origin";
    return res.status(200).json(result);
  } catch (error) {
    console.warn("extract_failed", { platform: classified.platform, kind: classified.kind, code: error.code || "FAILED", providers: Array.isArray(error.details) ? error.details.map(item => ({ provider: item.provider, code: item.code })) : [] });
    const status = error.code === "GLOBAL_TIMEOUT" ? 504 : 502;
    return res.status(status).json({ error: error.message, code: error.code || "EXTRACT_FAILED", details: process.env.NODE_ENV === "development" ? error.details : undefined });
  }
};

module.exports.normalizeYtdlp = normalizeYtdlp;
module.exports.pickBest = pickBest;
module.exports.raceProviders = raceProviders;
module.exports.buildAttempts = buildAttempts;
