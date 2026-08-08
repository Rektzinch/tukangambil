"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fastdl = require("../lib/instagram-fastdl");

function cfg(over = {}) {
  return { apiUrl: "https://api-wh.fastdl.app", apiKey: "k", keyHeader: "x-api-key", mediaUrl: "https://media.fastdl.app", ...over };
}

test("unwrap extracts axios-style payload", () => {
  assert.deepEqual(fastdl.unwrap({ data: { success: true, data: { username: "x" } } }), { username: "x" });
});

test("downloadableUrl reuses already-signed URL", () => {
  const url = "https://media.fastdl.app/get?uri=x&__sig=abc";
  assert.equal(fastdl.downloadableUrl(url, null, cfg()), url);
});

test("downloadableUrl builds signed proxy URL for efg media", () => {
  const out = fastdl.downloadableUrl("https://ig.com/v.mp4?efg=1&x=2", { expires: 1000, signature: "s3cret" }, cfg());
  assert.match(out, /^https:\/\/media\.fastdl\.app\/get\?uri=/);
  assert.match(out, /__sig=s3cret/);
  assert.match(out, /__expires=1000/);
  assert.match(out, /referer=.*instagram/);
});

test("getFilename extracts trailing media filename", () => {
  assert.equal(fastdl.getFilename("/some/path/video.mp4"), "video.mp4");
  assert.equal(fastdl.getFilename("/path/image.jpg"), "image.jpg");
  assert.equal(fastdl.getFilename("/nodot"), "");
});

test("igItemToItems maps a video item", () => {
  const item = {
    video_versions: [{ url: "https://cdninstagram.com/v.mp4", url_signature: { expires: 1, signature: "sig" } }],
    image_versions2: { candidates: [{ url: "https://cdninstagram.com/p.jpg", url_wrapped: "https://w.jpg" }] },
    meta: { shortcode: "ABC123" }
  };
  const items = fastdl.igItemToItems(item, cfg());
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "video");
  assert.equal(items[0].thumb, "https://w.jpg");
  assert.ok(items[0].filename.endsWith(".mp4"));
});

test("igItemToItems maps an image item", () => {
  const item = {
    image_versions2: { candidates: [{ url: "https://cdninstagram.com/p.jpg", url_downloadable: "https://dl.jpg" }] },
    meta: { shortcode: "IMG1" }
  };
  const items = fastdl.igItemToItems(item, cfg());
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "image");
  assert.equal(items[0].url, "https://dl.jpg");
});

test("igItemToItems expands carousel media", () => {
  const item = {
    carousel_media: [
      { image_versions2: { candidates: [{ url: "https://cdn/a.jpg", url_downloadable: "https://dl/a.jpg" }] } },
      { video_versions: [{ url: "https://cdn/b.mp4", url_downloadable: "https://dl/b.mp4" }] }
    ]
  };
  const items = fastdl.igItemToItems(item, cfg());
  assert.equal(items.length, 2);
  assert.deepEqual(items.map(i => i.type), ["image", "video"]);
});

test("convertToItems maps savefrom mp4 item", () => {
  const content = [{ url: [{ url: "https://dl/v.mp4", type: "video/mp4", ext: "mp4" }], thumb: "https://t.jpg", meta: { title: "Reel" } }];
  const items = fastdl.convertToItems(content, cfg());
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "video");
  assert.equal(items[0].url, "https://dl/v.mp4");
});

test("convertToItems maps savefrom image item", () => {
  const content = [{ url: [{ url: "https://dl/p.jpg", ext: "jpg" }], thumb: "https://t.jpg", meta: { title: "Photo" } }];
  const items = fastdl.convertToItems(content, cfg());
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "image");
});

test("convertToItems prefers a video variant over its poster frame", () => {
  const content = [{
    url: [
      { url: "https://dl/frame.jpg", type: "image/jpeg" },
      { url: "https://dl/video", type: "video/mp4" }
    ],
    thumb: "https://dl/frame.jpg",
    meta: { title: "Reel" }
  }];
  const items = fastdl.convertToItems(content, cfg());
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "video");
  assert.equal(items[0].url, "https://dl/video");
});

test("web requests are signed like the FastDL browser client", () => {
  const body = fastdl.signWebRequest({ username: "gebiann", maxId: "" }, { now: 1786064383084 });
  assert.equal(body._ts, 1785411663296);
  assert.equal(body._tsc, 0);
  assert.equal(body._sv, 2);
  assert.match(body._s, /^[0-9a-f]{64}$/);
  assert.equal(body.username, "gebiann");
});

test("isEnabled supports the public signed web client", () => {
  const orig = { k: process.env.FASTDL_API_KEY, s: process.env.FASTDL_WEB_SIGNATURE_SECRET };
  try {
    delete process.env.FASTDL_API_KEY;
    delete process.env.FASTDL_WEB_SIGNATURE_SECRET;
    assert.equal(fastdl.isEnabled(), true);
    process.env.FASTDL_API_KEY = "x";
    assert.equal(fastdl.isEnabled(), true);
  } finally {
    if (orig.k !== undefined) process.env.FASTDL_API_KEY = orig.k; else delete process.env.FASTDL_API_KEY;
    if (orig.s !== undefined) process.env.FASTDL_WEB_SIGNATURE_SECRET = orig.s; else delete process.env.FASTDL_WEB_SIGNATURE_SECRET;
  }
});
