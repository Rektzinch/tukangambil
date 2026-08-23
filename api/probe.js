
// api/_probe.js — temporary probe endpoint
module.exports = async function handler(req, res) {
  const { url } = req.query;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 Chrome/127" } });
    const t = await r.text();
    return res.status(200).json({
      status: r.status,
      len: t.length,
      hasEmbeddedMediaImage: t.includes("EmbeddedMediaImage"),
      hasVideoUrl: t.includes("video_url"),
      hasWatchOnIG: t.includes("Watch on Instagram"),
      img: (t.match(/EmbeddedMediaImage[^>]*src="([^"]+)"/) || [])[1]?.slice(0, 100) || null
    });
  } catch (e) { return res.status(500).json({ error: e.message }); }
};
