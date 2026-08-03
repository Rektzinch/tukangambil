"use strict";
const fs=require("node:fs");
module.exports=function handler(req,res){
 if(req.method!=="GET")return res.status(405).json({error:"Metode tidak didukung."});
 let binary="";try{binary=require("youtube-dl-exec").constants.YOUTUBE_DL_PATH}catch{}
 const ytdlp=Boolean(binary&&fs.existsSync(binary));
 const ready=ytdlp;
 res.setHeader("Cache-Control","public, max-age=15, s-maxage=15");
 return res.status(ready?200:503).json({status:ready?"ready":"degraded",runtime:{node:process.version,ytdlp},platforms:{tiktok:{posts:true,profiles:ytdlp,stories:ytdlp},instagram:{posts:ytdlp,profiles:true,stories:ytdlp},facebook:{posts:ytdlp,profiles:ytdlp,stories:ytdlp},threads:{posts:true,profiles:ytdlp,stories:false},x:{posts:ytdlp,profiles:ytdlp,stories:false}}});
};
