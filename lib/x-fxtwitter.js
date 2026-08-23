"use strict";
// X (Twitter) fallback provider via fxtwitter public API (stabil, tanpa login).
const { safeName } = require("./core");

const PROVIDER_TIMEOUT_MS = 15000;
const FXTWITTER_API = "https://api.fxtwitter.com";

function tweetIdOf(url) {
  const match = String(url || "").match(/\/status(?:es)?\/(\d+)/);
  return match ? match[1] : "";
}

async function requestXTwitter(classified, mode = "auto") {
  if (classified.platform !== "x") throw new Error("Bukan URL X/Twitter.");
  if (classified.kind === "profile") throw new Error("fxtwitter tidak mendukung profil.");
  const id = tweetIdOf(classified.url);
  if (!id) throw new Error("Tweet ID tidak ditemukan.");
  const handlePart = classified.handle ? `/${classified.handle}` : "";
  const endpoint = `${FXTWITTER_API}${handlePart}/status/${id}`;
  const response = await fetch(endpoint, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 Chrome/127" }, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  const payload = await response.json().catch(() => null);
  const tweet = payload?.tweet;
  if (!response.ok || !tweet || payload.code !== 200) {
    throw Object.assign(new Error(payload?.message || `fxtwitter gagal (${response.status}).`), { code: response.status === 404 ? "TWEET_NOT_FOUND" : "PROVIDER_FAILED" });
  }
  const media = tweet.media || {};
  const allVideos = Array.isArray(media.all) ? media.all : [];
  const videos = Array.isArray(media.videos) ? media.videos : [];
  const photos = Array.isArray(media.photos) ? media.photos : [];
  const items = [];
  for (const video of videos) {
    const url = video.url;
    if (!url) continue;
    items.push({
      type: "video", url,
      thumb: video.thumbnail_url || null,
      filename: `${safeName(`x-${id}`)}.mp4`,
      quality: `${video.width}×${video.height}`,
      width: Number(video.width) || undefined,
      height: Number(video.height) || undefined,
      hasAudio: true
    });
  }
  for (const photo of photos) {
    if (!photo.url) continue;
    items.push({ type: "image", url: photo.url, thumb: photo.url, filename: `${safeName(`x-${id}`)}.jpg`, quality: "Original", width: Number(photo.width) || undefined, height: Number(photo.height) || undefined });
  }
  let filtered = mode === "image" ? items.filter(i => i.type === "image")
    : mode === "audio" ? []
    : mode === "mute" ? items.filter(i => i.type === "video" && i.hasAudio === false)
    : items.filter(i => i.type === "video" || i.type === "image");
  // X posts: skip videos without audio in auto mode unless it's the only item
  if (mode === "auto") {
    const audible = filtered.filter(i => i.type !== "video" || i.hasAudio !== false);
    if (audible.length) filtered = audible;
  }
  if (!filtered.length && allVideos.length && ["auto"].includes(mode)) filtered = items;
  if (!filtered.length) throw new Error("fxtwitter tidak menemukan media kompatibel.");
  return {
    platform: "x",
    provider: "fxtwitter",
    resourceKind: classified.kind || "post",
    title: String(tweet.text || `Post ${id}`).split("\n")[0],
    description: tweet.text || "",
    author: tweet.author?.screen_name || classified.handle || "",
    tags: [],
    items: filtered
  };
}

module.exports = { requestXTwitter, tweetIdOf };
