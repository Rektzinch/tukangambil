const MEDIA_HOSTS = Object.freeze([
  "tiktok.com", "tiktokcdn.com", "tiktokcdn-us.com", "tiktokv.com",
  "tikwm.com", "muscdn.com", "muscdn.app", "byteoversea.com", "ibyteimg.com",
  "akamaized.net", "cdninstagram.com", "fbcdn.net", "twimg.com", "snapcdn.app",
  "api.hitube.io", "googlevideo.com", "fastdl.app", "media.fastdl.app"
]);

const MAX_REDIRECTS = 3;

function hostnameMatches(host, domains) {
  return domains.some(domain => host === domain || host.endsWith(`.${domain}`));
}

function configuredMediaHosts() {
  const configured = [
    process.env.COBALT_API_URLS,
    process.env.COBALT_API_URL,
    process.env.FASTDL_MEDIA_URL
  ]
    .filter(Boolean)
    .join(",")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);

  return configured.flatMap(value => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" && !parsed.port ? [parsed.hostname.toLowerCase()] : [];
    } catch {
      return [];
    }
  });
}

function allowedMediaUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return false;
    const host = parsed.hostname.toLowerCase();
    if (host === "ssscdn.io") return parsed.pathname.startsWith("/getmyfb/");
    return hostnameMatches(host, [...MEDIA_HOSTS, ...configuredMediaHosts()]);
  } catch {
    return false;
  }
}

function mediaRequestHeaders(url, range) {
  const host = new URL(url).hostname.toLowerCase();
  const headers = {
    Accept: "*/*",
    "Accept-Encoding": "identity",
    "User-Agent": "Mozilla/5.0 Chrome/127"
  };
  if (range) headers.Range = range;
  if (host.includes("tiktok")) headers.Referer = "https://www.tiktok.com/";
  else if (host.includes("instagram")) headers.Referer = "https://www.instagram.com/";
  else if (host.includes("fbcdn")) headers.Referer = "https://www.facebook.com/";
  else if (host.includes("twimg")) headers.Referer = "https://x.com/";
  else if (host.includes("ssscdn")) headers.Referer = "https://getmyfb.com/";
  return headers;
}

async function fetchAllowedMedia(url, { headers, timeoutMs = 40_000, maxRedirects = MAX_REDIRECTS } = {}) {
  let current = url;
  for (let attempt = 0; attempt <= maxRedirects; attempt += 1) {
    if (!allowedMediaUrl(current)) throw new Error("Host media tidak diizinkan.");
    const response = await fetch(current, {
      headers: headers || mediaRequestHeaders(current),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs)
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Redirect media tidak valid.");
      current = new URL(location, current).toString();
      continue;
    }

    if (!allowedMediaUrl(response.url || current)) throw new Error("Tujuan akhir media tidak diizinkan.");
    return response;
  }
  throw new Error("Terlalu banyak redirect media.");
}

module.exports = {
  MEDIA_HOSTS,
  MAX_REDIRECTS,
  hostnameMatches,
  configuredMediaHosts,
  allowedMediaUrl,
  mediaRequestHeaders,
  fetchAllowedMedia
};
