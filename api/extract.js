"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  classifyUrl, collectTags, safeName, extensionFromUrl, mediaTypeFromExtension, mimeFromFilename,
  validateResult, applyDownloadFilenames, attachDownloadTokens,
  sanitizeProviderError
} = require("../lib/core");
const { createRateLimiter } = require("../lib/rate-limit");
const fastdl = require("../lib/instagram-fastdl");
const igDirect = require("../lib/instagram-direct");
const wavy = require("../lib/wavy");

const TIKWM_URL = "https://www.tikwm.com/api/";
const MUSICALDOWN_URL = "https://musicaldown.com/id";
const THREADSDL_URL = "https://www.threadsdl.app/api/threads";
const INSTAGRAM_PROFILE_URLS = [
  "https://i.instagram.com/api/v1/users/web_profile_info/",
  "https://www.instagram.com/api/v1/users/web_profile_info/"
];
const PROVIDER_TIMEOUT_MS = 15000;
const rateLimit = createRateLimiter({ max: 20 });
const GLOBAL_DEADLINE_MS = 46000;
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
    const width = Number(f.width) || 0;
    const bitrate = Number(f.tbr || f.abr) || 0;
    const extBonus = f.ext === "mp4" ? 1_000 : f.ext === "m4a" ? 500 : 0;
    const codec = String(f.vcodec || "").toLowerCase();
    const codecBonus = /^(?:avc1|h264)/.test(codec) ? 1_000 : 0;
    return height * 1_000_000_000 + width * 1_000_000 + bitrate * 10_000 + extBonus + codecBonus;
  };
  let candidates = formats.filter(f => f?.url);
  if (mode === "audio") candidates = candidates.filter(f => f.vcodec === "none" && f.acodec && f.acodec !== "none");
  else if (mode === "mute") candidates = candidates.filter(f => f.vcodec && f.vcodec !== "none" && f.acodec === "none");
  else candidates = candidates.filter(f => f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none");
  return candidates.sort((a, b) => score(b) - score(a))[0] || null;
}

