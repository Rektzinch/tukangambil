"use strict";
const fs=require("node:fs");
module.exports=function handler(req,res){
 if(req.method!=="GET")return res.status(405).json({error:"Metode tidak didukung."});
 let binary="";try{binary=require("youtube-dl-exec").constants.YOUTUBE_DL_PATH}catch{}
 const ytdlp=Boolean(binary&&fs.existsSync(binary));
 const cobalt=Boolean(process.env.COBALT_API_URL||process.env.COBALT_API_URLS);
 const cookies=Boolean(process.env.YTDLP_COOKIES_B64);
 const downloadSecurity=Boolean(process.env.DOWNLOAD_TOKEN_SECRET);
 const ready=ytdlp;
 res.setHeader("Cache-Control","public, max-age=15, s-maxage=15");
 return res.status(ready?200:503).json({status:ready?"ready":"degraded",runtime:{node:process.version,ytdlp,cobaltConfigured:cobalt,cookiesConfigured:cookies,signedDownloads:downloadSecurity},platforms:{tiktok:{posts:true,profiles:ytdlp,stories:ytdlp},instagram:{posts:ytdlp,profiles:true,stories:ytdlp,storySessionRecommended:!cookies},facebook:{posts:ytdlp,profiles:ytdlp,stories:ytdlp,storySessionRecommended:!cookies},threads:{posts:true,profiles:ytdlp,stories:false},x:{posts:ytdlp,profiles:ytdlp,stories:false}}});
};
