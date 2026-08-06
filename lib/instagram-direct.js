"use strict";

const { safeName, collectTags } = require("./core");

const PROFILE_INFO_URL = "https://www.instagram.com/api/v1/users/web_profile_info/";
const FEED_USER_URL = "https://i.instagram.com/api/v1/feed/user/";
const PROVIDER_TIMEOUT_MS = 15000;
const PROFILE_LIMIT = 24;

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

function itemToMedia(item) {
  const out = [];
  if (!item || typeof item !== "object") return out;
  const type = Number(item.media_type);
  if (type === 8) {
    for (const child of (Array.isArray(item.carousel_media) ? item.carousel_media : [])) out.push(...itemToMedia(child));
    return out;
  }
  const img = pickImage(item);
  const vid = pickVideo(item);
  const title = item.caption?.text || item.code || "instagram-media";
  if (type === 2 && vid) {
    out.push({
      type: "video",
      url: vid.url,
      thumb: (img && img.url) || null,
      filename: `${safeName(title)}.mp4`,
      mime: "video/mp4",
      quality: `${vid.width || ""}${vid.width && vid.height ? "×" : ""}${vid.height || ""}`.trim() || "Kualitas tertinggi tersedia",
      hasAudio: true,
      codec: "h264",
      width: vid.width || undefined,
      height: vid.height || undefined
    });
    return out;
  }
  if (img && img.url) {
    out.push({
      type: "image",
      url: img.url,
      thumb: img.url,
      filename: `${safeName(title)}.jpg`,
      mime: "image/jpeg",
      quality: `${img.width || ""}${img.width && img.height ? "×" : ""}${img.height || ""}`.trim() || "Kualitas tertinggi tersedia",
      width: img.width || undefined,
      height: img.height || undefined
    });
  }
  return out;
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

async function requestProfile(username) {
  const user = await getUserId(username);
  if (user.is_private) throw new Error("Profil Instagram privat tidak bisa dibaca tanpa sesi.");
  const endpoint = new URL(FEED_USER_URL + String(user.id) + "/");
  endpoint.searchParams.set("count", String(PROFILE_LIMIT));
  const response = await fetch(endpoint, { headers: headers(), signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(payload?.items)) throw new Error("Feed profil Instagram tidak dapat dibaca.");
  const items = [];
  for (const entry of payload.items) {
    items.push(...itemToMedia(entry));
    if (items.length >= PROFILE_LIMIT) break;
  }
  if (!items.length) throw new Error("Tidak ada media original pada profil ini.");
  return {
    platform: "instagram",
    provider: "instagram-direct",
    resourceKind: "profile",
    collection: true,
    partial: items.length >= PROFILE_LIMIT,
    title: `Koleksi media @${username}`,
    description: user.biography || "",
    author: user.full_name || username,
    username,
    tags: collectTags(user.biography || ""),
    items
  };
}

module.exports = { headers, itemToMedia, pickImage, pickVideo, getUserId, requestProfile };
