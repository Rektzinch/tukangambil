"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRateLimiter } = require("../lib/rate-limit");

test("rate limiter allows up to max requests per window", () => {
  const limiter = createRateLimiter({ max: 3, windowMs: 60_000 });
  const req = { headers: {}, socket: { remoteAddress: "1.2.3.4" } };
  assert.equal(limiter.check(req).ok, true);
  assert.equal(limiter.check(req).ok, true);
  assert.equal(limiter.check(req).ok, true);
  assert.equal(limiter.check(req).ok, false);
});

test("rate limiter prefers rightmost x-forwarded-for value", () => {
  const limiter = createRateLimiter({ max: 1, windowMs: 60_000 });
  const req = { headers: { "x-forwarded-for": "203.0.113.9, 198.51.100.7" }, socket: { remoteAddress: "127.0.0.1" } };
  assert.equal(limiter.check(req).ip, "198.51.100.7");
});

test("rate limiter falls back to remoteAddress", () => {
  const limiter = createRateLimiter({ max: 5 });
  const req = { headers: {}, socket: { remoteAddress: "10.0.0.1" } };
  assert.equal(limiter.check(req).ip, "10.0.0.1");
});

test("rate limiter uses distinct buckets per client", () => {
  const limiter = createRateLimiter({ max: 1, windowMs: 60_000 });
  const first = { headers: {}, socket: { remoteAddress: "10.0.0.1" } };
  const second = { headers: {}, socket: { remoteAddress: "10.0.0.2" } };
  assert.equal(limiter.check(first).ok, true);
  assert.equal(limiter.check(second).ok, true);
  assert.equal(limiter.check(first).ok, false);
});
