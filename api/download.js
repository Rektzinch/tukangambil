const { Readable, Transform } = require("node:stream");
const { safeFilename, mimeFromFilename, verifyDownloadToken, sanitizeProviderError } = require("../lib/core");
const { createRateLimiter } = require("../lib/rate-limit");
const { allowedMediaUrl, fetchAllowedMedia, mediaRequestHeaders } = require("../lib/media-policy");

const MAX_BYTES = Math.max(5 * 1024 * 1024, Number(process.env.MAX_DOWNLOAD_BYTES) || 1024 * 1024 * 1024);
const rateLimit = createRateLimiter({ max: 40 });

function downloadsRequireToken() {
  return process.env.NODE_ENV === "production" || Boolean(String(process.env.DOWNLOAD_TOKEN_SECRET || "").trim());
}

function isDownloadable(filename, type) {
  const clean = String(type || "").split(";", 1)[0].trim().toLowerCase();
  // CDNs commonly use octet-stream for media, so use the safe filename only
  // for that generic type. Never let an HTML/error response through merely
  // because the requested filename has a media extension.
  if (clean && clean !== "application/octet-stream") return /^(?:image|video|audio)\//.test(clean);
  return mimeFromFilename(filename) !== "application/octet-stream";
}

async function fetchAllowed(url, headers) {
  return fetchAllowedMedia(url, { headers, timeoutMs: 40_000 });
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "GET") return res.status(405).json({ error: "Metode tidak didukung." });

  const limited = await rateLimit.check(req);
  if (!limited.ok) {
    res.setHeader("Retry-After", String(limited.retryAfter || 60));
    return res.status(429).json({ error: "Terlalu banyak permintaan. Coba lagi sebentar." });
  }

  const tokenData = verifyDownloadToken(req.query?.token);
  const hasValidToken = Boolean(tokenData);
  if (downloadsRequireToken() && !hasValidToken) {
    return res.status(401).json({ error: "Token unduhan tidak valid atau sudah kedaluwarsa." });
  }

  const rawUrl = tokenData?.url || String(req.query?.url || "");
  const filename = safeFilename(tokenData?.filename || req.query?.filename || "media");
  if (!rawUrl || !allowedMediaUrl(rawUrl)) {
    return res.status(400).json({ error: "URL media tidak diizinkan atau token tidak valid." });
  }

  try {
    const preview = req.query?.preview === "1";
    const upstream = await fetchAllowed(rawUrl, mediaRequestHeaders(rawUrl, req.headers?.range));
    if (!upstream.ok || !upstream.body) throw new Error(`Media upstream gagal (${upstream.status}).`);

    const length = Number(upstream.headers.get("content-length")) || 0;
    if (length > MAX_BYTES) throw new Error("Ukuran media melewati batas layanan.");

    const type = upstream.headers.get("content-type");
    if (!isDownloadable(filename, type)) throw new Error("Respons upstream bukan media.");

    res.statusCode = upstream.status === 206 ? 206 : 200;
    res.setHeader("Content-Type", mimeFromFilename(filename, type));
    const disposition = preview ? "inline" : "attachment";
    const asciiFilename = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    res.setHeader("Content-Disposition", `${disposition}; filename="${asciiFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    if (length) res.setHeader("Content-Length", String(length));
    for (const header of ["accept-ranges", "content-range"]) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }

    let received = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > MAX_BYTES) return callback(new Error("Ukuran media melewati batas layanan."));
        callback(null, chunk);
      }
    });
    const stream = Readable.fromWeb(upstream.body);
    stream.on("error", error => res.destroy(error));
    limiter.on("error", error => res.destroy(error));
    stream.pipe(limiter).pipe(res);
  } catch (error) {
    if (!res.headersSent) return res.status(502).json({ error: "File belum dapat diunduh.", detail: sanitizeProviderError(error).message });
    res.destroy(error);
  }
};

module.exports.allowedMediaUrl = allowedMediaUrl;
module.exports.fetchAllowed = fetchAllowed;
module.exports.isDownloadable = isDownloadable;
module.exports.downloadsRequireToken = downloadsRequireToken;
