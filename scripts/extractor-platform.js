"use strict";

function binaryAsset(platform = process.platform, arch = process.arch) {
  if (platform === "linux" && arch === "x64") return "yt-dlp_linux";
  if (platform === "linux" && arch === "arm64") return "yt-dlp_linux_aarch64";
  throw new Error(`Unsupported extractor platform: ${platform}/${arch}. Set YTDLP_BINARY_URL and YTDLP_BINARY_SHA256 for a compatible Linux ELF binary.`);
}

module.exports = { binaryAsset };
