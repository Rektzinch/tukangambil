"use strict";

const { safeName, collectTags, extensionFromUrl } = require("./core");
const { allowedMediaUrl } = require("./media-policy");
const MAX_HTML_BYTES = 2 * 1024 * 1024;

function shortcodeOf(classified) {
  if (classified.platform !== "instagram") throw new Error("Bukan tautan Instagram.");
  const parts = new URL(classified.url).pathname.split("/").filter(Boolean);
  const index = parts.findIndex(part => ["p", "reel", "reels", "tv"].includes(part));
  const shortcode = parts[index + 1];
  if (index < 0 || !/^[A-Za-z0-9_-]{5,28}$/.test(shortcode || "")) throw new Error("Tautan postingan Instagram tidak dikenali.");
  return shortcode;
}

async function limitedHtml(response) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Sumber Instagram gagal (${response.status}).`);
  }
  if (Number(response.headers.get("content-length")) > MAX_HTML_BYTES) {
    await response.body?.cancel();
    throw new Error("Respons Instagram terlalu besar.");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_HTML_BYTES) throw new Error("Respons Instagram terlalu besar.");
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

function parseEmbed(html, classified, mode = "auto") {
  const match = String(html).match(/"contextJSON"\s*:\s*("(?:\\.|[^"\\])*")/);
  let context;
  try { context = JSON.parse(JSON.parse(match?.[1] || '""')); } catch {}
  const node = context?.gql_data?.shortcode_media;
  if (!node || context?.context?.copyright_blocked || node.owner?.is_private) {
    throw Object.assign(new Error("Embed Instagram tidak menyediakan media publik."), { code: "INSTAGRAM_EMBED_UNAVAILABLE" });
  }
  const children = node.edge_sidecar_to_children?.edges?.map(edge => edge.node).filter(Boolean) || [node];
  const items = [];
  for (const child of children) {
    const video = child.is_video || /Video/.test(child.__typename || "");
    if (video && mode === "image") continue;
    if (["audio", "mute"].includes(mode)) continue;
    const original = [...(child.display_resources || [])].sort((a, b) => (b.config_width || 0) * (b.config_height || 0) - (a.config_width || 0) * (a.config_height || 0))[0];
    const url = video ? child.video_url : original?.src || child.display_url;
    if (!allowedMediaUrl(url)) continue;
    const width = Number(video ? child.dimensions?.width : original?.config_width || child.dimensions?.width) || undefined;
    const height = Number(video ? child.dimensions?.height : original?.config_height || child.dimensions?.height) || undefined;
    items.push({
      id: child.id, type: video ? "video" : "image", url,
      thumb: child.display_url || null,
      filename: `instagram-${safeName(node.shortcode)}-${items.length + 1}.${video ? "mp4" : extensionFromUrl(url, "jpg")}`,
      width, height, quality: width && height ? `${width}×${height}` : "Original",
      hasAudio: video ? child.has_audio !== false : undefined
    });
  }
  if (!items.length) throw Object.assign(new Error("Format ini tidak tersedia dari embed Instagram."), { code: "NO_COMPATIBLE_MEDIA" });
  const caption = node.edge_media_to_caption?.edges?.[0]?.node?.text || "";
  return { platform: "instagram", provider: "instagram-embed", resourceKind: classified.kind, collection: items.length > 1, title: caption || `Instagram @${node.owner?.username || "media"}`, description: caption, author: node.owner?.username || "", tags: collectTags(caption), items };
}

function decodeAttribute(value) {
  return String(value || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)));
}

function parseVx(html, classified, mode = "auto") {
  const tags = new Map();
  for (const match of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = Object.fromEntries([...match[0].matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)].map(m => [m[1].toLowerCase(), decodeAttribute(m[3])]));
    const key = attributes.property || attributes.name;
    if (key && attributes.content) tags.set(key, [...(tags.get(key) || []), attributes.content]);
  }
  const videos = [...new Set([...(tags.get("og:video") || []), ...(tags.get("og:video:secure_url") || [])])].filter(allowedMediaUrl);
  const images = [...new Set(tags.get("og:image") || [])].filter(allowedMediaUrl);
  // Video poster images are previews, not original photo posts.
  const type = videos.length ? "video" : "image";
  const urls = type === "video" ? videos : images;
  if (["audio", "mute"].includes(mode) || (mode === "image" && type !== "image") || !urls.length) throw new Error("VXInstagram tidak memberikan format yang sesuai.");
  return { platform: "instagram", provider: "vxinstagram", resourceKind: classified.kind, collection: urls.length > 1, title: tags.get("og:title")?.[0] || "Instagram media", description: tags.get("og:description")?.[0] || "", items: urls.map((url, i) => ({ type, url, thumb: images[0] || null, filename: `instagram-${i + 1}.${type === "video" ? "mp4" : extensionFromUrl(url, "jpg")}`, quality: "Original", width: Number(tags.get(`og:${type}:width`)?.[0]) || undefined, height: Number(tags.get(`og:${type}:height`)?.[0]) || undefined, hasAudio: type === "video" ? true : undefined })) };
}

async function requestInstagramEmbed(classified, mode) {
  const code = shortcodeOf(classified);
  const response = await fetch(`https://www.instagram.com/p/${code}/embed/captioned/`, { headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" }, signal: AbortSignal.timeout(12000) });
  return parseEmbed(await limitedHtml(response), classified, mode);
}

