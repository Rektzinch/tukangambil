"use strict";

const UPSTASH_REST_URL = String(process.env.UPSTASH_REDIS_REST_URL || "").trim().replace(/\/+$/, "");
const UPSTASH_REST_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || "").trim();
const UPSTASH_ENABLED = Boolean(UPSTASH_REST_URL && UPSTASH_REST_TOKEN);

function trustedProxyMarker(req) {
  const via = String(req?.headers?.via || "").toLowerCase();
  if (req?.headers?.["x-vercel-id"] || /vercel/i.test(via)) return "vercel";
  if (req?.headers?.["cf-ray"] || /cloudflare/i.test(via)) return "cloudflare";
  return "";
}

function clientIp(req) {
  const cf = String(req?.headers?.["cf-connecting-ip"] || "").trim();
  if (cf) return cf;
  if (trustedProxyMarker(req)) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").trim();
    const parts = forwarded.split(",").map(part => part.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  return String(req?.socket?.remoteAddress || "unknown");
}

function createRateLimiter({ windowMs = 60_000, max = 40, maxEntries = 10_000 } = {}) {
  const buckets = new Map();

  function memoryCheck(ip) {
    const now = Date.now();
    if (buckets.size >= maxEntries) {
      for (const [key, bucket] of buckets) {
        if (now - bucket.started > windowMs) buckets.delete(key);
      }
    }
    const existing = buckets.get(ip);
    if (!existing || now - existing.started > windowMs) {
      buckets.set(ip, { started: now, count: 1 });
      return { ok: true, remaining: max - 1, retryAfter: 0 };
    }
    existing.count += 1;
    const ok = existing.count <= max;
    return {
      ok,
      remaining: Math.max(0, max - existing.count),
      retryAfter: ok ? 0 : Math.max(1, Math.ceil((existing.started + windowMs - now) / 1000))
    };
  }

  async function upstashCheck(ip) {
    const ttlSeconds = Math.ceil(windowMs / 1000);
    const script = "local c = redis.call('INCR',KEYS[1]); if c==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return c";
    try {
      const response = await fetch(`${UPSTASH_REST_URL}/eval`, {
        method: "POST",
        headers: { Authorization: `Bearer ${UPSTASH_REST_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify([script, `rl:${ip}`, ttlSeconds]),
        signal: AbortSignal.timeout(1500)
      });
      if (!response.ok) return null;
      const data = await response.json().catch(() => null);
      const count = Number(data?.result);
      if (!Number.isFinite(count) || count < 0) return null;
      return { ok: count <= max, remaining: Math.max(0, max - count), retryAfter: count > max ? ttlSeconds : 0 };
    } catch {
      return null;
    }
  }

  async function check(req) {
    const ip = clientIp(req);
    if (UPSTASH_ENABLED) {
      const upstream = await upstashCheck(ip);
      if (upstream) return { ...upstream, ip };
    }
    return { ...memoryCheck(ip), ip };
  }

  return { check, clientIp };
}

module.exports = { createRateLimiter };
