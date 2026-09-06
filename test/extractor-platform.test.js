"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { binaryAsset } = require("../scripts/extractor-platform");

test("extractor installer selects a native Linux binary", () => {
  assert.equal(binaryAsset("linux", "x64"), "yt-dlp_linux");
  assert.equal(binaryAsset("linux", "arm64"), "yt-dlp_linux_aarch64");
  assert.throws(() => binaryAsset("linux", "ia32"), /Unsupported/);
  assert.throws(() => binaryAsset("darwin", "arm64"), /Unsupported/);
});
