"use strict";

const { safeName, collectTags } = require("./core");

const PROVIDER_TIMEOUT_MS = 15000;
const IG_PROFILE_LIMIT = 24;

function fastdlConfig() {
  return {
    apiUrl: String(process.env.FASTDL_API_URL || "https://api-wh.fastdl.app").trim().replace(/\/+$/, ""),
    apiKey: String(process.env.FASTDL_API_KEY || "").trim(),
    keyHeader: String(process.env.FASTDL_API_KEY_HEADER || "x-api-key").trim(),
    mediaUrl: String(process.env.FASTDL_MEDIA_URL || "https://media.fastdl.app").trim().replace(/\/+$/, "")
  };
}

function isEnabled() {
  const cfg = fastdlConfig();
  return Boolean(cfg.apiUrl && cfg.apiKey);
}

function getFilename(pathname) {
  const match = String(pathname || "").match(/([\w-]+\.(?:jpg|mp4))$/i);
  return match ? match[1] : "";
}

function downloadableUrl(url, signature, cfg) {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.get("__sig")) return url;
    if (parsed.searchParams.get("efg") && signature) {
      const { expires, signature: sig } = signature || {};
      if (sig) {
        return `${cfg.mediaUrl}/get?uri=${encodeURIComponent(url)}&filename=${encodeURIComponent(getFilename(parsed.pathname) || "media")}&__sig=${encodeURIComponent(sig)}&__expires=${Number(expires) || 0}&referer=${encodeURIComponent("https://www.instagram.com/")}`;
      }
    }
    return url;
  } catch {
    return url;
  }
}

function candidateImage(item) {
  const c = item?.image_versions2?.candidates?.[0];
  return c ? { url: c.url, url_downloadable: c.url_downloadable || null, url_wrapped: c.url_wrapped || null, signature: c.url_signature || null } : null;
}

function firstVideo(item) {
  return item?.video_versions?.[0] || null;
}

function captionOf(item) {
  return (item?.caption?.text) || (item?.meta?.title) || "";
}

function shortcodeOf(item) {
  return (item?.meta?.shortcode) || (item?.shortcode) || "";
}

function igItemToItems(item, cfg) {
  const out = [];
  if (!item || typeof item !== "object") return out;

  if (Array.isArray(item.carousel_media) && item.carousel_media.length) {
    for (const child of item.carousel_media) out.push(...igItemToItems(child, cfg));
    return out;
  }

  const img = candidateImage(item);
  const vid = firstVideo(item);
  const title = captionOf(item) || shortcodeOf(item) || "instagram-media";

  if (vid) {
    const url = vid.url_downloadable || downloadableUrl(vid.url, vid.url_signature, cfg);
    out.push({
      type: "video",
      url,
      thumb: (img && (img.url_wrapped || img.url)) || null,
      filename: `${safeName(title)}.mp4`,
      mime: "video/mp4",
      quality: "Kualitas tertinggi tersedia",
      hasAudio: true,
      codec: "h264"
    });
    return out;
  }

  if (img) {
    const url = img.url_downloadable || downloadableUrl(img.url, img.signature, cfg);
    out.push({
      type: "image",
      url,
      thumb: (img.url_wrapped || img.url) || null,
      filename: `${safeName(title)}.jpg`,
      mime: "image/jpeg",
      quality: "Kualitas tertinggi tersedia"
    });
    return out;
  }

  return out;
}

