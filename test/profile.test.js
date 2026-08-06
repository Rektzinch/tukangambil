"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const profile = require("../api/profile");

function callHandler(method, body = {}, addr = "127.0.0.1") {
  return new Promise(resolve => {
    const req = { method, headers: { host: "localhost" }, socket: { remoteAddress: addr }, body };
    const res = {
      _headers: {},
      setHeader(key, value) { this._headers[key] = value; return this; },
      statusCode: 0,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, headers: this._headers, body: payload }); return this; }
    };
    const result = profile(req, res);
    if (result && typeof result.then === "function") result.catch(() => {});
  });
}

test("profile handler rejects non-POST", async () => {
  const r = await callHandler("GET");
  assert.equal(r.status, 405);
  assert.equal(r.body.error, "Metode tidak didukung.");
});

test("profile handler rejects non-profile URL", async () => {
  const r = await callHandler("POST", { url: "https://www.tiktok.com/@demo/video/123" });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "UNSUPPORTED_URL");
});

test("profile handler rejects unsupported URL", async () => {
  const r = await callHandler("POST", { url: "https://evil.test/a.mp4" });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "UNSUPPORTED_URL");
});

test("normalizeYtdlp maps entries to items with pagination", () => {
  const data = {
    title: "demo",
    uploader: "demo_user",
    entries: [
      { title: "v1", timestamp: 1710000000, thumbnail: "https://img/t1.jpg", formats: [{ url: "https://v1.mp4", vcodec: "h264", acodec: "aac", height: 1080, width: 1920, ext: "mp4" }] },
      { title: "v2", thumbnail: "https://img/t2.jpg", formats: [{ url: "https://v2.mp4", vcodec: "h264", acodec: "aac", height: 720, width: 1280, ext: "mp4" }] }
    ]
  };
  const classified = { platform: "tiktok", kind: "profile", handle: "demo", url: "https://www.tiktok.com/@demo/" };
  const result = profile.normalizeYtdlp(data, classified, 10, 0);
  assert.equal(result.platform, "tiktok");
  assert.equal(result.collection, true);
  assert.equal(result.author, "demo_user");
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].type, "video");
  assert.equal(result.items[0].url, "https://v1.mp4");
  assert.equal(result.items[0].hasAudio, true);
  assert.equal(result.items[0].publishedAt, "2024-03-09T16:00:00.000Z");
  assert.equal(result.pagination.offset, 0);
  assert.equal(result.pagination.limit, 10);
  assert.equal(result.pagination.hasMore, false);
  assert.equal(result.pagination.order, "newest");
});

test("normalizeYtdlp preserves oldest-first pagination order", () => {
  const data = {
    title: "demo",
    entries: [{ id: "7260000000000000000", title: "old", formats: [] }]
  };
  const classified = { platform: "tiktok", kind: "profile", handle: "demo", url: "https://www.tiktok.com/@demo/" };
  const result = profile.normalizeYtdlp(data, classified, 10, 0, "oldest");
  assert.equal(result.pagination.order, "oldest");
  assert.match(result.items[0].publishedAt, /^2023-/);
});

test("playlist item ranges cover the full profile without overlap", () => {
  assert.equal(profile.playlistItemsForOrder("oldest", 0, 24), "-1:-24:-1");
  assert.equal(profile.playlistItemsForOrder("oldest", 24, 24), "-25:-48:-1");
  assert.deepEqual(profile.playlistPageOptions("newest", 0, 24), { playlistStart: 1, playlistEnd: 24 });
  assert.deepEqual(profile.playlistPageOptions("newest", 24, 24), { playlistStart: 25, playlistEnd: 48 });
  assert.deepEqual(profile.playlistPageOptions("oldest", 0, 24), { playlistItems: "-1:-24:-1" });
});

test("derives TikTok account creation time from user ID", () => {
  assert.equal(new Date(profile.accountCreatedAtFromId("7306130619200226310")).toISOString(), "2023-11-27T13:18:14.000Z");
  assert.equal(profile.accountCreatedAtFromId("invalid"), 0);
});

test("normalizes direct TikTok pages from oldest to newest", () => {
  const classified = { platform: "tiktok", kind: "profile", handle: "demo" };
  const profileInfo = { username: "demo", nickname: "Demo", bio: "bio", mediaCount: 100 };
  const entries = [
    { id: "3", createTime: 1700000300, desc: "third" },
    { id: "1", createTime: 1700000100, desc: "first" },
    { id: "2", createTime: 1700000200, desc: "second" }
  ];
  const firstPage = profile.normalizeTikTokOldest(entries, classified, profileInfo, { limit: 2, offset: 0 });
  const secondPage = profile.normalizeTikTokOldest(entries, classified, profileInfo, { limit: 2, offset: 2 });
  assert.deepEqual(firstPage.items.map(item => item.id), ["1", "2"]);
  assert.deepEqual(secondPage.items.map(item => item.id), ["3"]);
  assert.equal(firstPage.pagination.order, "oldest");
  assert.equal(firstPage.pagination.hasMore, true);
});

test("normalizeYtdlp sets hasMore when entries fill the limit", () => {
  const data = {
    title: "demo",
    entries: Array.from({ length: 5 }, (_, i) => ({
      title: `v${i}`,
      formats: [{ url: `https://v${i}.mp4`, vcodec: "h264", acodec: "aac", ext: "mp4" }]
    }))
  };
  const classified = { platform: "tiktok", kind: "profile", handle: "demo", url: "https://www.tiktok.com/@demo/" };
  const result = profile.normalizeYtdlp(data, classified, 5, 0);
  assert.equal(result.pagination.hasMore, true);
  assert.equal(result.partial, true);
});

test("normalizeYtdlp keeps entries without formats as placeholders", () => {
  const data = {
    title: "demo",
    entries: [
      { id: "111", title: "bad", formats: [] },
      { id: "222", title: "good", formats: [{ url: "https://v.mp4", vcodec: "h264", acodec: "aac", ext: "mp4" }] }
    ]
  };
  const classified = { platform: "tiktok", kind: "profile", handle: "demo", url: "https://www.tiktok.com/@demo/" };
  const result = profile.normalizeYtdlp(data, classified, 10, 0);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0]._sourceUrl, "https://www.tiktok.com/@demo/video/111");
  assert.equal(result.items[0].url, "");
  assert.equal(result.items[1].filename.includes("good"), true);
  assert.equal(result.items[1].url, "https://v.mp4");
});

test("finalizeProfileResult keeps all items and marks unavailable ones", () => {
  const raw = {
    platform: "tiktok",
    resourceKind: "profile",
    title: "demo",
    author: "demo_user",
    partial: true,
    pagination: { offset: 0, limit: 10, hasMore: true },
    items: [
      { id: "111", type: "video", url: "https://v1.mp4", thumb: null, filename: "v1.mp4", mime: "video/mp4", hasAudio: true },
      { id: "222", type: "video", url: "", thumb: null, filename: "v2.mp4", mime: "video/mp4", hasAudio: true, _sourceUrl: "https://www.tiktok.com/@demo/video/222" }
    ]
  };
  const result = profile.finalizeProfileResult(raw, { offset: 0, limit: 10 });
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].available, true);
  assert.equal(result.items[1].available, false);
  assert.equal(result.items[1].fallbackUrl, "https://www.tiktok.com/@demo/video/222");
  assert.equal(result.provider, "profile");
  assert.equal(result.collection, true);
  assert.equal(result.pagination.hasMore, true);
});
