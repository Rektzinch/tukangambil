"use strict";

const form = document.querySelector("#downloadForm");
const input = document.querySelector("#mediaUrl");
const message = document.querySelector("#message");
const results = document.querySelector("#results");
const submit = form.querySelector(".submit");
const scan = document.querySelector("#scan");
const scanLabel = document.querySelector("#scanLabel");
const scanSubLabel = document.querySelector("#scanSubLabel");
const scanTime = document.querySelector("#scanTime");
const scanPercent = document.querySelector("#scanPercent");
const scanProgress = document.querySelector("#scanProgress");
const scanProgressTrack = document.querySelector("#scanProgressTrack");
const scanSteps = [...document.querySelectorAll(".scan-steps span")];
const pasteBtn = document.querySelector("#pasteBtn");
const submitText = submit.querySelector("span");
const formHint = document.querySelector("#formHint");
const formHintIcon = document.querySelector("#formHintIcon");
const formHintText = document.querySelector("#formHintText");
let mode = "auto";
let data = null;
let index = 0;
let timer = null;
let modalReturnFocus = null;
let extractController = null;
let profileOffset = 0;
let profileHasMore = false;
let profileLoading = false;
let profileUrl = "";

const statsKey = "tukangambil:stats:v2";
let stats = loadStats();

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[char]);
}

function loadStats() {
  try {
    const stored = JSON.parse(localStorage.getItem(statsKey));
    const platforms = Object.fromEntries(["tiktok", "instagram", "facebook", "threads", "x"].map(platform => [platform, Number(stored?.platforms?.[platform]) || 0]));
    return { total: Number(stored?.total) || 0, success: Number(stored?.success) || 0, failed: Number(stored?.failed) || 0, platforms };
  } catch {
    return { total: 0, success: 0, failed: 0, platforms: { tiktok: 0, instagram: 0, facebook: 0, threads: 0, x: 0 } };
  }
}

function renderStats() {
  const done = stats.success + stats.failed;
  document.querySelector("#statTotal").textContent = stats.total;
  document.querySelector("#statSuccess").textContent = stats.success;
  document.querySelector("#statFailed").textContent = stats.failed;
  document.querySelector("#statRate").textContent = `${done ? Math.round((stats.success / done) * 100) : 0}%`;
  const labels = { tiktok: "TikTok", instagram: "Instagram", facebook: "Facebook", threads: "Threads", x: "X" };
  const ranked = Object.entries(stats.platforms).sort((a, b) => b[1] - a[1] || labels[a[0]].localeCompare(labels[b[0]]));
  const max = Math.max(1, ...ranked.map(([, count]) => count));
  document.querySelector("#platformRank").innerHTML = ranked.map(([platform, count], rank) => `<div class="platform-row"><span class="platform-position">0${rank + 1}</span><b>${labels[platform]}</b><div class="platform-bar"><span style="width:${count ? Math.max(8, Math.round((count / max) * 100)) : 0}%"></span></div><strong>${count}</strong></div>`).join("");
}

function bump(key) {
  stats[key] += 1;
  try {
    localStorage.setItem(statsKey, JSON.stringify(stats));
  } catch {
    // Penyimpanan lokal diblokir (mis. private mode); statistik tetap dihitung di sesi ini.
  }
  renderStats();
}

function bumpPlatform(platform) {
  const key = String(platform || "").toLowerCase();
  if (!(key in stats.platforms)) return;
  stats.platforms[key] += 1;
  try {
    localStorage.setItem(statsKey, JSON.stringify(stats));
  } catch {}
  renderStats();
}

function show(text, type = "info") {
  message.textContent = text;
  message.className = `message show ${type}`;
}

function platformFromUrl(value) {
  try {
    const host = new URL(normalizeUrl(value)).hostname.replace(/^www\./, "").toLowerCase();
    if (host.includes("instagram.com")) return "Instagram";
    if (host.includes("tiktok.com")) return "TikTok";
    if (host.includes("facebook.com") || host === "fb.watch") return "Facebook";
    if (host.includes("threads.net") || host.includes("threads.com")) return "Threads";
    if (host === "x.com" || host.includes("twitter.com")) return "X";
  } catch {}
  return "";
}

function updateUrlFeedback() {
  const platform = platformFromUrl(input.value);
  if (mode === "profile") {
    formHint.classList.add("detected");
    formHintIcon.textContent = "✓";
    formHintText.textContent = "Mode Media Profil aktif. Masukkan tautan profil untuk mengambil semua media.";
  } else if (platform) {
    formHint.classList.add("detected");
    formHintIcon.textContent = "✓";
    formHintText.textContent = `${platform} terdeteksi. Tautan siap diproses.`;
  } else {
    formHint.classList.remove("detected");
    formHintIcon.textContent = "✦";
    formHintText.textContent = input.value.trim()
      ? "Pastikan tautan berasal dari platform yang didukung."
      : "Hanya untuk konten publik. Kami tidak menyimpan URL kamu.";
  }
}

