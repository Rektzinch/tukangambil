"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRateLimiter } = require("../lib/rate-limit");

test("rate limiter allows up to max requests per window", async () => {
  const limiter = createRateLimiter({ max: 3, windowMs: 60_000 });
  const req = { headers: { "x-vercel-id": "abc" }, socket: { remoteAddress: "1.2.3.4" } };
  assert.equal((await limiter.check(req)).ok, true);
  assert.equal((await limiter.check(req)).ok, true);
  assert.equal((await limiter.check(req)).ok, true);
  assert.equal((await limiter.check(req)).ok, false);
  assert.equal((await limiter.check(req)).ok, false);
});

test("rate limiter reports Retry-After when blocked", async () => {
  const limiter = createRateLimiter({ max: 1, windowMs: 60_000 });
  const req = { headers: { "x-vercel-id": "abc" }, socket: { remoteAddress: "1.2.3.4" } };
  await limiter.check(req);
  const blocked = await limiter.check(req);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfter >= 1);
});

test("rate limiter prefers rightmost x-forwarded-for behind a trusted proxy", () => {
  const limiter = createRateLimiter({ max: 1, windowMs: 60_000 });
  const req = { headers: { "x-vercel-id": "abc", "x-forwarded-for": "203.0.113.9, 198.51.100.7" }, socket: { remoteAddress: "127.0.0.1" } };
  assert.equal(limiter.clientIp(req), "198.51.100.7");
});

test("rate limiter ignores spoofable x-forwarded-for without a trusted proxy", () => {
  const limiter = createRateLimiter({ max: 5 });
  const req = { headers: { "x-forwarded-for": "1.2.3.4" }, socket: { remoteAddress: "10.0.0.1" } };
  assert.equal(limiter.clientIp(req), "10.0.0.1");
});

test("rate limiter prefers cf-connecting-ip only from a marked Cloudflare proxy", () => {
  const limiter = createRateLimiter({ max: 1 });
  const req = { headers: { "cf-ray": "abc-SIN", "cf-connecting-ip": "8.8.8.8" }, socket: { remoteAddress: "10.0.0.1" } };
  assert.equal(limiter.clientIp(req), "8.8.8.8");
});

test("rate limiter falls back to remoteAddress", () => {
  const limiter = createRateLimiter({ max: 5 });
  const req = { headers: {}, socket: { remoteAddress: "10.0.0.1" } };
  assert.equal(limiter.clientIp(req), "10.0.0.1");
});

test("rate limiter uses distinct buckets per client", async () => {
  const limiter = createRateLimiter({ max: 1, windowMs: 60_000 });
  const first = { headers: { "x-vercel-id": "abc" }, socket: { remoteAddress: "10.0.0.1" } };
  const second = { headers: { "x-vercel-id": "abc" }, socket: { remoteAddress: "10.0.0.2" } };
  assert.equal((await limiter.check(first)).ok, true);
  assert.equal((await limiter.check(second)).ok, true);
  assert.equal((await limiter.check(first)).ok, false);
});
