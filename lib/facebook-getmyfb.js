"use strict";

const { safeName } = require("./core");

const GETMYFB_ORIGIN = "https://getmyfb.com";
const GETMYFB_PROCESS_URL = `${GETMYFB_ORIGIN}/process`;
const PROVIDER_TIMEOUT_MS = 20000;
const MAX_RESPONSE_BYTES = 512 * 1024;

function decodeCodePoint(raw, radix, original) {
  const code = Number.parseInt(raw, radix);
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : original;
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (entity, code) => decodeCodePoint(code, 16, entity))
    .replace(/&#(\d+);/g, (entity, code) => decodeCodePoint(code, 10, entity))
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function textFromHtml(value) {
  return decodeHtml(String(value || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function attribute(attrs, name) {
  const quoted = String(attrs || "").match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
  if (quoted) return decodeHtml(quoted[2]);
  return decodeHtml(String(attrs || "").match(new RegExp(`\\b${name}\\s*=\\s*([^\\s>]+)`, "i"))?.[1] || "");
}

function hasClass(attrs, name) {
  return attribute(attrs, "class").split(/\s+/).includes(name);
}

function allowedProviderUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname === "ssscdn.io" && !parsed.port && !parsed.username && !parsed.password && parsed.pathname.startsWith("/getmyfb/");
  } catch {
    return false;
  }
}

async function limitedResponseText(response) {
  const declared = Number(response.headers.get("content-length")) || 0;
  if (declared > MAX_RESPONSE_BYTES) throw new Error("Respons GetMyFb terlalu besar.");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Respons GetMyFb terlalu besar.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, received).toString("utf8");
}

function resultThumbnail(source) {
  for (const match of String(source || "").matchAll(/<img\b([^>]*)>/gi)) {
    if (!hasClass(match[1], "results-item-image")) continue;
    const url = attribute(match[1], "src");
    if (allowedProviderUrl(url)) return url;
  }
  return null;
}

function resultTitle(source) {
  for (const match of String(source || "").matchAll(/<figcaption\b([^>]*)>([\s\S]*?)<\/figcaption>/gi)) {
    if (!hasClass(match[1], "results-item-text")) continue;
    const title = textFromHtml(match[2]);
    if (title) return title;
  }
  return "Facebook media";
}

function downloadItems(source, title, thumb) {
  const items = [];
  for (const match of String(source || "").matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/gi)) {
    if (!hasClass(match[1], "results-list-item")) continue;
    const content = match[2];
    const anchor = content.match(/<a\b([^>]*)>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const attrs = anchor[1];
    const classes = attribute(attrs, "class").split(/\s+/);
    if (classes.includes("mp3")) continue;

    const url = attribute(attrs, "href");
    if (!allowedProviderUrl(url)) continue;
    const suppliedFilename = attribute(attrs, "download");
    const ext = suppliedFilename.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase() || "";
    const type = classes.includes("photo-button") || ["jpg", "jpeg", "png", "webp", "avif"].includes(ext) ? "image" : ext === "mp4" || classes.some(name => ["hd-button", "sd-button"].includes(name)) ? "video" : null;
    if (!type) continue;

    const label = textFromHtml(content.slice(0, anchor.index));
    const height = Number(label.match(/(\d{3,4})\s*p/i)?.[1]) || undefined;
    const fallbackExt = type === "image" ? "jpg" : "mp4";
    const filename = suppliedFilename || `${safeName(title || "facebook")}.${fallbackExt}`;
    items.push({
      type,
      url,
      thumb: thumb || (type === "image" ? url : null),
      filename,
      quality: label || (classes.includes("hd-button") ? "HD" : classes.includes("sd-button") ? "SD" : "Original"),
      height,
      hasAudio: type === "video" ? true : undefined
    });
  }
  return items;
}

function parseGetMyFbResult(html, classified, mode = "auto") {
  if (!["auto", "image"].includes(mode)) throw new Error("GetMyFb tidak menyediakan mode ini.");
  const source = String(html || "");
  let errorPayload = null;
  try { errorPayload = JSON.parse(source); } catch {}
  if (errorPayload?.error === "rate_limit") throw Object.assign(new Error("GetMyFb membatasi permintaan sementara."), { code: "PROVIDER_RATE_LIMIT" });

  const title = resultTitle(source);
  const thumb = resultThumbnail(source);
  const parsed = downloadItems(source, title, thumb);
  const images = parsed.filter(item => item.type === "image");
  const bestVideo = parsed.filter(item => item.type === "video").sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0))[0];
  const items = mode === "image" ? images : [...images, ...(bestVideo ? [bestVideo] : [])];
  if (!items.length) throw new Error(mode === "image" ? "GetMyFb tidak menemukan gambar publik." : "GetMyFb tidak menemukan media publik.");

  return {
    platform: "facebook",
    provider: "getmyfb",
    resourceKind: classified.kind || "post",
    collection: items.length > 1,
    title,
    items
  };
}

async function requestGetMyFb(classified, mode) {
  if (classified.platform !== "facebook" || classified.kind === "profile") throw new Error("GetMyFb tidak cocok untuk URL ini.");
  if (!["auto", "image"].includes(mode)) throw new Error("GetMyFb tidak menyediakan mode ini.");
  const body = new URLSearchParams({ id: classified.url, locale: "en" });
  const response = await fetch(GETMYFB_PROCESS_URL, {
    method: "POST",
    headers: {
      Accept: "text/html, */*; q=0.01",
      "Content-Type": "application/x-www-form-urlencoded",
      "HX-Request": "true",
      "HX-Trigger": "form",
      "HX-Target": "target",
      "HX-Current-URL": `${GETMYFB_ORIGIN}/`,
      Origin: GETMYFB_ORIGIN,
      Referer: `${GETMYFB_ORIGIN}/`,
      "User-Agent": "Mozilla/5.0 Chrome/127"
    },
    body,
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
  });
  const html = await limitedResponseText(response);
  if (!response.ok) throw new Error(`GetMyFb gagal (${response.status}).`);
  return parseGetMyFbResult(html, classified, mode);
}

module.exports = { GETMYFB_PROCESS_URL, allowedProviderUrl, limitedResponseText, parseGetMyFbResult, requestGetMyFb };
