"use strict";

const { safeName } = require("./core");

const PROVIDER_TIMEOUT_MS = 25000;

function wavyEndpoint() {
  return String(process.env.WAVY_API_URL || "https://wavy.netraux.eu.cc/api/download").trim().replace(/\/+$/, "");
}

function convertItem(m, title, cover) {
  const rawType = String(m?.type || "").toLowerCase();
  const ext = String(m?.extension || "").toLowerCase().replace(/^jpe?g$/, "jpg") || (rawType === "audio" ? "m4a" : rawType === "image" ? "jpg" : "mp4");
  const kind = rawType === "audio" || m?.isAudio ? "audio" : rawType === "image" ? "image" : "video";
  const base = {
    type: kind,
    url: m?.url,
    thumb: kind === "video" || kind === "image" ? cover : null,
    filename: `${safeName(`${title || "media"}-${Date.now()}`)}.${ext}`,
    mime: m?.mimetype || (kind === "video" ? "video/mp4" : kind === "audio" ? "audio/mp4" : "image/jpeg"),
    quality: "Kualitas asli tersedia"
  };
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