function isProfileUrl(value) {
  try {
    const path = new URL(value).pathname.toLowerCase();
    return path.split("/").filter(Boolean).length === 1 && path.includes("@");
  } catch {
    return false;
  }
}

function resourceKind(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path.includes("stories") || path.includes("story.php")) return "Story";
    if (path.includes("reel")) return "Reel";
    if (path.split("/").filter(Boolean).length === 1) return "profil";
  } catch {}
  return "media";
}

function normalizeUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function setScanStep(activeIndex) {
  scanSteps.forEach((el, i) => {
    el.classList.toggle("active", i === activeIndex);
    el.classList.toggle("done", i < activeIndex);
  });
}

function setScanLabel(label, sub) {
  if (scanLabel.textContent === label) return;
  scanLabel.classList.remove("flip");
  void scanLabel.offsetWidth;
  scanLabel.textContent = label;
  scanSubLabel.textContent = sub;
  scanLabel.classList.add("flip");
}

function start() {
  const began = Date.now();
  scan.hidden = false;
  scanTime.textContent = "00:00";
  scanProgress.style.width = "12%";
  scan.style.setProperty("--p", "12%");
  scanPercent.textContent = "12%";
  setScanStep(0);
  submit.disabled = true;
  submitText.textContent = "Sedang mengambil";
  form.setAttribute("aria-busy", "true");
  const kind = mode === "profile" ? "profil" : resourceKind(input.value);

  function updateScan(seconds) {
    scanTime.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    const progress = Math.min(94, Math.round(12 + 82 * (1 - Math.exp(-seconds / 14))));
    scanProgress.style.width = `${progress}%`;
    scanProgressTrack.setAttribute("aria-valuenow", String(progress));
    scan.style.setProperty("--p", `${progress}%`);
    scanPercent.textContent = `${progress}%`;
    if (seconds >= 45) {
      setScanStep(3);
      setScanLabel("Masih memproses media", "Provider membutuhkan waktu lebih lama dari biasanya");
    } else if (seconds >= 18) {
      setScanStep(3);
      setScanLabel("Menyiapkan preview", "Hasil akhir sedang dirapikan untuk ditampilkan");
    } else if (seconds >= 8) {
      setScanStep(2);
      setScanLabel("Memilih kualitas terbaik", "Membandingkan format video, gambar, dan audio");
    } else if (seconds >= 3) {
      setScanStep(1);
      setScanLabel("Menghubungi provider", `Mencari sumber ${kind} yang dapat diunduh`);
    } else {
      setScanStep(0);
      setScanLabel("Memvalidasi tautan", `Memeriksa alamat dan jenis ${kind}`);
    }
  }

  updateScan(0);
  timer = setInterval(() => {
    const seconds = Math.floor((Date.now() - began) / 1000);
    updateScan(seconds);
  }, 250);
}

function stop() {
  clearInterval(timer);
  timer = null;
  scan.hidden = true;
  scanProgress.style.width = "0";
  scan.style.setProperty("--p", "0%");
  scanPercent.textContent = "0%";
  scanProgressTrack.setAttribute("aria-valuenow", "0");
  submit.disabled = false;
  submitText.textContent = mode === "profile" ? "Ambil media profil" : "Ambil dan preview";
  form.removeAttribute("aria-busy");
}

function mediaUrl(item, preview = false) {
  const query = new URLSearchParams();
  if (item.downloadToken) query.set("token", item.downloadToken);
  else {
    query.set("url", item.url);
    query.set("filename", item.filename);
  }
  if (preview) query.set("preview", "1");
  return `/api/download?${query}`;
}

function thumbUrl(item) {
  if (!item.thumb) return "";
  const query = new URLSearchParams({ url: item.thumb, filename: "preview.jpg", preview: "1" });
  return `/api/download?${query}`;
}

function preview(item) {
  const url = escapeHtml(mediaUrl(item, true));
  if (item.type === "image") return `<img src="${url}" alt="${escapeHtml(item.filename)}">`;
  if (item.type === "audio") return `<audio controls preload="metadata" src="${url}"></audio>`;
  const poster = item.thumb ? ` poster="${escapeHtml(thumbUrl(item))}"` : "";
  return `<video controls playsinline preload="metadata"${poster} src="${url}" type="${escapeHtml(item.mime || "video/mp4")}"></video>`;
}

