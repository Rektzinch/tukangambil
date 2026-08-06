"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const wavy = require("../lib/wavy");

test("convertItem maps a wavy video item", () => {
  const item = wavy.convertItem({ type: "video", mimetype: "video/mp4", isAudio: false, extension: "mp4", url: "https://cdn.example/v.mp4" }, "Reel", "https://cdn.example/cover.jpg");
  assert.equal(item.type, "video");
  assert.equal(item.url, "https://cdn.example/v.mp4");
  assert.equal(item.hasAudio, true);
  assert.equal(item.mime, "video/mp4");
  assert.ok(item.filename.endsWith(".mp4"));
  assert.equal(item.thumb, "https://cdn.example/cover.jpg");
});

test("convertItem maps an audio item", () => {
  const item = wavy.convertItem({ type: "audio", mimetype: "audio/mp4", isAudio: true, extension: "m4a", url: "https://cdn.example/a.m4a" }, "Reel", null);
  assert.equal(item.type, "audio");
  assert.equal(item.mime, "audio/mp4");
  assert.ok(item.filename.endsWith(".m4a"));
});

test("convertItem maps an image item", () => {
  const item = wavy.convertItem({ type: "image", mimetype: "image/jpeg", extension: "jpeg", url: "https://cdn.example/i.jpg" }, "Post", "https://cdn.example/cover.jpg");
  assert.equal(item.type, "image");
  assert.ok(item.filename.endsWith(".jpg"));
});

test("convertItem keeps real quality, size and flags best", () => {
  const item = wavy.convertItem({ type: "video", quality: "hd", size: 1919094, extension: "mp4", url: "https://cdn.example/v.mp4" }, "Reel", null);
  assert.equal(item.quality, "HD");
  assert.equal(item.bestQuality, true);
  assert.equal(item.size, "1.9MB");
});

test("convertItem maps unknown quality without flagging best", () => {
  const item = wavy.convertItem({ type: "video", quality: "normal", extension: "mp4", url: "https://cdn.example/v.mp4" }, "Reel", null);
  assert.equal(item.quality, "Normal");
  assert.equal(item.bestQuality, undefined);
});

test("wavyEndpoint falls back to default", () => {
  const orig = process.env.WAVY_API_URL;
  try {
    delete process.env.WAVY_API_URL;
    assert.equal(wavy.wavyEndpoint(), "https://wavy.netraux.eu.cc/api/download");
    process.env.WAVY_API_URL = "https://x.test/api/download/";
    assert.equal(wavy.wavyEndpoint(), "https://x.test/api/download");
  } finally {
    if (orig !== undefined) process.env.WAVY_API_URL = orig; else delete process.env.WAVY_API_URL;
  }
});
