"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const getMyFb = require("../lib/facebook-getmyfb");
const extract = require("../api/extract");
const download = require("../api/download");

const classified = {
  platform: "facebook",
  kind: "post",
  url: "https://www.facebook.com/share/p/1LWkU4goL5/"
};

test("GetMyFb parser maps the public photo response", () => {
  const html = `
    <img class="results-item-image" src="https://ssscdn.io/getmyfb/p/thumb">
    <figcaption class="results-item-text">Demo &amp; photo</figcaption>
    <li class="results-list-item">
      <a href="https://ssscdn.io/getmyfb/photo-token" download="Demo-photo.jpg" class="bxmfunk-button photo-button">Download Photo</a>
    </li>`;
  const result = getMyFb.parseGetMyFbResult(html, classified, "auto");
  assert.equal(result.provider, "getmyfb");
  assert.equal(result.title, "Demo & photo");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].type, "image");
  assert.equal(result.items[0].thumb, "https://ssscdn.io/getmyfb/p/thumb");
});

test("GetMyFb parser picks the highest video quality and ignores MP3 conversion links", () => {
  const html = `
    <figcaption class="results-item-text">Demo video</figcaption>
    <li class="results-list-item">360p(SD)<a href="https://ssscdn.io/getmyfb/sd" download="demo-sd.mp4" class="sd-button">Download</a></li>
    <li class="results-list-item">720p(HD)<a href="https://ssscdn.io/getmyfb/hd" download="demo-hd.mp4" class="hd-button">Download</a></li>
    <li class="results-list-item">MP3<a href="https://ssscdn.io/getmyfb/hd" data-id="1" class="mp3 sd-button">Download</a></li>`;
  const result = getMyFb.parseGetMyFbResult(html, classified, "auto");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].url, "https://ssscdn.io/getmyfb/hd");
  assert.equal(result.items[0].height, 720);
  assert.equal(result.items[0].hasAudio, true);
});

test("GetMyFb parser rejects lookalike media hosts", () => {
  const html = '<li class="results-list-item"><a href="https://ssscdn.io.evil.test/getmyfb/x" download="x.jpg" class="photo-button">Download</a></li>';
  assert.throws(() => getMyFb.parseGetMyFbResult(html, classified, "auto"), /tidak menemukan media/);
  assert.equal(getMyFb.allowedProviderUrl("https://ssscdn.io.evil.test/getmyfb/x"), false);
  assert.equal(getMyFb.allowedProviderUrl("https://cdn.ssscdn.io/getmyfb/x"), false);
  assert.equal(getMyFb.allowedProviderUrl("https://ssscdn.io:8443/getmyfb/x"), false);
  assert.equal(getMyFb.allowedProviderUrl("https://user:sss@ssscdn.io/getmyfb/x"), false);
  assert.equal(getMyFb.allowedProviderUrl("https://ssscdn.io/not-getmyfb/x"), false);
});

test("GetMyFb request uses the scraped public process contract", async t => {
  let request;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    request = { url, options };
    return new Response('<li class="results-list-item"><a href="https://ssscdn.io/getmyfb/x" download="x.jpg" class="photo-button">Download</a></li>', { status: 200 });
  });
  const result = await getMyFb.requestGetMyFb(classified, "auto");
  assert.equal(request.url, "https://getmyfb.com/process");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["HX-Request"], "true");
  assert.equal(request.options.body.get("id"), classified.url);
  assert.equal(request.options.body.get("locale"), "en");
  assert.equal(result.items[0].type, "image");
});

test("Facebook extraction races Wavy with GetMyFb", () => {
  assert.deepEqual(extract.buildAttempts(classified, "auto").map(attempt => attempt.name), ["wavy", "getmyfb"]);
  assert.deepEqual(extract.buildAttempts(classified, "audio").map(attempt => attempt.name), ["wavy"]);
  assert.deepEqual(extract.buildAttempts(classified, "mute").map(attempt => attempt.name), ["wavy"]);
});

test("download proxy accepts GetMyFb CDN but not lookalikes", () => {
  assert.equal(download.allowedMediaUrl("https://ssscdn.io/getmyfb/token"), true);
  assert.equal(download.allowedMediaUrl("https://ssscdn.io.evil.test/getmyfb/token"), false);
  assert.equal(download.allowedMediaUrl("https://cdn.ssscdn.io/getmyfb/token"), false);
  assert.equal(download.allowedMediaUrl("https://ssscdn.io/not-getmyfb/token"), false);
  assert.equal(download.allowedMediaUrl("https://ssscdn.io:8443/getmyfb/token"), false);
  assert.equal(download.allowedMediaUrl("https://user:sss@ssscdn.io/getmyfb/token"), false);
});

test("Facebook falls back when the winning provider media is unavailable", async t => {
  const blocked = { platform: "facebook", items: [{ type: "image", url: "https://ssscdn.io/getmyfb/blocked", filename: "blocked.jpg" }] };
  const fallback = { platform: "facebook", items: [{ type: "image", url: "https://scontent.example.fbcdn.net/fallback.jpg", filename: "fallback.jpg" }] };
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => ({ status: ++calls === 1 ? 403 : 206 }));
  const picked = await extract.verifyTiktokResult(blocked, [{ result: blocked, score: 0 }, { result: fallback, score: 0 }]);
  assert.equal(picked.items[0].url, fallback.items[0].url);
});
