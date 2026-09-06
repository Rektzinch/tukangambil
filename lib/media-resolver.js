"use strict";
const { allowedMediaUrl, fetchAllowedMedia, mediaRequestHeaders } = require("./media-policy");

async function probeDownloadable(url, timeoutMs = 5000) {
  if (!allowedMediaUrl(url)) return false;
  try {
    const response = await fetchAllowedMedia(url, { headers: mediaRequestHeaders(url, "bytes=0-511"), timeoutMs });
    const type = String(response.headers.get("content-type") || "").split(";", 1)[0].toLowerCase();
    const length = response.headers.get("content-length");
    const ok = [200, 206].includes(response.status) && length !== "0" && (!type || type === "application/octet-stream" || /^(?:video|image|audio)\//.test(type));
    await response.body?.cancel();
    return ok;
  } catch { return false; }
}

async function resolveMediaItem(item, { deadline = Date.now() + 10000 } = {}) {
  const urls = [...new Set([item.url, ...(item.fallbackUrls || [])])].filter(allowedMediaUrl).slice(0, 4);
  for (const url of urls) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    if (await probeDownloadable(url, Math.min(5000, remaining))) {
      const changed = url !== item.url;
      return { ...item, url, fallbackUrls: urls.filter(candidate => candidate !== url), ...(changed ? { quality: "Kualitas alternatif tersedia", width: undefined, height: undefined, bestQuality: false } : {}), available: true };
    }
  }
  return null;
}

async function verifyMediaResult(result, { deadline = Date.now() + 14000, concurrency = 6 } = {}) {
  const entries = result.items || [];
  const verified = new Array(entries.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
    while (cursor < entries.length) {
      const i = cursor++;
      verified[i] = await resolveMediaItem(entries[i], { deadline });
    }
  }));
  const items = verified.filter(Boolean);
  if (!items.length) throw Object.assign(new Error("Sumber ditemukan, tetapi file media belum dapat diunduh. Coba ambil ulang tautannya."), { code: "MEDIA_UNAVAILABLE" });
  const skipped = entries.length - items.length;
  const changed = items.some((item, i) => !entries.some(original => original.url === item.url));
  return { ...result, items, partial: Boolean(result.partial || skipped), warnings: [...(result.warnings || []), ...(changed ? ["Sumber utama tidak dapat diunduh; dipakai tautan alternatif yang tersedia."] : []), ...(skipped ? [`${skipped} media belum tersedia. Media lainnya tetap dapat diunduh.`] : [])] };
}
module.exports = { probeDownloadable, resolveMediaItem, verifyMediaResult };
