"use strict";

const crypto = require("node:crypto");
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
  const signature = webSignatureConfig();
  return Boolean(cfg.apiUrl && (cfg.apiKey || (/^[0-9a-f]{64}$/i.test(signature.secret) && Number.isFinite(signature.timestamp) && signature.timestamp > 0)));
}

function webSignatureConfig() {
  return {
    secret: String(process.env.FASTDL_WEB_SIGNATURE_SECRET || "").trim(),
    timestamp: Number(process.env.FASTDL_WEB_SIGNATURE_TIMESTAMP || 0)
  };
}

function signWebRequest(body, { now = Date.now(), correction = 0 } = {}) {
  const cfg = webSignatureConfig();
  if (!/^[0-9a-f]{64}$/i.test(cfg.secret) || !Number.isFinite(cfg.timestamp)) {
    throw Object.assign(new Error("Signature web FastDL tidak valid."), { code: "FASTDL_SIGNATURE_INVALID" });
  }
  const ts = Math.floor(Number(now) - Number(correction || 0));
  const sorted = Object.keys(body || {}).sort().reduce((out, key) => { out[key] = body[key]; return out; }, {});
  const signature = crypto.createHmac("sha256", Buffer.from(cfg.secret, "hex"))
    .update(`${JSON.stringify(sorted)}${ts}`)
    .digest("hex");
  return { ...body, ts, _ts: cfg.timestamp, _tsc: Number(correction) || 0, _sv: 2, _s: signature };
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
    const variants = Array.isArray(e.url) ? e.url.filter(item => item?.url) : [];
    const isVideoVariant = item => {
      const type = String(item?.type || "").toLowerCase();
      const ext = String(item?.ext || "").toLowerCase();
      const name = String(item?.name || "").toLowerCase();
      let pathname = "";
      try { pathname = new URL(item?.url).pathname.toLowerCase(); } catch {}
      return type === "video" || type === "mp4" || type.startsWith("video/") || ["mp4", "m4v", "mov", "webm"].includes(ext) || /\.(?:mp4|m4v|mov|webm)$/.test(name) || /\.(?:mp4|m4v|mov|webm)$/.test(pathname);
    };
    const url0 = variants.find(isVideoVariant) || variants[0];
    const title = e?.meta?.title || "instagram-media";

    const isVideo = isVideoVariant(url0);

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
  let requestBody = body;
  if (cfg.apiKey) headers[cfg.keyHeader] = cfg.apiKey;
  else {
    headers.Origin = "https://fastdl.app";
    headers.Referer = "https://fastdl.app/";
    requestBody = signWebRequest(body);
  }
  const response = await fetch(`${cfg.apiUrl}${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const msg = String(payload?.message || payload?.error || payload?.info || `fastdl gagal (${response.status}).`).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    throw Object.assign(new Error(msg), { code: payload?.code || "FASTDL_FAILED" });
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

async function requestPosts(cfg, classified, options = {}) {
  const limit = Math.max(1, Math.min(Math.floor(Number(options.limit) || IG_PROFILE_LIMIT), 100));
  const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
  const order = options.order === "oldest" ? "oldest" : "newest";
  if (order !== "newest") throw new Error("FastDL profil hanya menyediakan urutan terbaru.");
  const payload = await requestJson(cfg, "/api/v1/instagram/postsV2", { username: classified.handle, maxId: "" });
  const content = unwrap(payload);
  const list = Array.isArray(content) ? content : [];
  const items = [];
  for (const entry of list) {
    items.push(...igItemToItems(entry, cfg));
    if (items.length >= offset + limit) break;
  }
  const selected = items.slice(offset, offset + limit);
  if (!selected.length) throw new Error("fastdl tidak menemukan postingan profil ini.");
  const hasMore = items.length > offset + limit || list.length >= IG_PROFILE_LIMIT;
  return {
    platform: "instagram",
    provider: cfg.apiKey ? "fastdl" : "fastdl-web",
    resourceKind: "profile",
    title: `Koleksi media @${classified.handle}`,
    author: classified.handle,
    collection: true,
    partial: hasMore,
    pagination: { offset, limit, hasMore, order },
    items: selected
  };
}

async function requestFastdl(classified, options = {}) {
  const cfg = fastdlConfig();
  if (!isEnabled()) throw new Error("fastdl tidak dikonfigurasi.");
  if (classified.platform !== "instagram") throw new Error("fastdl hanya untuk Instagram.");

  if (classified.kind === "story") return requestStory(cfg, classified);
  if (classified.kind === "profile") return requestPosts(cfg, classified, options);
  return requestConvert(cfg, classified);
}

module.exports = {
  fastdlConfig,
  isEnabled,
  webSignatureConfig,
  signWebRequest,
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