function convertToItems(content, cfg) {
  const out = [];
  for (const e of (Array.isArray(content) ? content : [content])) {
    if (!e || typeof e !== "object") continue;
    const url0 = e?.url?.[0];
    const title = e?.meta?.title || "instagram-media";

    let isVideo = false;
    if (url0) {
      const probe = [String(url0.type || "").toLowerCase(), String(url0.ext || "").toLowerCase(), String(url0.name || "").toLowerCase()];
      isVideo = probe.includes("mp4");
    }

    if (url0 && isVideo) {
      out.push({ type: "video", url: url0.url, thumb: e.thumb || null, filename: `${safeName(title)}.mp4`, mime: "video/mp4", quality: "Kualitas tertinggi tersedia", hasAudio: true, codec: "h264" });
    } else if (url0) {
      out.push({ type: "image", url: url0.url, thumb: e.thumb || url0.url || null, filename: `${safeName(title)}.jpg`, mime: "image/jpeg", quality: "Kualitas tertinggi tersedia" });
    } else {
      const vid = e?.video_versions?.[0];
      if (vid) out.push({ type: "video", url: vid.url_downloadable || downloadableUrl(vid.url, vid.url_signature, cfg), thumb: e.thumb || null, filename: `${safeName(title)}.mp4`, mime: "video/mp4", quality: "Kualitas tertinggi tersedia", hasAudio: true, codec: "h264" });
    }
  }
  return out;
}

function unwrap(body) {
  const root = body?.data;
  return root?.data !== undefined ? root.data : root;
}

async function requestJson(cfg, pathname, body) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0 Chrome/127"
  };
  if (cfg.apiKey) headers[cfg.keyHeader] = cfg.apiKey;
  const response = await fetch(`${cfg.apiUrl}${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const msg = payload?.message || payload?.error || `fastdl gagal (${response.status}).`;
    throw new Error(msg);
  }
  if (payload?.success === false) throw new Error(payload.message || "fastdl menolak permintaan.");
  return payload;
}

async function requestConvert(cfg, classified) {
  const payload = await requestJson(cfg, "/api/convert", { sf_url: classified.url });
  const items = convertToItems(unwrap(payload), cfg);
  if (!items.length) throw new Error("fastdl tidak menemukan media pada tautan ini.");
  return {
    platform: "instagram",
    provider: "fastdl",
    resourceKind: classified.kind,
    title: "Media Instagram",
    collection: items.length > 1,
    items
  };
}

async function requestStory(cfg, classified) {
  const payload = await requestJson(cfg, "/api/v1/instagram/story", { url: classified.url });
  const content = unwrap(payload);
  const items = igItemToItems(Array.isArray(content) ? content[0] : content, cfg);
  if (!items.length) {
    const viaStories = Array.isArray(content) ? content.flatMap(item => igItemToItems(item, cfg)) : [];
    items.push(...viaStories);
  }
  if (!items.length) throw new Error("fastdl tidak menemukan story pada tautan ini.");
  return { platform: "instagram", provider: "fastdl", resourceKind: "story", title: "Story Instagram", collection: items.length > 1, items };
}

async function requestPosts(cfg, classified) {
  const payload = await requestJson(cfg, "/api/v1/instagram/postsV2", { username: classified.handle, maxId: "" });
  const content = unwrap(payload);
  const list = Array.isArray(content) ? content : [];
  const items = [];
  for (const entry of list) {
    items.push(...igItemToItems(entry, cfg));
    if (items.length >= IG_PROFILE_LIMIT) break;
  }
  if (!items.length) throw new Error("fastdl tidak menemukan postingan profil ini.");
  return {
    platform: "instagram",
    provider: "fastdl",
    resourceKind: "profile",
    title: `Koleksi media @${classified.handle}`,
    author: classified.handle,
    collection: true,
    partial: items.length >= IG_PROFILE_LIMIT,
    items
  };
}

async function requestFastdl(classified) {
  const cfg = fastdlConfig();
  if (!isEnabled()) throw new Error("fastdl tidak dikonfigurasi.");
  if (classified.platform !== "instagram") throw new Error("fastdl hanya untuk Instagram.");

  if (classified.kind === "story") return requestStory(cfg, classified);
  if (classified.kind === "profile") return requestPosts(cfg, classified);
  return requestConvert(cfg, classified);
}

module.exports = {
  fastdlConfig,
  isEnabled,
  downloadableUrl,
  getFilename,
  igItemToItems,
  convertToItems,
  unwrap,
  requestConvert,
  requestStory,
  requestPosts,
  requestFastdl
};
