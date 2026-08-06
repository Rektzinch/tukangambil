"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "public");
const output = path.join(root, "dist");
const requiredFiles = ["index.html", "app.js", "style.css"];
const fontSource = path.join(root, "node_modules", "@fontsource-variable", "archivo", "files", "archivo-latin-wdth-normal.woff2");

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

if (!fs.existsSync(fontSource)) {
  throw new Error("Font Archivo lokal tidak ditemukan. Jalankan npm install.");
}

const fontOutput = path.join(output, "fonts");
fs.mkdirSync(fontOutput, { recursive: true });
fs.copyFileSync(fontSource, path.join(fontOutput, "archivo-variable.woff2"));

console.log(`Build selesai: ${requiredFiles.length} aset utama dan font lokal disalin ke dist/.`);
