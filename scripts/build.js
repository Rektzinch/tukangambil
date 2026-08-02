"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "public");
const output = path.join(root, "dist");
const requiredFiles = ["index.html", "app.js", "style.css"];

if (!fs.existsSync(source)) {
  throw new Error("Folder public tidak ditemukan.");
}

for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(source, file))) {
    throw new Error(`File frontend wajib tidak ditemukan: public/${file}`);
  }
}

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
fs.cpSync(source, output, { recursive: true });

console.log(`Build selesai: ${requiredFiles.length} aset utama disalin ke dist/.`);
