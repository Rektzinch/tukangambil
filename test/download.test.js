"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { fetchAllowed } = require("../api/download");

test("fetchAllowed - successful fetch without redirect", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    return {
      status: 200,
      url: url,
    };
  });

  const response = await fetchAllowed("https://tiktok.com/video.mp4", {});
  assert.equal(response.status, 200);
  assert.equal(response.url, "https://tiktok.com/video.mp4");
});

test("fetchAllowed - rejects invalid initial host", async (t) => {
  await assert.rejects(
    fetchAllowed("https://evil.test/video.mp4", {}),
    /Host media tidak diizinkan/
  );
});

test("fetchAllowed - handles valid redirect", async (t) => {
  let callCount = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    callCount++;
    if (callCount === 1) {
      return {
        status: 301,
        headers: { get: (name) => name.toLowerCase() === "location" ? "https://tiktokcdn.com/video.mp4" : null },
      };
    }
    return {
      status: 200,
      url: url,
    };
  });

  const response = await fetchAllowed("https://tiktok.com/video.mp4", {});
  assert.equal(response.status, 200);
  assert.equal(response.url, "https://tiktokcdn.com/video.mp4");
});

test("fetchAllowed - rejects redirect without location", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    return {
      status: 302,
      headers: { get: () => null },
    };
  });

  await assert.rejects(
    fetchAllowed("https://tiktok.com/video.mp4", {}),
    /Redirect media tidak valid/
  );
});

test("fetchAllowed - rejects redirect to invalid host", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    return {
      status: 302,
      headers: { get: (name) => name.toLowerCase() === "location" ? "https://evil.test/video.mp4" : null },
    };
  });

  await assert.rejects(
    fetchAllowed("https://tiktok.com/video.mp4", {}),
    /Host media tidak diizinkan/
  );
});

test("fetchAllowed - throws on too many redirects", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    return {
      status: 302,
      headers: { get: (name) => name.toLowerCase() === "location" ? "https://tiktok.com/redirect" : null },
    };
  });

  await assert.rejects(
    fetchAllowed("https://tiktok.com/video.mp4", {}),
    /Terlalu banyak redirect media/
  );
});

test("fetchAllowed - rejects invalid final destination URL", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    return {
      status: 200,
      url: "https://evil.test/video.mp4",
    };
  });

  await assert.rejects(
    fetchAllowed("https://tiktok.com/video.mp4", {}),
    /Tujuan akhir media tidak diizinkan/
  );
});

test("isDownloadable - rejects non-media content types despite media filename", () => {
  const { isDownloadable } = require("../api/download");
  assert.equal(isDownloadable("preview.jpg", "text/html; charset=utf-8"), false);
  assert.equal(isDownloadable("preview.mp4", "application/octet-stream"), true);
});
