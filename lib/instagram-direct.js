"use strict";

const { safeName, collectTags } = require("./core");

const PROFILE_INFO_URL = "https://www.instagram.com/api/v1/users/web_profile_info/";
const PROFILE_GRAPHQL_URL = "https://www.instagram.com/api/graphql";
const PROFILE_GRAPHQL_DOC_ID = "27628439516809898";
const PROVIDER_TIMEOUT_MS = 15000;
const PROFILE_LIMIT = 24;
const PROFILE_PAGE_SIZE = 6;
const PROFILE_DEADLINE_MS = 39000;
const PROFILE_MAX_REQUESTS = 36;
const OLDEST_SEEK_STEPS = 6;
const OLDEST_WINDOW_ATTEMPTS = 10;
const INSTAGRAM_MEDIA_EPOCH_MS = 1314220021721;
const DAY_MS = 86_400_000;
const GRAPHQL_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

function headers() {
  return {
    Accept: "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
    "X-IG-App-ID": "936619743392459"
  };
}

function area(item) {
  return (Number(item?.width) || 0) * (Number(item?.height) || 0);
}

function pickBest(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return list.reduce((a, b) => (area(b) > area(a) ? b : a));
}

function pickImage(item) {
  return pickBest(item?.image_versions2?.candidates);
}

function pickVideo(item) {
  return pickBest(item?.video_versions);
}

