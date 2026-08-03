"use strict";

function createRateLimiter({ windowMs = 60_000, max = 40, maxEntries = 10_000 } = {}) {
  const buckets = new Map();

  function clientIp(req) {
    const forwarded = String(req?.headers?.["x-forwarded-for"] || "").trim();
    if (forwarded) {
      const parts = forwarded.split(",").map(part => part.trim()).filter(Boolean);
      const last = parts[parts.length - 1];
      if (last) return last;
    }
    return String(req?.socket?.remoteAddress || "unknown");
  }

  function check(req) {
    const now = Date.now();
    if (buckets.size >= maxEntries) {
      for (const [ip, bucket] of buckets) {
        if (now - bucket.started > windowMs) buckets.delete(ip);
      }
    }
    const ip = clientIp(req);
    const existing = buckets.get(ip);
    if (!existing || now - existing.started > windowMs) {
      buckets.set(ip, { started: now, count: 1 });
      return { ok: true, remaining: max - 1, ip };
    }
    existing.count += 1;
    return { ok: existing.count <= max, remaining: Math.max(0, max - existing.count), ip };
  }

  return { check, clientIp };
}

module.exports = { createRateLimiter };
