"use strict";
const { Readable, Transform } = require("node:stream");
const { hostnameMatches, safeFilename, mimeFromFilename, verifyDownloadToken, sanitizeProviderError } = require("../lib/core");
const { createRateLimiter } = require("../lib/rate-limit");

const MEDIA_HOSTS = ["tiktok.com","tiktokcdn.com","tiktokcdn-us.com","tiktokv.com","tikwm.com","muscdn.com","muscdn.app","byteoversea.com","ibyteimg.com","akamaized.net","cdninstagram.com","fbcdn.net","twimg.com","snapcdn.app","api.hitube.io","googlevideo.com","fastdl.app","media.fastdl.app"];
const MAX_REDIRECTS = 3;
const MAX_BYTES = Math.max(5 * 1024 * 1024, Number(process.env.MAX_DOWNLOAD_BYTES) || 1024 * 1024 * 1024);
const rateLimit = createRateLimiter({ max: 40 });

function configuredHosts() {
  return [process.env.COBALT_API_URLS, process.env.COBALT_API_URL].filter(Boolean).join(",").split(",").map(v=>v.trim()).filter(Boolean).map(v=>{try{return new URL(v).hostname.toLowerCase()}catch{return null}}).filter(Boolean);
}
function allowedMediaUrl(value) { try { const u=new URL(value); return u.protocol === "https:" && hostnameMatches(u.hostname.toLowerCase(), [...MEDIA_HOSTS,...configuredHosts()]); } catch { return false; } }
function mediaRequestHeaders(url, range, preview){ const host=new URL(url).hostname.toLowerCase(); const h={Accept:"*/*","Accept-Encoding":"identity","User-Agent":"Mozilla/5.0 Chrome/127"}; if(range)h.Range=range; if(host.includes("tiktok"))h.Referer="https://www.tiktok.com/"; else if(host.includes("instagram"))h.Referer="https://www.instagram.com/"; else if(host.includes("fbcdn"))h.Referer="https://www.facebook.com/"; else if(host.includes("twimg"))h.Referer="https://x.com/"; return h; }
async function fetchAllowed(url, headers){ let current=url; for(let i=0;i<=MAX_REDIRECTS;i+=1){ if(!allowedMediaUrl(current))throw new Error("Host media tidak diizinkan."); const response=await fetch(current,{headers,redirect:"manual",signal:AbortSignal.timeout(40_000)}); if([301,302,303,307,308].includes(response.status)){const location=response.headers.get("location"); if(!location)throw new Error("Redirect media tidak valid."); current=new URL(location,current).toString(); continue} if(!allowedMediaUrl(response.url||current))throw new Error("Tujuan akhir media tidak diizinkan."); return response } throw new Error("Terlalu banyak redirect media."); }
function isDownloadable(filename,type){
  const clean=String(type||"").split(";",1)[0].trim().toLowerCase();
  // CDNs commonly use octet-stream for media, so use the safe filename only
  // for that generic type. Never let an HTML/error response through merely
  // because the requested filename has a media extension.
  if(clean && clean !== "application/octet-stream") return /^(?:image|video|audio)\//.test(clean);
  return mimeFromFilename(filename)!=="application/octet-stream";
}
function sameOrigin(req){const referer=String(req.headers?.referer||""); if(!referer)return false; try{return new URL(referer).host===String(req.headers?.host||"")}catch{return false}}

module.exports=async function handler(req,res){
  res.setHeader("Cache-Control","private, no-store"); res.setHeader("X-Content-Type-Options","nosniff");
  if(req.method!=="GET")return res.status(405).json({error:"Metode tidak didukung."});
  const limited=await rateLimit.check(req);
  if(!limited.ok){res.setHeader("Retry-After",String(limited.retryAfter||60));return res.status(429).json({error:"Terlalu banyak permintaan. Coba lagi sebentar."});}
  const tokenData=verifyDownloadToken(req.query?.token);
  const rawUrl=tokenData?.url || (sameOrigin(req) ? String(req.query?.url||"") : "");
  const filename=safeFilename(tokenData?.filename || req.query?.filename || "media");
  if(!rawUrl || !allowedMediaUrl(rawUrl))return res.status(400).json({error:"URL media tidak diizinkan atau token tidak valid."});
  try{
    const preview=req.query?.preview==="1";
    const upstream=await fetchAllowed(rawUrl,mediaRequestHeaders(rawUrl,req.headers?.range,preview));
    if(!upstream.ok||!upstream.body)throw new Error(`Media upstream gagal (${upstream.status}).`);
    const length=Number(upstream.headers.get("content-length"))||0;
    if(length>MAX_BYTES)throw new Error("Ukuran media melewati batas layanan.");
    const type=upstream.headers.get("content-type");
    if(!isDownloadable(filename,type))throw new Error("Respons upstream bukan media.");
    res.statusCode=upstream.status===206?206:200;
    res.setHeader("Content-Type",mimeFromFilename(filename,type));
    res.setHeader("Content-Disposition",`${preview?"inline":"attachment"}; filename="${filename.replace(/[^\x20-\x7e]/g,"_").replace(/["\\]/g,"_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    if(length)res.setHeader("Content-Length",String(length));
    for(const h of ["accept-ranges","content-range"]){const v=upstream.headers.get(h);if(v)res.setHeader(h,v)}
    let received=0;
    const limiter=new Transform({transform(chunk,_enc,cb){received+=chunk.length;if(received>MAX_BYTES)return cb(new Error("Ukuran media melewati batas layanan."));cb(null,chunk)}});
    const stream=Readable.fromWeb(upstream.body);
    stream.on("error",e=>res.destroy(e)); limiter.on("error",e=>res.destroy(e)); stream.pipe(limiter).pipe(res);
  }catch(error){if(!res.headersSent)return res.status(502).json({error:"File belum dapat diunduh.",detail:sanitizeProviderError(error).message});res.destroy(error)}
};
module.exports.allowedMediaUrl=allowedMediaUrl; module.exports.fetchAllowed=fetchAllowed; module.exports.isDownloadable=isDownloadable;