function imageCandidate(entry) {
  const originals = [];
  for (const format of Array.isArray(entry?.formats) ? entry.formats : []) {
    const ext = String(format.ext || extensionFromUrl(format.url, "")).toLowerCase();
    if (format.url && mediaTypeFromExtension(ext) === "image") originals.push({ ...format, ext });
  }
  const entryExt = String(entry?.ext || extensionFromUrl(entry?.url, "")).toLowerCase();
  if (entry?.url && mediaTypeFromExtension(entryExt) === "image") originals.push({ ...entry, ext: entryExt });
  if (originals.length) {
    return originals.sort((a, b) => ((Number(b.width) || 0) * (Number(b.height) || 0)) - ((Number(a.width) || 0) * (Number(a.height) || 0)))[0];
  }
  const candidates = [];
  const thumbnails = Array.isArray(entry?.thumbnails) ? entry.thumbnails.filter(item => item?.url) : [];
  candidates.push(...thumbnails.map(item => ({ ...item, ext: extensionFromUrl(item.url, "jpg") })));
  if (entry?.thumbnail) candidates.push({ url: entry.thumbnail, ext: extensionFromUrl(entry.thumbnail, "jpg"), width: entry.width, height: entry.height });
  return candidates
    .filter(item => /^https?:/i.test(String(item.url || "")))
    .sort((a, b) => ((Number(b.width) || 0) * (Number(b.height) || 0)) - ((Number(a.width) || 0) * (Number(a.height) || 0)))[0] || null;
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
        mime: mimeFromFilename(`media.${ext}`),
        quality: type === "audio" ? `${Math.round(selected.abr || selected.tbr || 0) || "Original"} kbps` : selected.width && selected.height ? `${selected.width}×${selected.height}` : selected.height ? `${selected.height}p` : "Kualitas tertinggi",
        hasAudio: type === "video" ? selected.acodec !== "none" : undefined,
        codec: selected.vcodec || selected.acodec,
        height: selected.height || undefined
      });
      continue;
    }
    if (["auto", "image"].includes(mode)) {
      const image = imageCandidate(entry);
      if (!image) continue;
      const ext = image.ext || extensionFromUrl(image.url, "jpg");
      items.push({ type: "image", url: image.url, thumb: image.url, filename: `${safeName(entry.title || `image-${index + 1}`)}.${ext}`, quality: image.width && image.height ? `${image.width}×${image.height}` : "Original", width: image.width || undefined, height: image.height || undefined });
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
  const width = Number(data.width) || undefined;
  const height = Number(data.height) || undefined;
  if (mode === "audio") return { platform: "tiktok", provider: "tikwm", resourceKind: classified.kind, title: data.title || "TikTok audio", author: data.author?.nickname || "", items: [{ type: "audio", url: data.music, thumb: data.cover, filename: `${safeName(data.title || "tiktok")}.mp3`, quality: "Original audio" }] };
  if (Array.isArray(data.images) && data.images.length) return { platform: "tiktok", provider: "tikwm", resourceKind: classified.kind, title: data.title || "TikTok slideshow", author: data.author?.nickname || "", items: data.images.map((url, i) => ({ type: "image", url, thumb: url, filename: `${safeName(data.title || "tiktok")}-${i + 1}.jpg`, quality: width && height ? `${width}×${height}` : "Original", width, height })) };
  const url = data.hdplay || data.play;
  if (!url) throw new Error("Video TikTok tidak tersedia.");
  return { platform: "tiktok", provider: "tikwm", resourceKind: classified.kind, title: data.title || "TikTok video", author: data.author?.nickname || "", items: [{ type: "video", url, thumb: data.cover, filename: `${safeName(data.title || "tiktok")}.mp4`, quality: width && height ? `${width}×${height}` : url === data.hdplay ? "HD" : "Standard", width, height, hasAudio: true, codec: "h264" }] };
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function textFromHtml(value) {
  return decodeHtml(String(value || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function parseMusicalDownForm(html) {
  const form = String(html || "").match(/<form\b[^>]*id=["']submit-form["'][^>]*>[\s\S]*?<\/form>/i)?.[0];
  if (!form) throw new Error("Form MusicalDown tidak ditemukan.");
  const action = decodeHtml(form.match(/\baction=["']([^"']+)["']/i)?.[1] || "/id/download");
  const fields = [];
  for (const match of form.matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = match[1];
    const name = decodeHtml(attrs.match(/\bname=["']([^"']+)["']/i)?.[1]);
    if (!name) continue;
    fields.push({
      name,
      type: String(attrs.match(/\btype=["']([^"']+)["']/i)?.[1] || "text").toLowerCase(),
      value: decodeHtml(attrs.match(/\bvalue=["']([^"']*)["']/i)?.[1] || "")
    });
  }
  if (!fields.some(field => field.type === "text" || field.type === "url")) throw new Error("Field URL MusicalDown tidak ditemukan.");
  return { action, fields };
}

function parseMusicalDownResult(html, mode) {
  const source = String(html || "");
  const links = [];
  for (const match of source.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = decodeHtml(match[1].match(/\bhref=["']([^"']+)["']/i)?.[1]);
    const label = textFromHtml(match[2]);
    if (!href) continue;
    try {
      const parsed = new URL(href);
      if (parsed.protocol !== "https:" || parsed.hostname !== "fastdl.muscdn.app") continue;
      links.push({ url: parsed.toString(), label });
    } catch {}
  }
  const author = textFromHtml(source.match(/class=["'][^"']*video-author[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i)?.[1]).replace(/^@/, "");
  const description = textFromHtml(source.match(/class=["'][^"']*video-desc[^"']*["'][^>]*>([\s\S]*?)<\/p>/i)?.[1]);
  const title = textFromHtml(source.match(/<title>([\s\S]*?)<\/title>/i)?.[1]).replace(/\s*\|\s*Download.*$/i, "") || description || "TikTok media";
  const thumb = decodeHtml(source.match(/class=["'][^"']*video-header[^"']*["'][^>]*style=["'][^"']*background-image\s*:\s*url\((https:\/\/fastdl\.muscdn\.app\/a\/images\/[^)'";]+)\)/i)?.[1]) || null;
  const wanted = mode === "audio"
    ? links.find(item => /\bmp3\b|audio/i.test(item.label))
    : links.find(item => /\bmp4\b/i.test(item.label) && /\bhd\b/i.test(item.label) && !/watermark/i.test(item.label))
      || links.find(item => /\bmp4\b/i.test(item.label) && !/watermark/i.test(item.label));
  if (!wanted) throw new Error(mode === "audio" ? "Audio MusicalDown tidak tersedia." : "Video MusicalDown tidak tersedia.");
  const isAudio = mode === "audio";
  const isHd = /\bhd\b/i.test(wanted.label);
  return {
    platform: "tiktok", provider: "musicaldown", resourceKind: "post", title, description, author,
    tags: collectTags(description),
    items: [{
      type: isAudio ? "audio" : "video", url: wanted.url, thumb,
      filename: `${safeName(title || "tiktok")}.${isAudio ? "mp3" : "mp4"}`,
      quality: isAudio ? "Original audio" : isHd ? "HD original tersedia" : "Original tersedia",
      hasAudio: isAudio ? undefined : true,
      codec: isAudio ? undefined : "h264"
    }]
  };
}

async function requestMusicalDown(classified, mode) {
  if (classified.platform !== "tiktok" || classified.kind === "profile" || mode === "mute" || mode === "image") throw new Error("MusicalDown tidak cocok untuk URL ini.");
  const headers = { Accept: "text/html", "Accept-Language": "id-ID,id;q=0.9,en;q=0.8", "User-Agent": "Mozilla/5.0 Chrome/127" };
  const landing = await fetch(MUSICALDOWN_URL, { headers, redirect: "follow", signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  const landingHtml = await landing.text();
  if (!landing.ok) throw new Error(`MusicalDown gagal (${landing.status}).`);
  const { action, fields } = parseMusicalDownForm(landingHtml);
  const body = new URLSearchParams();
  for (const field of fields) body.set(field.name, ["text", "url"].includes(field.type) ? classified.url : field.value);
  const cookie = String(landing.headers.get("set-cookie") || "").split(";", 1)[0];
  const response = await fetch(new URL(action, MUSICALDOWN_URL), {
    method: "POST", redirect: "follow", signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded", Referer: MUSICALDOWN_URL, ...(cookie ? { Cookie: cookie } : {}) },
    body
  });
  const html = await response.text();
  if (!response.ok) throw new Error(`MusicalDown gagal (${response.status}).`);
  return parseMusicalDownResult(html, mode);
}

async function requestThreads(classified, mode) {
  if (classified.platform !== "threads" || mode !== "auto" || classified.kind === "profile") throw new Error("Provider Threads tidak cocok untuk URL ini.");
  const response = await fetch(THREADSDL_URL, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ url: classified.url }), signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  const data = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(data?.medias)) throw new Error(data?.error || `Threads gagal (${response.status}).`);
  const items = [];
  for (const [index, media] of data.medias.entries()) {
    const video = Array.isArray(media.videos) ? media.videos.filter(v => v?.url).sort((a, b) => ((Number(b.width) || 0) * (Number(b.height) || 0)) - ((Number(a.width) || 0) * (Number(a.height) || 0)))[0] : null;
    const image = Array.isArray(media.images) ? media.images.filter(v => v?.url).sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0] : null;
    if (video) items.push({ type: "video", url: video.url, thumb: media.cover || null, filename: `threads-${index + 1}.mp4`, quality: video.width && video.height ? `${video.width}×${video.height}` : media.height ? `${media.height}p` : "HD", hasAudio: true, width: video.width || media.width || undefined, height: video.height || media.height || undefined });
    else if (image) items.push({ type: "image", url: image.url, thumb: image.url, filename: `threads-${index + 1}.jpg`, quality: image.width && image.height ? `${image.width}×${image.height}` : "Original", width: image.width || undefined, height: image.height || undefined });
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
        const resources = Array.isArray(media.display_resources) ? media.display_resources.filter(resource => resource?.src).sort((a, b) => (Number(b.config_width) || 0) * (Number(b.config_height) || 0) - (Number(a.config_width) || 0) * (Number(a.config_height) || 0)) : [];
        const original = type === "image" ? resources[0] : null;
        const mediaUrl = original?.src || url;
        const width = Number(original?.config_width || media.dimensions?.width) || undefined;
        const height = Number(original?.config_height || media.dimensions?.height) || undefined;
        items.push({ type, url: mediaUrl, thumb: media.display_url || null, filename: `instagram-${username}-${items.length + 1}.${type === "video" ? "mp4" : extensionFromUrl(mediaUrl,"jpg")}`, quality: width && height ? `${width}×${height}` : "Original", hasAudio: type === "video" ? true : undefined, width, height });
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
    const width = Number(data.width || data.metadata?.width) || undefined;
    const height = Number(data.height || data.metadata?.height) || undefined;
    return { platform: classified.platform, provider: "cobalt", resourceKind: classified.kind, title: String(data.filename || `${classified.platform} media`).replace(/\.[a-z0-9]{2,5}$/i,""), items: [{ type, url: data.url, filename: data.filename || `media.${type === "audio" ? "m4a" : type === "image" ? "jpg" : "mp4"}`, quality: width && height ? `${width}×${height}` : "Original maksimum", width, height, hasAudio: type === "video" ? mode !== "mute" : undefined }] };
  }
  if (data.status === "picker") return { platform: classified.platform, provider: "cobalt", resourceKind: classified.kind, title: `${classified.platform} media`, items: (data.picker || []).map((item,i)=>({ type: item.type === "photo" ? "image" : "video", url: item.url, thumb: item.thumb || null, filename: `media-${i+1}.${item.type === "photo" ? "jpg" : "mp4"}`, quality: item.width && item.height ? `${item.width}×${item.height}` : "Original maksimum", width: Number(item.width) || undefined, height: Number(item.height) || undefined, hasAudio: item.type === "photo" ? undefined : true })) };
  throw new Error(data.error?.code || "Cobalt tidak memberikan media.");
}

async function probeDownloadable(url) {
  try {
    const headers = { "User-Agent": "Mozilla/5.0 Chrome/127", "Accept-Encoding": "identity", Range: "bytes=0-0" };
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("tiktok")) headers.Referer = "https://www.tiktok.com/";
    else if (host.includes("instagram")) headers.Referer = "https://www.instagram.com/";
    else if (host.includes("fbcdn")) headers.Referer = "https://www.facebook.com/";
    else if (host.includes("twimg")) headers.Referer = "https://x.com/";
    const response = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(6000) });
    return response.status === 200 || response.status === 206;
  } catch {
    return false;
  }
}

async function probeDownloadableItems(result) {
  const items = result?.items || [];
  if (!items.length) return false;
  for (const item of items) {
    if (!(await probeDownloadable(item.url))) return false;
  }
  return true;
}

async function verifyTiktokResult(winning, providerResults) {
  const items = winning?.items || [];
  if (!items.length || await probeDownloadableItems(winning)) return winning;
  const candidates = providerResults
    .filter(entry => entry.result !== winning)
    .sort((a, b) => b.score - a.score);
  for (const candidate of candidates) {
    if (candidate.result?.items?.length && await probeDownloadableItems(candidate.result)) {
      return { ...candidate.result };
    }
  }
  return winning;
}

function resultQuality(result) {
  let max = 0;
  for (const item of result?.items || []) {
    const explicit = Number(item?.height) || 0;
    const width = Number(item?.width) || 0;
    const score = explicit * 1_000_000 + width;
    if (score > max) { max = score; continue; }
    const label = String(item?.quality || "");
    const dimensions = label.match(/(\d+)\s*[x×]\s*(\d+)/i);
    if (dimensions) {
      max = Math.max(max, Number(dimensions[1]) * 1_000_000 + Number(dimensions[2]));
    } else {
      const height = label.match(/(\d{3,5})\s*p/i);
      if (height) max = Math.max(max, Number(height[1]) * 1_000_000);
      else if (/\b(?:full\s*hd|fhd|hd\s+original)\b/i.test(label)) max = Math.max(max, 1080 * 1_000_000);
      else if (/\bhd\b/i.test(label)) max = Math.max(max, 720 * 1_000_000);
    }
  }
  return max;
}

async function raceProviders(attempts, mode, { graceMs = 8000 } = {}) {
  const startedAt = Date.now();
  const failures = [];
  return new Promise((resolve, reject) => {
    let pending = attempts.length;
    if (!pending) return reject(Object.assign(new Error("Tidak ada provider yang tersedia."), { code: "NO_PROVIDER" }));
    let best = null;
    let graceTimer = null;
    let finished = false;
    const results = [];
    const finish = entry => { if (finished) return; finished = true; clearTimeout(graceTimer); clearTimeout(deadlineTimer); resolve(entry); };
    const fail = error => { if (finished) return; finished = true; clearTimeout(graceTimer); clearTimeout(deadlineTimer); reject(error); };
    const deadlineTimer = setTimeout(() => fail(Object.assign(new Error("Batas waktu pemrosesan tercapai."), { code: "GLOBAL_TIMEOUT", details: failures })), GLOBAL_DEADLINE_MS);
    for (const attempt of attempts) {
      Promise.resolve().then(attempt.run).then(raw => validateResult(raw, { mode })).then(result => {
        const score = resultQuality(result);
        results.push({ result, provider: attempt.name, score });
        if (!best || score > best.score) best = { result, provider: attempt.name, durationMs: Date.now() - startedAt, score };
        pending -= 1;
        if (pending === 0) return finish({ ...best, failures: [...failures], results: [...results] });
        if (!graceTimer) graceTimer = setTimeout(() => { if (best) finish({ ...best, failures: [...failures], results: [...results] }); }, graceMs);
      }).catch(error => {
        failures.push({ provider: attempt.name, ...sanitizeProviderError(error) });
        pending -= 1;
        if (pending === 0) {
          if (best) return finish({ ...best, failures: [...failures], results: [...results] });
          fail(Object.assign(new Error("Semua mesin gagal memproses tautan tersebut."), { code: "ALL_PROVIDERS_FAILED", details: failures }));
        }
      });
    }
  });
}

function buildAttempts(classified, mode) {
  const attempts = [];
  const wavyOnly = ["instagram", "facebook"].includes(classified.platform);
  if (wavyOnly) {
    if (classified.kind === "profile" && classified.platform === "instagram") {
      attempts.push({ name: "instagram-direct", run: () => igDirect.requestProfile(classified.handle) });
      attempts.push({ name: "wavy", run: () => wavy.requestWavy(classified, mode) });
    } else {
      attempts.push({ name: "wavy", run: () => wavy.requestWavy(classified, mode) });
    }
    return attempts;
  }
  if (classified.kind === "profile" && classified.platform === "instagram") {
    attempts.push({ name: "instagram-profile", run: () => requestInstagramProfile(classified) });
    attempts.push({ name: "instagram-direct", run: () => igDirect.requestProfile(classified.handle) });
  }
  if (fastdl.isEnabled()) attempts.push({ name: "fastdl", run: () => fastdl.requestFastdl(classified) });
  if (classified.platform === "tiktok") {
    attempts.push({ name: "musicaldown", run: () => requestMusicalDown(classified, mode) });
    attempts.push({ name: "tikwm", run: () => requestTikwm(classified, mode) });
  }
  if (classified.platform === "threads") attempts.push({ name: "threadsdl", run: () => requestThreads(classified, mode) });
  attempts.push({ name: "yt-dlp", run: () => requestYtdlp(classified, mode) });
  for (const endpoint of providerEndpoints()) attempts.push({ name: `cobalt:${new URL(endpoint).hostname}`, run: () => requestCobalt(classified, mode, endpoint) });
  return attempts;
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
  const mode = ["auto", "image", "audio", "mute"].includes(req.body?.mode) ? req.body.mode : "auto";
  const classified = classifyUrl(url);
  if (!classified || classified.kind === "unknown") return res.status(400).json({ error: "URL publik tidak dikenali atau tidak didukung.", code: "UNSUPPORTED_URL" });
  if (classified.kind === "profile" && mode !== "auto") return res.status(400).json({ error: "Profil hanya mendukung mode otomatis.", code: "PROFILE_MODE_UNSUPPORTED" });
  try {
    const { result: racedResult, durationMs, failures = [], results: providerResults = [] } = await raceProviders(buildAttempts(classified, mode), mode);
    let result = classified.platform === "tiktok" ? await verifyTiktokResult(racedResult, providerResults) : racedResult;
    if (result !== racedResult) {
      result.warnings = [...(result.warnings || []), "Resolusi tertinggi membutuhkan sesi platform; dipakai kualitas publik terbaik yang dapat diunduh."];
      result.downloadFallback = true;
    }
    result.durationMs = durationMs;
    result.providerFailures = failures.map(item => ({ provider: item.provider, code: item.code, message: item.message }));
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
module.exports.probeDownloadable = probeDownloadable;
module.exports.verifyTiktokResult = verifyTiktokResult;
module.exports.parseMusicalDownForm = parseMusicalDownForm;
module.exports.parseMusicalDownResult = parseMusicalDownResult;
module.exports.requestMusicalDown = requestMusicalDown;