function publishedAt(item, inherited) {
  const timestamp = Number(item?.taken_at || inherited?.taken_at);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return undefined;
  const date = new Date(timestamp * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function webNodeToMedia(node, inherited = null) {
  if (!node || typeof node !== "object") return [];
  const parent = { taken_at_timestamp: node.taken_at_timestamp || inherited?.taken_at_timestamp, caption: node.edge_media_to_caption || inherited?.caption };
  const children = node?.edge_sidecar_to_children?.edges;
  if (Array.isArray(children) && children.length) return children.flatMap(edge => webNodeToMedia(edge?.node, parent));
  const title = node?.edge_media_to_caption?.edges?.[0]?.node?.text || inherited?.caption?.edges?.[0]?.node?.text || node.shortcode || "instagram-media";
  const publishedAt = Number(node.taken_at_timestamp || inherited?.taken_at_timestamp);
  const date = Number.isFinite(publishedAt) && publishedAt > 0 ? new Date(publishedAt * 1000).toISOString() : undefined;
  const width = Number(node?.dimensions?.width) || undefined;
  const height = Number(node?.dimensions?.height) || undefined;
  const sourceUrl = node.shortcode ? `https://www.instagram.com/p/${encodeURIComponent(node.shortcode)}/` : undefined;
  if ((node.is_video || node.__typename === "GraphVideo") && node.video_url) {
    return [{ id: node.id || node.shortcode, type: "video", url: node.video_url, thumb: node.display_url || null, filename: `${safeName(title)}.mp4`, mime: "video/mp4", quality: width && height ? `${width}×${height}` : "Kualitas tertinggi tersedia", hasAudio: true, width, height, publishedAt: date, sourceUrl }];
  }
  if (node.display_url) {
    return [{ id: node.id || node.shortcode, type: "image", url: node.display_url, thumb: node.thumbnail_src || node.display_url, filename: `${safeName(title)}.jpg`, mime: "image/jpeg", quality: width && height ? `${width}×${height}` : "Kualitas tertinggi tersedia", width, height, publishedAt: date, sourceUrl }];
  }
  return [];
}

function itemToMedia(item, inherited = null) {
  const out = [];
  if (!item || typeof item !== "object") return out;
  const type = Number(item.media_type);
  if (type === 8) {
    const parent = { taken_at: item.taken_at || inherited?.taken_at, caption: item.caption || inherited?.caption };
    for (const child of (Array.isArray(item.carousel_media) ? item.carousel_media : [])) out.push(...itemToMedia(child, parent));
    return out;
  }
  const img = pickImage(item);
  const vid = pickVideo(item);
  const title = item.caption?.text || inherited?.caption?.text || item.code || "instagram-media";
  const mediaPublishedAt = publishedAt(item, inherited);
  if (type === 2 && vid) {
    out.push({
      id: item.pk || item.id || undefined,
      type: "video",
      url: vid.url,
      thumb: (img && img.url) || null,
      filename: `${safeName(title)}.mp4`,
      mime: "video/mp4",
      quality: `${vid.width || ""}${vid.width && vid.height ? "×" : ""}${vid.height || ""}`.trim() || "Kualitas tertinggi tersedia",
      hasAudio: true,
      codec: "h264",
      width: vid.width || undefined,
      height: vid.height || undefined,
      publishedAt: mediaPublishedAt
    });
    return out;
  }
  if (img && img.url) {
    out.push({
      id: item.pk || item.id || undefined,
      type: "image",
      url: img.url,
      thumb: img.url,
      filename: `${safeName(title)}.jpg`,
      mime: "image/jpeg",
      quality: `${img.width || ""}${img.width && img.height ? "×" : ""}${img.height || ""}`.trim() || "Kualitas tertinggi tersedia",
      width: img.width || undefined,
      height: img.height || undefined,
      publishedAt: mediaPublishedAt
    });
  }
  return out;
}

function responseCookies(response) {
  const values = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  return values.map(value => String(value).split(";", 1)[0]).filter(Boolean).join("; ");
}

function csrfFromCookies(cookies) {
  return String(cookies || "").match(/(?:^|;\s*)csrftoken=([^;]+)/)?.[1] || "";
}

function lsdFromHtml(html) {
  return String(html || "").match(/\["LSD",\[\],\{"token":"([^"]+)"/)?.[1] || "";
}

async function createGraphqlSession() {
  const response = await fetch("https://www.instagram.com/", {
    headers: { Accept: "text/html", "Accept-Language": "en-US,en;q=0.9", "User-Agent": GRAPHQL_USER_AGENT },
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
  });
  const html = await response.text();
  const cookies = responseCookies(response);
  const csrf = csrfFromCookies(cookies);
  const lsd = lsdFromHtml(html);
  if (!response.ok || !csrf || !lsd) throw Object.assign(new Error("Sesi publik Instagram tidak dapat dibuat."), { code: "INSTAGRAM_SESSION_FAILED" });
  return { cookies, csrf, lsd };
}

function ensureBudget(context) {
  if (context.requests >= PROFILE_MAX_REQUESTS || Date.now() >= context.deadline) {
    throw Object.assign(new Error("Batas waktu pencarian profil Instagram tercapai."), { code: "INSTAGRAM_PROFILE_TIMEOUT" });
  }
  context.requests += 1;
}

async function requestGraphqlPage(session, username, { after = null, count = PROFILE_PAGE_SIZE } = {}, context) {
  ensureBudget(context);
  const size = Math.max(1, Math.min(Math.floor(Number(count) || 1), PROFILE_PAGE_SIZE));
  const variables = {
    after,
    before: null,
    data: { count: size, include_relationship_info: true, latest_besties_reel_media: true, latest_reel_media: true },
    first: size,
    last: null,
    username,
    __relay_internal__pv__PolarisMultiCaptionCarouselEnabledrelayprovider: false,
    __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
    __relay_internal__pv__PolarisReelsRecoDebugOverlayEnabledrelayprovider: false
  };
  const body = new URLSearchParams({
    av: "0", __d: "www", __user: "0", __a: "1", __req: "1", __comet_req: "7",
    lsd: session.lsd,
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: "PolarisProfilePostsQuery",
    server_timestamps: "true",
    variables: JSON.stringify(variables),
    doc_id: String(process.env.INSTAGRAM_PROFILE_DOC_ID || PROFILE_GRAPHQL_DOC_ID)
  });
  const remaining = Math.max(1000, context.deadline - Date.now());
  const response = await fetch(PROFILE_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": GRAPHQL_USER_AGENT,
      "X-IG-App-ID": "936619743392459",
      "X-ASBD-ID": "359341",
      "X-IG-WWW-Claim": "0",
      "X-FB-Friendly-Name": "PolarisProfilePostsQuery",
      "X-FB-LSD": session.lsd,
      "X-CSRFToken": session.csrf,
      "X-Requested-With": "XMLHttpRequest",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      Origin: "https://www.instagram.com",
      Referer: `https://www.instagram.com/${encodeURIComponent(username)}/`,
      Cookie: session.cookies
    },
    body,
    signal: AbortSignal.timeout(Math.min(PROVIDER_TIMEOUT_MS, remaining))
  });
  const payload = await response.json().catch(() => null);
  const connection = payload?.data?.xdt_api__v1__feed__user_timeline_graphql_connection;
  if (!response.ok || !connection || !Array.isArray(connection.edges)) {
    throw Object.assign(new Error("Daftar media profil Instagram tidak dapat dibaca."), { code: "INSTAGRAM_GRAPHQL_FAILED" });
  }
  return {
    entries: connection.edges.map(edge => edge?.node).filter(Boolean),
    pageInfo: connection.page_info || {}
  };
}

function ownerIdFromPage(page) {
  const direct = page.entries.find(entry => /^\d+$/.test(String(entry?.owner_id || entry?.user?.pk || "")));
  if (direct) return String(direct.owner_id || direct.user.pk);
  return String(page.pageInfo?.end_cursor || "").match(/_(\d+)$/)?.[1] || "";
}

function cursorAtTimestamp(timestampMs, ownerId) {
  const value = Math.max(INSTAGRAM_MEDIA_EPOCH_MS, Math.floor(Number(timestampMs) || 0));
  const delta = BigInt(value) - BigInt(INSTAGRAM_MEDIA_EPOCH_MS);
  const mediaId = (delta << 23n) + ((1n << 23n) - 1n);
  return `${mediaId}_${ownerId}`;
}

function profileEntriesToMedia(entries, order = "newest") {
  const dedupedEntries = new Map();
  for (const entry of entries || []) {
    const key = String(entry?.pk || entry?.id || entry?.code || "");
    if (key && !dedupedEntries.has(key)) dedupedEntries.set(key, entry);
  }
  const sorted = [...dedupedEntries.values()].sort((a, b) => order === "oldest"
    ? (Number(a.taken_at) || 0) - (Number(b.taken_at) || 0)
    : (Number(b.taken_at) || 0) - (Number(a.taken_at) || 0));
  const media = sorted.flatMap(entry => itemToMedia(entry));
  const seen = new Set();
  return media.filter(item => {
    const key = String(item.id || item.url || "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hasNextPage(pageInfo) {
  const cursor = String(pageInfo?.end_cursor || "");
  return Boolean(pageInfo?.has_next_page && cursor && cursor !== "None");
}

async function collectNewest(session, username, target, context) {
  const entries = [];
  const seen = new Set();
  const cursors = new Set();
  let after = null;
  let more = false;
  while (entries.length < target) {
    const page = await requestGraphqlPage(session, username, { after, count: Math.min(PROFILE_PAGE_SIZE, target - entries.length) }, context);
    for (const entry of page.entries) {
      const key = String(entry?.pk || entry?.id || entry?.code || "");
      if (key && !seen.has(key)) { seen.add(key); entries.push(entry); }
    }
    more = hasNextPage(page.pageInfo);
    const next = String(page.pageInfo?.end_cursor || "");
    if (!more || !page.entries.length || cursors.has(next)) break;
    cursors.add(next);
    after = next;
  }
  return { entries, hasMore: more };
}

async function collectBefore(session, username, timestampMs, ownerId, target, context) {
  const entries = [];
  const seen = new Set();
  const cursors = new Set();
  let after = cursorAtTimestamp(timestampMs, ownerId);
  while (true) {
    const page = await requestGraphqlPage(session, username, { after, count: Math.min(PROFILE_PAGE_SIZE, Math.max(1, target - entries.length)) }, context);
    for (const entry of page.entries) {
      const key = String(entry?.pk || entry?.id || entry?.code || "");
      if (key && !seen.has(key)) { seen.add(key); entries.push(entry); }
    }
    const more = hasNextPage(page.pageInfo);
    const next = String(page.pageInfo?.end_cursor || "");
    if (!more || !page.entries.length || cursors.has(next)) return { entries, reachedOldest: true };
    if (entries.length >= target) return { entries, reachedOldest: false };
    cursors.add(next);
    after = next;
  }
}

async function collectOldest(session, username, target, context) {
  const initial = await requestGraphqlPage(session, username, { count: 1 }, context);
  if (!initial.entries.length) throw new Error("Tidak ada media original pada profil ini.");
  const ownerId = ownerIdFromPage(initial);
  if (!ownerId) throw Object.assign(new Error("Identitas profil Instagram tidak ditemukan."), { code: "INSTAGRAM_PROFILE_ID_MISSING" });
  const newestTimestamp = Math.max(...initial.entries.map(entry => Number(entry.taken_at) || 0));

  let lower = INSTAGRAM_MEDIA_EPOCH_MS;
  let upper = Date.now();
  for (let step = 0; step < OLDEST_SEEK_STEPS; step += 1) {
    const midpoint = Math.floor((lower + upper) / 2);
    const page = await requestGraphqlPage(session, username, { after: cursorAtTimestamp(midpoint, ownerId), count: 1 }, context);
    if (page.entries.length) upper = midpoint;
    else lower = midpoint;
  }

  const base = upper;
  let lowerWindow = 0;
  let upperWindow = null;
  let windowMs = 30 * DAY_MS;
  for (let attempt = 0; attempt < OLDEST_WINDOW_ATTEMPTS; attempt += 1) {
    const targetTime = Math.min(base + windowMs, Date.now());
    const collected = await collectBefore(session, username, targetTime, ownerId, target, context);
    if (collected.reachedOldest && (collected.entries.length >= target || targetTime >= Date.now())) {
      return { entries: collected.entries, targetTime, newestTimestamp };
    }
    if (collected.reachedOldest) {
      lowerWindow = windowMs;
      if (upperWindow !== null) windowMs = Math.floor((lowerWindow + upperWindow) / 2);
      else {
        const ratio = target / Math.max(collected.entries.length, 1);
        windowMs = Math.floor(windowMs * Math.min(4, Math.max(1.5, ratio * 1.15)));
      }
    } else {
      upperWindow = windowMs;
      windowMs = Math.floor((lowerWindow + upperWindow) / 2);
    }
  }
  throw Object.assign(new Error("Media paling lama tidak dapat ditemukan dalam batas waktu."), { code: "INSTAGRAM_OLDEST_SEEK_FAILED" });
}

async function getUserId(username) {
  const endpoint = new URL(PROFILE_INFO_URL);
  endpoint.searchParams.set("username", username);
  const response = await fetch(endpoint, { headers: headers(), signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  const payload = await response.json().catch(() => null);
  const user = payload?.data?.user;
  if (!response.ok || !user) throw new Error("Profil Instagram tidak ditemukan.");
  return user;
}

async function requestWebProfile(username, options = {}) {
  const limit = Math.max(1, Math.min(Math.floor(Number(options.limit) || PROFILE_LIMIT), PROFILE_LIMIT));
  const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
  const order = options.order === "oldest" ? "oldest" : "newest";
  if (order !== "newest") throw Object.assign(new Error("Urutan terlama Instagram memerlukan sumber GraphQL yang sedang tidak tersedia."), { code: "INSTAGRAM_WEB_PROFILE_NEWEST_ONLY" });
  const user = await getUserId(username);
  const edges = Array.isArray(user?.edge_owner_to_timeline_media?.edges) ? user.edge_owner_to_timeline_media.edges : [];
  const items = edges.flatMap(edge => webNodeToMedia(edge?.node)).slice(offset, offset + limit);
  if (!items.length) throw Object.assign(new Error("Tidak ada media publik yang tersedia pada profil Instagram ini."), { code: "INSTAGRAM_WEB_PROFILE_EMPTY" });
  return {
    platform: "instagram", provider: "instagram-web-profile", resourceKind: "profile", collection: true,
    partial: Boolean(user?.edge_owner_to_timeline_media?.page_info?.has_next_page),
    title: user.full_name ? `${user.full_name} (@${user.username || username})` : `Koleksi media @${user.username || username}`,
    description: user.biography || "", author: user.username || username, username: user.username || username,
    tags: collectTags(user.biography || ""), warnings: ["Menampilkan media terbaru yang tersedia dari profil publik Instagram."],
    pagination: { offset, limit, hasMore: false, order }, items
  };
}

async function requestProfile(username, options = {}) {
  const limit = Math.max(1, Math.min(Math.floor(Number(options.limit) || PROFILE_LIMIT), 100));
  const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
  const order = options.order === "oldest" ? "oldest" : "newest";
  const context = { deadline: Date.now() + PROFILE_DEADLINE_MS, requests: 0 };
  let session;
  try {
    session = await createGraphqlSession();
  } catch (error) {
    if (order === "newest") return requestWebProfile(username, { limit, offset, order });
    throw error;
  }
  let entries;
  let hasMore;
  if (order === "oldest") {
    const oldest = await collectOldest(session, username, offset + limit, context);
    entries = oldest.entries;
    const allMedia = profileEntriesToMedia(entries, order);
    const items = allMedia.slice(offset, offset + limit);
    hasMore = allMedia.length > offset + limit || oldest.newestTimestamp * 1000 > oldest.targetTime;
    if (!items.length) throw new Error("Tidak ada media original pada profil ini.");
    return {
      platform: "instagram", provider: "instagram-graphql", resourceKind: "profile", collection: true,
      partial: hasMore, title: `Koleksi media @${username}`, author: username, username,
      pagination: { offset, limit, hasMore, order }, items
    };
  }

  try {
    const newest = await collectNewest(session, username, offset + limit + 3, context);
    entries = newest.entries;
    const allMedia = profileEntriesToMedia(entries, order);
    const items = allMedia.slice(offset, offset + limit);
    hasMore = allMedia.length > offset + limit || newest.hasMore;
    if (!items.length) throw new Error("Tidak ada media original pada profil ini.");
    return {
      platform: "instagram", provider: "instagram-graphql", resourceKind: "profile", collection: true,
      partial: hasMore, title: `Koleksi media @${username}`, author: username, username,
      tags: collectTags(""), pagination: { offset, limit, hasMore, order }, items
    };
  } catch (error) {
    if (order === "newest") return requestWebProfile(username, { limit, offset, order });
    throw error;
  }
}

module.exports = {
  headers, itemToMedia, webNodeToMedia, pickImage, pickVideo, getUserId, requestWebProfile, requestProfile,
  responseCookies, csrfFromCookies, lsdFromHtml, cursorAtTimestamp,
  profileEntriesToMedia, ownerIdFromPage, collectNewest, collectBefore, collectOldest,
  createGraphqlSession, requestGraphqlPage
};
