const fs = require("node:fs");
const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("../lib/core");
const { createRateLimiter } = require("../lib/rate-limit");
const fastdl = require("../lib/instagram-fastdl");
const download = require("../api/download");
const extract = require("../api/extract");
const profile = require("../api/profile");

function createResponse() {
  return {
    headersSent: false,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    destroy() {}
  };
}

test("production download rejects a forged same-origin Referer without a signed token", async (t) => {
  const originalEnv = process.env.NODE_ENV;
  const originalSecret = process.env.DOWNLOAD_TOKEN_SECRET;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  process.env.NODE_ENV = "production";
  delete process.env.DOWNLOAD_TOKEN_SECRET;
  globalThis.fetch = async () => { calls += 1; throw new Error("should not fetch"); };
  t.after(() => {
    process.env.NODE_ENV = originalEnv;
    if (originalSecret === undefined) delete process.env.DOWNLOAD_TOKEN_SECRET;
    else process.env.DOWNLOAD_TOKEN_SECRET = originalSecret;
    globalThis.fetch = originalFetch;
  });

  const response = createResponse();
  await download({
    method: "GET",
    headers: { host: "app.example", referer: "https://app.example/forged" },
    query: { url: "https://video.twimg.com/private.mp4", filename: "private.mp4" },
    socket: { remoteAddress: "198.51.100.4" }
  }, response);

  assert.equal(response.statusCode, 401);
  assert.equal(calls, 0);
});

test("rate limiter ignores spoofed CF-Connecting-IP without a trusted Cloudflare marker", async () => {
  const limiter = createRateLimiter({ max: 1, windowMs: 60_000 });
  const first = await limiter.check({
    headers: { "cf-connecting-ip": "203.0.113.1" },
    socket: { remoteAddress: "198.51.100.10" }
  });
  const second = await limiter.check({
    headers: { "cf-connecting-ip": "203.0.113.2" },
    socket: { remoteAddress: "198.51.100.10" }
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.ip, "198.51.100.10");
});

test("rate limiter accepts CF-Connecting-IP only behind a Cloudflare marker", () => {
  const limiter = createRateLimiter({ max: 2 });
  const ip = limiter.clientIp({
    headers: { "cf-ray": "abc-SIN", "cf-connecting-ip": "203.0.113.9" },
    socket: { remoteAddress: "198.51.100.10" }
  });
  assert.equal(ip, "203.0.113.9");
});

test("mute validation rejects a provider video that still has audio", () => {
  assert.throws(() => core.validateResult({
    platform: "x",
    items: [{ type: "video", url: "https://video.twimg.com/demo.mp4", filename: "demo.mp4", hasAudio: true }]
  }, { mode: "mute" }), /Tidak ada media kompatibel/);
});

test("probe rejects unallowlisted provider URLs before issuing a server-side request", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return { status: 200 }; };
  t.after(() => { globalThis.fetch = originalFetch; });
  assert.equal(await extract.probeDownloadable("https://unlisted.example/media.mp4"), false);
  assert.equal(calls, 0);
});

test("provider race prefers the highest resolution when no quality-bias priority exists", async () => {
  const result = await extract.raceProviders([
    { name: "wavy", run: async () => ({ platform: "x", items: [{ type: "video", url: "https://video.twimg.com/low.mp4", filename: "low.mp4", height: 720, hasAudio: true }] }) },
    { name: "yt-dlp", run: async () => ({ platform: "x", items: [{ type: "video", url: "https://video.twimg.com/high.mp4", filename: "high.mp4", height: 2160, hasAudio: true }] }) }
  ], "auto", { graceMs: 10 });
  assert.equal(result.provider, "yt-dlp");
  assert.equal(result.result.items[0].height, 2160);
});

test("profile finalization marks an unallowlisted HTTPS URL unavailable", () => {
  const result = profile.finalizeProfileResult({
    platform: "tiktok", resourceKind: "profile", title: "Demo", author: "demo", partial: false,
    items: [{ id: "1", type: "video", url: "https://unlisted.example/video.mp4", filename: "video.mp4", _sourceUrl: "https://www.tiktok.com/@demo/video/1" }]
  }, { offset: 0, limit: 24 });
  assert.equal(result.items[0].available, false);
  assert.equal(result.items[0].fallbackUrl, "https://www.tiktok.com/@demo/video/1");
});

test("extract profile normalizer does not apply pagination offset twice", () => {
  const entries = Array.from({ length: 2 }, (_, index) => ({
    id: String(index + 25), title: `item-${index + 25}`,
    formats: [{ url: `https://video.twimg.com/${index + 25}.mp4`, ext: "mp4", width: 720, height: 1280, vcodec: "h264", acodec: "mp4a" }]
  }));
  const result = extract.normalizeYtdlp({ entries }, { platform: "x", kind: "profile", handle: "demo" }, "auto", { limit: 24, offset: 24 });
  assert.equal(result.items.length, 2);
});

test("FastDL remains disabled until an operator configures an API key or signing secret", () => {
  const oldKey = process.env.FASTDL_API_KEY;
  const oldSecret = process.env.FASTDL_WEB_SIGNATURE_SECRET;
  const oldTimestamp = process.env.FASTDL_WEB_SIGNATURE_TIMESTAMP;
  try {
    delete process.env.FASTDL_API_KEY;
    delete process.env.FASTDL_WEB_SIGNATURE_SECRET;
    delete process.env.FASTDL_WEB_SIGNATURE_TIMESTAMP;
    assert.equal(fastdl.isEnabled(), false);
    process.env.FASTDL_WEB_SIGNATURE_SECRET = "a".repeat(64);
    process.env.FASTDL_WEB_SIGNATURE_TIMESTAMP = "1785411663296";
    assert.equal(fastdl.isEnabled(), true);
  } finally {
    if (oldKey === undefined) delete process.env.FASTDL_API_KEY; else process.env.FASTDL_API_KEY = oldKey;
    if (oldSecret === undefined) delete process.env.FASTDL_WEB_SIGNATURE_SECRET; else process.env.FASTDL_WEB_SIGNATURE_SECRET = oldSecret;
    if (oldTimestamp === undefined) delete process.env.FASTDL_WEB_SIGNATURE_TIMESTAMP; else process.env.FASTDL_WEB_SIGNATURE_TIMESTAMP = oldTimestamp;
  }
});

test("profile renderer recognizes a one-item profile as a collection", () => {
  const source = fs.readFileSync(require.resolve("../public/app.js"), "utf8");
  assert.match(source, /const isCollection = isProfileCollection \|\| Boolean\(data\.collection\) \|\| data\.items\.length > 2;/);
});
