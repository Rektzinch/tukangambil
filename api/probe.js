"use strict";

// Retired diagnostic route. Never fetch caller-supplied URLs here.
module.exports = async function handler(_req, res) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(404).json({ error: "Tidak ditemukan." });
};
