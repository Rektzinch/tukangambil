"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const direct = require("../lib/instagram-direct");

function imageItem(width, height, url) {
  return {
    media_type: 1,
    code: "ABC123",
    image_versions2: { candidates: [
      { width: width / 2, height: height / 2, url: `small-${url}` },
      { width, height, url }
    ] }
  };
}

function videoItem() {
  return {
    media_type: 2,
    code: "VID456",
    caption: { text: "My reel" },
    image_versions2: { candidates: [{ width: 720, height: 1080, url: "thumb.jpg" }] },
    video_versions: [
      { width: 540, height: 960, url: "sm.mp4" },
      { width: 1080, height: 1920, url: "hd.mp4" }
    ]
  };
}

test("itemToMedia picks highest-res image candidate", () => {
  const item = imageItem(3072, 4096, "orig.jpg");
  const out = direct.itemToMedia(item);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "image");
  assert.equal(out[0].url, "orig.jpg");
  assert.equal(out[0].width, 3072);
  assert.equal(out[0].height, 4096);
});

test("itemToMedia picks highest-res video candidate", () => {
  const out = direct.itemToMedia(videoItem());
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "video");
  assert.equal(out[0].url, "hd.mp4");
  assert.equal(out[0].quality, "1080×1920");
  assert.equal(out[0].hasAudio, true);
});

test("itemToMedia expands carousel children", () => {
  const item = {
    media_type: 8,
    carousel_media: [imageItem(2000, 2000, "a.jpg"), videoItem()]
  };
  const out = direct.itemToMedia(item);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(i => i.type), ["image", "video"]);
});

test("itemToMedia ignores empty candidates", () => {
  const out = direct.itemToMedia({ media_type: 1, code: "X" });
  assert.equal(out.length, 0);
});

test("pickImage/pickVideo return best by area", () => {
  const img = direct.pickImage(imageItem(100, 200, "x.jpg"));
  assert.equal(img.width, 100);
  const vid = direct.pickVideo(videoItem());
  assert.equal(vid.width, 1080);
});