function directDownload(event, item) {
  event.preventDefault();
  const anchor = document.createElement("a");
  anchor.href = mediaUrl(item);
  anchor.download = item.filename || "media";
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  show(`${item.filename} mulai diunduh.`);
}

function bindDownloads(root, items) {
  root.querySelectorAll("[data-dl]").forEach(anchor => anchor.addEventListener("click", event => directDownload(event, items[Number(anchor.dataset.dl)])));
}

async function readApiResponse(response) {
  const raw = await response.text();
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    // Proxies and platform errors can return HTML or an empty body.
  }
  if (!response.ok) {
    throw new Error(body.error || `Server gagal memproses permintaan (${response.status}).`);
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw new Error("Server tidak mengembalikan media yang dapat diunduh.");
  }
  return body;
}

function closeModal() {
  const modal = document.querySelector(".modal");
  if (modal) modal.hidden = true;
  document.body.style.overflow = "";
  modalReturnFocus?.focus();
  modalReturnFocus = null;
}

function openModal(i, button) {
  modalReturnFocus = button;
  const item = data.items[i];
  let modal = document.querySelector(".modal");
  if (!modal) {
    modal = document.createElement("div");
    modal.className = "modal";
    modal.innerHTML = '<div class="modal-box" role="dialog" aria-modal="true" aria-label="Preview media"><div class="modal-top"><b></b><button type="button" aria-label="Tutup">×</button></div><div class="modal-content"></div></div>';
    document.body.appendChild(modal);
    modal.addEventListener("click", event => {
      if (event.target === modal) closeModal();
    });
    modal.querySelector("button").addEventListener("click", closeModal);
    modal.addEventListener("keydown", event => {
      if (event.key !== "Tab") return;
      const focusables = [...modal.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex=\"-1\"])")]
        .filter(element => !element.disabled);
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }
  modal.querySelector(".modal-top b").textContent = `${i + 1} / ${data.items.length}`;
  modal.querySelector(".modal-content").innerHTML = `<div class="preview">${preview(item)}</div><div class="meta"><h2>${escapeHtml(item.filename)}</h2><a class="download" href="${escapeHtml(mediaUrl(item))}" data-dl="${i}">Download media ini</a></div>`;
  bindDownloads(modal, [...data.items]);
  modal.hidden = false;
  document.body.style.overflow = "hidden";
  modal.querySelector("button").focus();
}

function render() {
  const isCollection = data.items.length > 2;
  if (isCollection) {
    const collectionWarnings = data.warnings?.length ? `<div class="message show">${data.warnings.map(escapeHtml).join(" · ")}</div>` : "";
    const loadMore = profileHasMore ? `<button class="load-more" type="button">Muat lebih banyak</button>` : "";
    results.innerHTML = `<div class="results-title"><span>${escapeHtml(data.title)}</span><b>${data.items.length} media</b></div><section class="collection"><div class="collection-head"><h2>${escapeHtml(data.title)}</h2><p>${escapeHtml(data.author || "")}</p>${collectionWarnings}<button class="download-all" type="button">Download semua media</button></div><div class="grid">${data.items.map((item, i) => `<article class="tile"><div class="tile-media">${item.type === "image" ? `<img src="${escapeHtml(mediaUrl(item, true))}" alt="${escapeHtml(item.filename)}" loading="lazy" decoding="async">` : item.thumb ? `<img src="${escapeHtml(thumbUrl(item))}" alt="Thumbnail ${escapeHtml(item.filename)}" loading="lazy" decoding="async">` : `<span>${item.type.toUpperCase()}</span>`}</div><div class="tile-badges"><span class="badge">${escapeHtml(data.platform)}</span><span class="badge">${escapeHtml(item.type)}</span></div><h3>${escapeHtml(item.filename)}</h3><div class="tile-actions"><button class="preview-btn" data-preview="${i}" type="button">Preview</button><a class="download" data-dl="${i}" href="${escapeHtml(mediaUrl(item))}">Download</a></div></article>`).join("")}</div>${loadMore}</section>`;
    results.querySelectorAll("[data-preview]").forEach(button => button.addEventListener("click", () => openModal(Number(button.dataset.preview), button)));
    results.querySelector(".download-all").addEventListener("click", async () => {
      show("Browser akan memulai unduhan satu per satu. Izinkan multiple downloads bila diminta.");
      for (const item of data.items) {
        const anchor = document.createElement("a");
        anchor.href = mediaUrl(item);
        anchor.download = item.filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        await new Promise(resolve => setTimeout(resolve, 450));
      }
    });
    const loadMoreBtn = results.querySelector(".load-more");
    if (loadMoreBtn) loadMoreBtn.addEventListener("click", () => loadMoreProfile());
  } else {
    const item = data.items[index];
    results.innerHTML = `<div class="results-title"><span>${escapeHtml(data.resourceKind || "media")} · ${escapeHtml(data.provider)}</span><b>${index + 1}/${data.items.length}</b></div><section class="card"><div class="preview">${preview(item)}</div><div class="meta"><div class="badges"><span class="badge">${escapeHtml(data.platform)}</span><span class="badge">${escapeHtml(item.type)}</span><span class="badge">${escapeHtml(item.quality)}</span></div><h2>${escapeHtml(data.title)}</h2><p>${escapeHtml(data.author || "")}</p>${data.warnings?.length ? `<p>${data.warnings.map(escapeHtml).join(" · ")}</p>` : ""}<a class="download" data-dl="${index}" href="${escapeHtml(mediaUrl(item))}">Download media ini</a>${data.items.length > 1 ? '<div class="nav"><button data-nav="prev">Sebelumnya</button><button data-nav="next">Berikutnya</button></div>' : ""}</div></section>`;
    results.querySelectorAll("[data-nav]").forEach(button => button.addEventListener("click", () => {
      index = button.dataset.nav === "next" ? (index + 1) % data.items.length : (index - 1 + data.items.length) % data.items.length;
      render();
    }));
  }
  results.hidden = false;
  bindDownloads(results, data.items);
}

document.querySelectorAll(".mode").forEach(button => button.addEventListener("click", () => {
  document.querySelectorAll(".mode").forEach(candidate => {
    candidate.classList.remove("active");
    candidate.setAttribute("aria-pressed", "false");
  });
  button.classList.add("active");
  button.setAttribute("aria-pressed", "true");
  mode = button.dataset.mode;
  submitText.textContent = mode === "profile" ? "Ambil media profil" : "Ambil dan preview";
  updateUrlFeedback();
}));

pasteBtn.addEventListener("click", async () => {
  try {
    input.value = await navigator.clipboard.readText();
    updateUrlFeedback();
    pasteBtn.firstChild.textContent = "Ditempel ";
    setTimeout(() => { pasteBtn.firstChild.textContent = "Tempel "; }, 1400);
    input.focus();
  } catch {
    show("Izin clipboard tidak tersedia.", "error");
  }
});

input.addEventListener("input", updateUrlFeedback);

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (extractController) return;
  const url = normalizeUrl(input.value);
  if (!url) {
    show("Masukkan tautan media terlebih dahulu.", "error");
    return;
  }
  input.value = url;
  results.hidden = true;
  message.className = "message";
  bump("total");
  start();
  extractController = new AbortController();
  const requestTimeout = setTimeout(() => extractController.abort(), 60_000);
  const profile = mode === "profile" || isProfileUrl(url);
  try {
    const response = await fetch(profile ? "/api/profile" : "/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profile ? { url, limit: 24 } : { url, mode }),
      signal: extractController.signal
    });
    const body = await readApiResponse(response);
    data = body;
    index = 0;
    profileUrl = url;
    profileOffset = body.pagination?.offset ?? 0;
    profileHasMore = Boolean(body.pagination?.hasMore);
    render();
    bump("success");
    bumpPlatform(body.platform);
    show(`${body.items.length} media berhasil diekstrak.`, "success");
    results.scrollIntoView({ behavior: "smooth" });
  } catch (error) {
    bump("failed");
    show(error.name === "AbortError" ? "Permintaan terlalu lama. Coba lagi." : error.message || "Ekstraksi gagal.", "error");
  } finally {
    clearTimeout(requestTimeout);
    extractController = null;
    stop();
  }
});

async function loadMoreProfile() {
  if (profileLoading || !profileHasMore) return;
  profileLoading = true;
  const btn = results.querySelector(".load-more");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Memuat...";
  }
  try {
    const url = profileUrl || input.value || (data.author ? `https://www.tiktok.com/@${encodeURIComponent(data.author)}/` : "");
    if (!url) throw new Error("URL profil tidak tersedia.");
    const response = await fetch("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, limit: 24, offset: profileOffset + 24 })
    });
    const body = await readApiResponse(response);
    const seen = new Set(data.items.map(item => item.id || item.url));
    const added = body.items.filter(item => !seen.has(item.id || item.url));
    data.items.push(...added);
    data.pagination = body.pagination;
    profileOffset = body.pagination?.offset ?? profileOffset + 24;
    profileHasMore = Boolean(body.pagination?.hasMore);
    render();
    show(`${data.items.length} media ditampilkan.`, "success");
  } catch (error) {
    show(error.message || "Gagal memuat media berikutnya.", "error");
  } finally {
    profileLoading = false;
  }
}

document.addEventListener("keydown", event => {
  if (event.key === "Escape") closeModal();
});

renderStats();
