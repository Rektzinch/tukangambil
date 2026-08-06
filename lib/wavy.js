"use strict";

const { safeName } = require("./core");

const PROVIDER_TIMEOUT_MS = 25000;

function wavyEndpoint() {
  return String(process.env.WAVY_API_URL || "https://wavy.netraux.eu.cc/api/download").trim().replace(/\/+$/, "");
}

const QUALITY_LABELS = {
  hd: "HD", "4k": "4K", "2k": "2K", qhd: "QHD", fhd: "FHD 1080",
  "1080p": "1080p", "720p": "720p", sd: "SD", standard: "Standard",
  normal: "Normal", medium: "Medium", high: "High", original: "Original asli"
};

const QUALITY_FLAGS = { "4k": true, "2k": true, qhd: true, fhd: true, hd: true, "1080p": true, high: true, original: true };

function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}GB`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}MB`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}KB`;
  return `${n}B`;
}

function qualityLabel(raw) {
  const value = String(raw || "").toLowerCase().trim();
  return QUALITY_LABELS[value] || (value ? value.charAt(0).toUpperCase() + value.slice(1) : "Super HD asli");
}

function convertItem(m, title, cover) {
  const rawType = String(m?.type || "").toLowerCase();
  const ext = String(m?.extension || "").toLowerCase().replace(/^jpe?g$/, "jpg") || (rawType === "audio" ? "m4a" : rawType === "image" ? "jpg" : "mp4");
  const kind = rawType === "audio" || m?.isAudio ? "audio" : rawType === "image" ? "image" : "video";
  const qRaw = m?.quality || (m?.url?.includes("v16") ? "hd" : "original");
  const qFlag = Boolean(QUALITY_FLAGS[String(qRaw).toLowerCase()]);
  const size = formatSize(m?.size) || "";
  const base = {
    type: kind,
    url: m?.url,
    thumb: kind === "video" || kind === "image" ? cover : null,
    filename: `${safeName(`${title || "media"}-${Date.now()}`)}.${ext}`,
    mime: m?.mimetype || (kind === "video" ? "video/mp4" : kind === "audio" ? "audio/mp4" : "image/jpeg"),
    quality: qualityLabel(qRaw)
  };
  if (qFlag) base.bestQuality = true;
  if (size) base.size = size;
  if (Number(m?.width)) base.width = Number(m.width);
  if (Number(m?.height)) base.height = Number(m.height);
  if (kind === "video") base.hasAudio = !Boolean(m?.isAudio);
  return base;
}

async function requestWavy(classified, mode) {
  const endpoint = new URL(wavyEndpoint());
  endpoint.searchParams.set("url", classified.url);
  const response = await fetch(endpoint, { method: "GET", headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 Chrome/127" }, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.success) throw new Error(data?.error || `Wavy gagal (${response.status}).`);
  let post = data?.result;
  if (post?.result) post = post.result;
  const media = Array.isArray(post?.media?.all) ? post.media.all : [];
  let items = media.map(m => convertItem(m, post?.title, post?.cover)).filter(item => item?.url);
  if (mode === "image") items = items.filter(i => i.type === "image");
  else if (mode === "audio") items = items.filter(i => i.type === "audio");
  else if (mode === "mute") items = items.filter(i => i.type === "video");
  else items = items.filter(i => i.type === "video" || i.type === "image");
  const seen = new Set();
  items = items.filter(i => (seen.has(i.url) ? false : (seen.add(i.url), true)));
  if (!items.length) throw new Error("Wavy tidak menemukan media yang kompatibel pada tautan ini.");
  return {
    platform: data?.platform || classified.platform || "unknown",
    provider: "wavy",
    resourceKind: classified.kind || "post",
    collection: items.length > 1,
    title: post?.title || "Media publik",
    author: post?.author?.username || classified.handle || "",
    items
  };
}

module.exports = { wavyEndpoint, convertItem, requestWavy };
