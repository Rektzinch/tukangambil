"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const health = require("../api/health");

test("health handler rejects non-GET methods", () => {
  let status, jsonStr;
  const req = { method: "POST" };
  const res = {
    status: (s) => {
      status = s;
      return res;
    },
    json: (j) => {
      jsonStr = j;
    }
  };

  health(req, res);

  assert.equal(status, 405);
  assert.deepEqual(jsonStr, { error: "Metode tidak didukung." });
});

test("health handler processes GET request", () => {
  let status, jsonStr;
  const headers = {};
  const req = { method: "GET" };
  const res = {
    setHeader: (name, value) => {
      headers[name] = value;
    },
    status: (s) => {
      status = s;
      return res;
    },
    json: (j) => {
      jsonStr = j;
    }
  };

  health(req, res);

  assert.equal(headers["Cache-Control"], "public, max-age=15, s-maxage=15");
  assert.ok(status === 200 || status === 503); // Depends on yt-dlp binary presence
  assert.ok(jsonStr.status === "ready" || jsonStr.status === "degraded");
  assert.ok(jsonStr.runtime);
  assert.ok(jsonStr.platforms);
});

test("health handler reflects environment variables", () => {
  const originalCobalt = process.env.COBALT_API_URL;
  const originalCookies = process.env.YTDLP_COOKIES_B64;

  try {
    process.env.COBALT_API_URL = "http://test-cobalt.com";
    process.env.YTDLP_COOKIES_B64 = "test-cookies";

    let jsonStr;
    const req = { method: "GET" };
    const res = {
      setHeader: () => {},
      status: () => res,
      json: (j) => { jsonStr = j; }
    };

    health(req, res);

    assert.equal(typeof jsonStr.runtime.ytdlp, "boolean");
    assert.equal("cobaltConfigured" in jsonStr.runtime, false);
    assert.equal("cookiesConfigured" in jsonStr.runtime, false);
    assert.equal("signedDownloads" in jsonStr.runtime, false);
  } finally {
    if (originalCobalt !== undefined) {
      process.env.COBALT_API_URL = originalCobalt;
    } else {
      delete process.env.COBALT_API_URL;
    }

    if (originalCookies !== undefined) {
      process.env.YTDLP_COOKIES_B64 = originalCookies;
    } else {
      delete process.env.YTDLP_COOKIES_B64;
    }
  }
});
