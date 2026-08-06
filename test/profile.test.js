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
      { title: "v1", thumbnail: "https://img/t1.jpg", formats: [{ url: "https://v1.mp4", vcodec: "h264", acodec: "aac", height: 1080, width: 1920, ext: "mp4" }] },
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
  assert.equal(result.pagination.offset, 0);
  assert.equal(result.pagination.limit, 10);
  assert.equal(result.pagination.hasMore, false);
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

test("normalizeYtdlp skips entries without a usable video format", () => {
  const data = {
    title: "demo",
    entries: [
      { title: "bad", formats: [] },
      { title: "good", formats: [{ url: "https://v.mp4", vcodec: "h264", acodec: "aac", ext: "mp4" }] }
    ]
  };
  const classified = { platform: "tiktok", kind: "profile", handle: "demo", url: "https://www.tiktok.com/@demo/" };
  const result = profile.normalizeYtdlp(data, classified, 10, 0);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].filename.includes("good"), true);
});
