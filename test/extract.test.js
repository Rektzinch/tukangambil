"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const extract = require("../api/extract");

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
    const result = extract(req, res);
    if (result && typeof result.then === "function") result.catch(() => {});
  });
}

test("extract handler rejects non-POST", async () => {
  const r = await callHandler("GET");
  assert.equal(r.status, 405);
  assert.equal(r.body.error, "Metode tidak didukung.");
});

test("extract handler rejects unsupported URL", async () => {
  const r = await callHandler("POST", { url: "https://evil.test/a.mp4" });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "UNSUPPORTED_URL");
});

test("extract handler rejects HTTP-only URLs that are not public", async () => {
  const r = await callHandler("POST", { url: "http://instagram.com/p/1" });
  assert.equal(r.status, 400);
});

test("extract handler rejects profile with non-auto mode", async () => {
  const r = await callHandler("POST", { url: "https://www.tiktok.com/@demo", mode: "image" });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "PROFILE_MODE_UNSUPPORTED");
});