async function requestVxInstagram(classified, mode) {
  const code = shortcodeOf(classified);
  const response = await fetch(`https://www.vxinstagram.com/p/${code}/`, { headers: { "User-Agent": "TukangAmbil/2.0", Accept: "text/html" }, signal: AbortSignal.timeout(15000) });
  return parseVx(await limitedHtml(response), classified, mode);
}

function parseProfileEmbed(html, handle) {
  const match = String(html).match(/"contextJSON"\s*:\s*("(?:\\.|[^"\\])*")/);
  let context;
  try { context = JSON.parse(JSON.parse(match?.[1] || '""'))?.context; } catch {}
  if (context?.type !== "Profile" || context.is_private || context.username?.toLowerCase() !== handle.toLowerCase() || !Array.isArray(context.graphql_media)) throw new Error("Profil publik Instagram tidak tersedia.");
  return context;
}

async function requestProfileEmbed(classified, { limit = 24, offset = 0, deadline = Date.now() + 28000 } = {}) {
  const remaining = () => Math.max(1, deadline - Date.now());
  const response = await fetch(`https://www.instagram.com/${encodeURIComponent(classified.handle)}/embed/`, { headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" }, signal: AbortSignal.timeout(Math.min(10000, remaining())) });
  const context = parseProfileEmbed(await limitedHtml(response), classified.handle);
  const nodes = context.graphql_media.map(entry => entry.shortcode_media).filter(node => /^[A-Za-z0-9_-]{5,28}$/.test(node?.shortcode || "")).sort((a, b) => (b.taken_at_timestamp || 0) - (a.taken_at_timestamp || 0));
  const selected = nodes.slice(offset, offset + limit);
  if (!selected.length) throw new Error("Tidak ada postingan tambahan di embed publik profil ini.");
  const batches = new Array(selected.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
    while (cursor < selected.length) {
      const index = cursor++;
      const node = selected[index];
      const sourceUrl = `https://www.instagram.com/p/${node.shortcode}/`;
      const publishedAt = node.taken_at_timestamp ? new Date(node.taken_at_timestamp * 1000).toISOString() : undefined;
      try {
        if (remaining() < 2000) throw new Error("Batas waktu profil.");
        const post = await fetch(`${sourceUrl}embed/captioned/`, { headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" }, signal: AbortSignal.timeout(Math.min(10000, remaining())) });
        const result = parseEmbed(await limitedHtml(post), { platform: "instagram", kind: "post", url: sourceUrl });
        const verified = await require("./media-resolver").verifyMediaResult(result, { deadline });
        batches[index] = verified.items.map(item => ({ ...item, _sourceUrl: sourceUrl, publishedAt }));
      } catch {
        batches[index] = [{ id: node.id, type: node.is_video ? "video" : "image", url: "", thumb: node.display_url, filename: `instagram-${node.shortcode}.${node.is_video ? "mp4" : "jpg"}`, available: false, _sourceUrl: sourceUrl, publishedAt }];
      }
    }
  }));
  return { platform: "instagram", provider: "instagram-profile-embed", resourceKind: "profile", collection: true, partial: true, title: `${context.full_name || context.username} (@${context.username})`, author: context.username, warnings: ["Instagram hanya membuka beberapa postingan terbaru melalui embed publik. Untuk postingan lain, tempel tautannya langsung."], pagination: { offset, limit, hasMore: offset + selected.length < nodes.length, order: "newest", scope: "public-embed" }, items: batches.flat() };
}

module.exports = { shortcodeOf, limitedHtml, parseEmbed, parseVx, requestInstagramEmbed, requestVxInstagram, parseProfileEmbed, requestProfileEmbed };
