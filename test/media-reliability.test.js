"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const embed = require("../lib/instagram-embed");
const resolver = require("../lib/media-resolver");
const core = require("../lib/core");
const extract = require("../api/extract");
const classified = core.classifyUrl("https://www.instagram.com/reel/Chunk8-jurw/");
const video = { id: "123", shortcode: "Chunk8-jurw", is_video: true, video_url: "https://cdninstagram.com/video.mp4", display_url: "https://cdninstagram.com/poster.jpg", dimensions: { width: 1080, height: 1920 }, owner: { username: "instagram" } };
const html = context => `<script>handle({"contextJSON":${JSON.stringify(JSON.stringify(context))}})</script>`;
const response = (status = 206, type = "video/mp4") => new Response("media", { status, headers: { "content-type": type } });

test("Instagram embed decodes nested JSON and preserves mixed carousel originals", () => {
  const result = embed.parseEmbed(html({ gql_data: { shortcode_media: { ...video, edge_sidecar_to_children: { edges: [{ node: video }, { node: { id: "124", is_video: false, display_url: "https://cdninstagram.com/small.jpg", display_resources: [{ src: "https://cdninstagram.com/original.jpg", config_width: 1440, config_height: 1440 }] } }] } } } }), classified);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].url, video.video_url);
  assert.equal(result.items[1].url, "https://cdninstagram.com/original.jpg");
  assert.equal(result.items[0].height, 1920);
});

test("Instagram rejects private, blocked, missing and poster-only video embeds", () => {
  for (const context of [{}, { gql_data: { shortcode_media: { ...video, owner: { is_private: true } } } }, { context: { copyright_blocked: true }, gql_data: { shortcode_media: video } }, { gql_data: { shortcode_media: { ...video, video_url: undefined } } }]) assert.throws(() => embed.parseEmbed(html(context), classified));
  assert.throws(() => embed.parseEmbed(html({ gql_data: { shortcode_media: video } }), classified, "image"));
  assert.deepEqual(require("../lib/instagram-direct").webNodeToMedia({ ...video, video_url: undefined }), []);
});

test("VX offload media is accepted only on explicit paths and hosts", () => {
  const result = embed.parseVx('<meta content="https://www.vxinstagram.com/offload/Chunk8-jurw/0.mp4" property="og:video"><meta property="og:image" content="https://cdninstagram.com/poster.jpg">', classified);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].type, "video");
  for (const url of ["https://www.vxinstagram.com/arbitrary", "https://www.vxinstagram.com.evil.test/offload/Chunk8-jurw/0.mp4", "https://evil.rapidcdn.app/file.mp4", "http://d.rapidcdn.app/file.mp4"]) assert.equal(core.allowedMediaUrl(url), false);
  assert.equal(core.allowedMediaUrl("https://d.rapidcdn.app/file.mp4"), true);
});

test("Oversized upstream HTML is cancelled", async () => {
  const res = new Response("body", { headers: { "content-length": "3000000" } });
  await assert.rejects(embed.limitedHtml(res), /terlalu besar/);
  assert.equal(res.bodyUsed, true);
});

test("Unavailable HD falls back to regular video and does not retain false resolution", async t => {
  t.mock.method(globalThis, "fetch", async url => response(url.includes("hd.mp4") ? 403 : 206));
  const result = await resolver.resolveMediaItem({ url: "https://tikwm.com/hd.mp4", fallbackUrls: ["https://tikwm.com/regular.mp4"], height: 1080, bestQuality: true });
  assert.equal(result.url, "https://tikwm.com/regular.mp4");
  assert.equal(result.height, undefined);
  assert.equal(result.bestQuality, false);
});

test("Verification rejects HTML/empty responses and keeps downloadable carousel items", async t => {
  t.mock.method(globalThis, "fetch", async url => url.includes("bad") ? response(200, "text/html") : response());
  const result = await resolver.verifyMediaResult({ items: [{ url: "https://cdninstagram.com/good.mp4" }, { url: "https://cdninstagram.com/bad.mp4" }] });
  assert.equal(result.items.length, 1);
  assert.equal(result.partial, true);
  await assert.rejects(resolver.verifyMediaResult({ items: [{ url: "https://cdninstagram.com/bad.mp4" }] }), { code: "MEDIA_UNAVAILABLE" });
  t.mock.method(globalThis, "fetch", async () => new Response(null, { headers: { "content-type": "video/mp4", "content-length": "0" } }));
  assert.equal(await resolver.probeDownloadable("https://tikwm.com/empty.mp4"), false);
});

test("Provider race cannot select high resolution metadata pointing to a broken file", async t => {
  t.mock.method(globalThis, "fetch", async url => response(url.includes("broken") ? 403 : 206));
  const media = (url, height) => ({ platform: "tiktok", items: [{ type: "video", filename: "media.mp4", url, height }] });
  const result = await extract.raceProviders([{ name: "broken", priority: 10, run: async () => media("https://tikwm.com/broken.mp4", 1080) }, { name: "working", run: async () => media("https://tikwm.com/working.mp4", 720) }], "auto", { verify: resolver.verifyMediaResult, graceMs: 1 });
  assert.equal(result.provider, "working");
});

test("Tikwm GET supports short URLs and relative HD/regular links", async t => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(options.method, undefined);
    assert.equal(new URL(url).searchParams.get("url"), "https://vt.tiktok.com/demo/");
    return Response.json({ code: 0, data: { hdplay: "/video/hd.mp4", play: "/video/sd.mp4" } });
  });
  const result = await extract.requestTikwm({ platform: "tiktok", kind: "post", url: "https://vt.tiktok.com/demo/" }, "auto");
  assert.equal(result.items[0].url, "https://www.tikwm.com/video/hd.mp4");
  assert.deepEqual(result.items[0].fallbackUrls, ["https://www.tikwm.com/video/sd.mp4"]);
});

test("Signed fallback URLs survive roundtrip but tampering is rejected", t => {
  const old = process.env.DOWNLOAD_TOKEN_SECRET;
  process.env.DOWNLOAD_TOKEN_SECRET = "test-only-download-secret";
  t.after(() => old === undefined ? delete process.env.DOWNLOAD_TOKEN_SECRET : process.env.DOWNLOAD_TOKEN_SECRET = old);
  const token = core.signDownloadToken({ url: video.video_url, filename: "video.mp4", fallbackUrls: ["https://tikwm.com/sd.mp4", "https://evil.test/file"] });
  assert.deepEqual(core.verifyDownloadToken(token).fallbackUrls, ["https://tikwm.com/sd.mp4"]);
  assert.equal(core.verifyDownloadToken(token + "x"), null);
});

test("Public profile fallback resolves videos from posts and reports its recent-only scope", async t => {
  const profile = { type: "Profile", username: "instagram", full_name: "Instagram", graphql_media: [{ shortcode_media: video }] };
  t.mock.method(globalThis, "fetch", async url => {
    if (String(url).endsWith("/instagram/embed/")) return new Response(html({ context: profile }));
    if (String(url).includes("/embed/captioned/")) return new Response(html({ gql_data: { shortcode_media: video } }));
    return response();
  });
  const result = await embed.requestProfileEmbed(core.classifyUrl("https://www.instagram.com/instagram/"));
  assert.equal(result.items[0].type, "video");
  assert.equal(result.items[0].url, video.video_url);
  assert.equal(result.pagination.scope, "public-embed");
  assert.equal(result.partial, true);
  assert.equal(result.pagination.hasMore, false);
  assert.throws(() => embed.parseProfileEmbed(html({ context: profile }), "someoneelse"));
});
