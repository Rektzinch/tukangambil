"use strict";

document.documentElement.classList.add("js");

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
const loader = document.querySelector("#loader");
const loaderText = document.querySelector("#loaderText");
const toast = document.querySelector("#toast");
const profileNotice = document.querySelector("#profileNotice");
const clearBtn = document.querySelector("#clearBtn");
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
let profileOrder = "newest";
let toastTimer = null;

const revealObserver = "IntersectionObserver" in window
  ? new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        revealObserver.unobserve(entry.target);
      });
    }, { threshold: 0.14 })
  : null;

const statsKey = "tukangambil:stats:v2";
let stats = loadStats();

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[char]);
}

function observeReveals(root = document) {
  root.querySelectorAll(".reveal-on-scroll:not(.is-visible)").forEach(element => {
    if (revealObserver) revealObserver.observe(element);
    else element.classList.add("is-visible");
  });
}

function dismissToast() {
  if (!toast) return;
  clearTimeout(toastTimer);
  toastTimer = null;
  toast.className = "toast";
  toast.hidden = true;
  delete toast.dataset.state;
}

function showToast(text, type = "info", duration = 4200) {
  if (!toast) return;
  clearTimeout(toastTimer);
  toast.textContent = text;
  toast.className = `toast show ${type}`;
  toast.hidden = false;
  toast.dataset.state = type;
  if (duration > 0) toastTimer = setTimeout(dismissToast, duration);
}

function closeProfileNotice() {
  if (!profileNotice?.hasAttribute("open")) return;
  if (typeof profileNotice.close === "function") profileNotice.close();
  else profileNotice.removeAttribute("open");
  document.body.style.overflow = "";
}

function openProfileNotice() {
  if (!profileNotice || profileNotice.hasAttribute("open")) return;
  if (typeof profileNotice.showModal === "function") profileNotice.showModal();
  else profileNotice.setAttribute("open", "");
  document.body.style.overflow = "hidden";
  profileNotice.querySelector("button")?.focus();
}

function showLoader(text) {
  if (!loader) return;
  loaderText.textContent = text || "Memuat media…";
  loader.hidden = false;
  showToast(loaderText.textContent, "loading", 0);
}

function hideLoader() {
  if (!loader) return;
  loader.hidden = true;
  if (toast?.dataset.state === "loading") dismissToast();
}

function formatCount(value) {
  const n = Number(value) || 0;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}M`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}jt`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}rb`;
  return String(n);
}

function formatMediaDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "short", year: "numeric" }).format(date);
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
  showToast(text, type);
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
  if (clearBtn) clearBtn.disabled = !input.value.trim();
  const platform = platformFromUrl(input.value);
  if (mode === "profile") {
    formHint.classList.add("detected");
    formHintIcon.textContent = "✓";
    formHintText.textContent = "Mode Media Profil aktif. Masukkan tautan profil publik TikTok, Instagram, Facebook, Threads, atau X.";
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
  showLoader(mode === "profile" ? "Mengambil media profil…" : "Mengekstrak media…");
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
  hideLoader();
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

function avatarUrl(item) {
  if (!item?.avatar) return "";
  const query = new URLSearchParams({ url: item.avatar, filename: "avatar.jpg", preview: "1" });
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
    const error = new Error(body.error || `Server gagal memproses permintaan (${response.status}).`);
    error.status = response.status;
    error.code = body.code;
    throw error;
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

function getModal() {
  let modal = document.querySelector(".modal");
  if (modal) return modal;
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
  return modal;
}

async function openHdModal(i, button) {
  modalReturnFocus = button;
  const source = data.items?.[i];
  if (!source?.sourceUrl) {
    show("Tautan sumber versi HD tidak tersedia untuk media ini.", "error");
    return;
  }
  const modal = getModal();
  modal.querySelector(".modal-top b").textContent = "Versi HD";
  modal.querySelector(".modal-content").innerHTML = '<div class="hd-loading"><span class="spinner" aria-hidden="true"></span> Mencari versi HD…</div>';
  modal.hidden = false;
  document.body.style.overflow = "hidden";
  try {
    const response = await fetch("/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: source.sourceUrl, mode: "auto" })
    });
    const body = await readApiResponse(response);
    const item = body.items?.[0];
    if (!item) throw new Error("Versi HD tidak ditemukan.");
    const meta = `<div class="badges"><span class="badge">${escapeHtml(body.platform || "media")}</span><span class="badge">${escapeHtml(item.type)}</span><span class="badge badge-quality${item.bestQuality ? " best" : ""}">${escapeHtml(item.quality || "HD")}</span>${item.size ? `<span class="badge badge-muted">${escapeHtml(item.size)}</span>` : ""}</div>`;
    modal.querySelector(".modal-content").innerHTML = `<div class="preview">${preview(item)}</div><div class="meta"><div class="badges">${meta}</div><h2>${escapeHtml(body.title || item.filename)}</h2><p>${escapeHtml(body.author || "")}</p><a class="download" data-dl="0" href="${escapeHtml(mediaUrl(item))}">Download versi HD</a></div>`;
    bindDownloads(modal, [item]);
  } catch (error) {
    modal.querySelector(".modal-content").innerHTML = `<div class="message error show">${escapeHtml(error.message)}</div>`;
  }
}

function openModal(i, button) {
  modalReturnFocus = button;
  const item = data.items[i];
  const modal = getModal();
  modal.querySelector(".modal-top b").textContent = `${i + 1} / ${data.items.length}`;
  modal.querySelector(".modal-content").innerHTML = `<div class="preview">${preview(item)}</div><div class="meta"><h2>${escapeHtml(item.filename)}</h2><a class="download" href="${escapeHtml(mediaUrl(item))}" data-dl="${i}">Download media ini</a></div>`;
  bindDownloads(modal, [...data.items]);
  modal.hidden = false;
  document.body.style.overflow = "hidden";
  modal.querySelector("button").focus();
}

async function downloadAll() {
  const available = data.items.filter(item => item.available !== false);
  if (!available.length) {
    show("Tidak ada media yang dapat diunduh.", "error");
    return;
  }
  show("Browser akan memulai unduhan satu per satu. Izinkan multiple downloads bila diminta.");
  for (const item of available) {
    const anchor = document.createElement("a");
    anchor.href = mediaUrl(item);
    anchor.download = item.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    await new Promise(resolve => setTimeout(resolve, 450));
  }
}

function render() {
  const profile = data.profile;
  const isProfileCollection = data.resourceKind === "profile" || Boolean(profile);
  const isCollection = isProfileCollection || Boolean(data.collection) || data.items.length > 2;
  if (isCollection) {
    const collectionWarnings = data.warnings?.length ? `<div class="message show">${data.warnings.map(escapeHtml).join(" · ")}</div>` : "";
    const loadMore = profileHasMore ? `<button class="load-more" type="button">Muat lebih banyak</button>` : "";
    const orderControl = isProfileCollection ? `<div class="order-control" role="group" aria-label="Urutkan media"><span>Urutkan media</span><div class="order-options"><button type="button" data-order="newest" aria-pressed="${profileOrder === "newest"}">Terbaru</button><button type="button" data-order="oldest" aria-pressed="${profileOrder === "oldest"}">Terlama</button></div></div>` : "";
    const profileCard = profile ? `<div class="profile-card"><div class="profile-avatar">${profile.avatar ? `<img src="${escapeHtml(avatarUrl(profile))}" alt="Avatar ${escapeHtml(profile.username)}">` : `<span>${escapeHtml((profile.username || "?")[0].toUpperCase())}</span>`}</div><div class="profile-main"><h2>${escapeHtml(profile.nickname || "")}</h2><p class="profile-handle">@${escapeHtml(profile.username || "")}</p>${profile.bio ? `<p class="profile-bio">${escapeHtml(profile.bio)}</p>` : ""}<div class="profile-stats"><span><b>${formatCount(profile.followers)}</b><small>Pengikut</small></span><span><b>${formatCount(profile.following)}</b><small>Mengikuti</small></span><span><b>${formatCount(profile.mediaCount)}</b><small>Media</small></span><span><b>${formatCount(profile.likes)}</b><small>Suka</small></span></div></div></div>` : "";
    results.innerHTML = `<div class="results-title"><span>${escapeHtml(data.title)}</span><b>${data.items.length} media</b></div><section class="collection"><div class="collection-head"><div class="collection-title"><div><h2>${escapeHtml(data.title)}</h2><p>${escapeHtml(data.author || "")}</p></div>${orderControl}</div>${collectionWarnings}<button class="download-all" type="button">Download semua media</button></div>${profileCard}<div class="grid">${data.items.map((item, i) => { const date = formatMediaDate(item.publishedAt); return `<article class="tile${item.available === false ? " unavailable" : ""}"><div class="tile-media">${item.type === "image" ? `<img src="${escapeHtml(mediaUrl(item, true))}" alt="${escapeHtml(item.filename)}" loading="lazy" decoding="async">` : item.thumb ? `<img src="${escapeHtml(thumbUrl(item))}" alt="Thumbnail ${escapeHtml(item.filename)}" loading="lazy" decoding="async">` : `<span>${item.type.toUpperCase()}</span>`}</div><div class="tile-badges"><span class="badge">${escapeHtml(data.platform)}</span><span class="badge">${escapeHtml(item.type)}</span>${item.quality ? `<span class="badge badge-quality${item.bestQuality ? " best" : ""}">${escapeHtml(item.quality)}</span>` : ""}${item.size ? `<span class="badge badge-muted">${escapeHtml(item.size)}</span>` : ""}${item.available === false ? '<span class="badge badge-muted">Tidak tersedia</span>' : ""}</div>${date ? `<time class="tile-date" datetime="${escapeHtml(item.publishedAt)}">${escapeHtml(date)}</time>` : ""}<h3>${escapeHtml(item.filename)}</h3><div class="tile-actions">${item.available === false ? '<span class="tile-note">Media tidak dapat diunduh</span>' : `<button class="preview-btn" data-preview="${i}" type="button">Preview</button><button class="hd-btn" data-hd="${i}" type="button">Versi HD</button>`}</div></article>`; }).join("")}</div>${loadMore}</section><div class="download-all-sticky"><button class="download-all" type="button">Download semua media</button></div>`;
    results.querySelectorAll("[data-preview]").forEach(button => button.addEventListener("click", () => openModal(Number(button.dataset.preview), button)));
    results.querySelectorAll("[data-hd]").forEach(button => button.addEventListener("click", () => openHdModal(Number(button.dataset.hd), button)));
    results.querySelectorAll(".download-all").forEach(button => button.addEventListener("click", () => downloadAll()));
    const loadMoreBtn = results.querySelector(".load-more");
    if (loadMoreBtn) loadMoreBtn.addEventListener("click", () => loadMoreProfile());
    const orderButtons = [...results.querySelectorAll("[data-order]")];
    orderButtons.forEach(button => button.addEventListener("click", () => reloadProfileOrder(button.dataset.order, orderButtons)));
  } else {
    const item = data.items[index];
    results.innerHTML = `<div class="results-title"><span>${escapeHtml(data.resourceKind || "media")} · media</span><b>${index + 1}/${data.items.length}</b></div><section class="card"><div class="preview">${preview(item)}</div><div class="meta"><div class="badges"><span class="badge">${escapeHtml(data.platform)}</span><span class="badge">${escapeHtml(item.type)}</span><span class="badge${item.bestQuality ? " badge-quality best" : ""}">${escapeHtml(item.quality)}</span>${item.size ? `<span class="badge badge-muted">${escapeHtml(item.size)}</span>` : ""}</div><h2>${escapeHtml(data.title)}</h2><p>${escapeHtml(data.author || "")}</p>${data.warnings?.length ? `<p>${data.warnings.map(escapeHtml).join(" · ")}</p>` : ""}<a class="download" data-dl="${index}" href="${escapeHtml(mediaUrl(item))}">Download media ini</a>${data.items.length > 1 ? '<div class="nav"><button data-nav="prev">Sebelumnya</button><button data-nav="next">Berikutnya</button></div>' : ""}</div></section>`;
    results.querySelectorAll("[data-nav]").forEach(button => button.addEventListener("click", () => {
      index = button.dataset.nav === "next" ? (index + 1) % data.items.length : (index - 1 + data.items.length) % data.items.length;
      render();
      show(`Media ${index + 1} dari ${data.items.length} ditampilkan.`);
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
  show(`Mode ${button.querySelector("b")?.textContent || mode} dipilih.`);
}));

pasteBtn.addEventListener("click", async () => {
  try {
    input.value = await navigator.clipboard.readText();
    updateUrlFeedback();
    pasteBtn.firstChild.textContent = "Ditempel ";
    setTimeout(() => { pasteBtn.firstChild.textContent = "Tempel "; }, 1400);
    show("Tautan berhasil ditempel.", "success");
    input.focus();
  } catch {
    show("Izin clipboard tidak tersedia.", "error");
  }
});

clearBtn?.addEventListener("click", () => {
  input.value = "";
  updateUrlFeedback();
  input.focus();
  show("Tautan dikosongkan.");
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
      body: JSON.stringify(profile ? { url, limit: 24, order: profileOrder } : { url, mode }),
      signal: extractController.signal
    });
    const body = await readApiResponse(response);
    data = body;
    index = 0;
    profileUrl = url;
    profileOffset = body.pagination?.offset ?? 0;
    profileHasMore = Boolean(body.pagination?.hasMore);
    if (profile) profileOrder = body.pagination?.order || profileOrder;
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
    btn.innerHTML = '<span class="spinner" aria-hidden="true"></span> Memuat…';
  }
  showLoader("Memuat media berikutnya…");
  try {
    const url = profileUrl || input.value || (data.author ? `https://www.tiktok.com/@${encodeURIComponent(data.author)}/` : "");
    if (!url) throw new Error("URL profil tidak tersedia.");
    const response = await fetch("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, limit: 24, offset: profileOffset + 24, order: profileOrder })
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
    hideLoader();
    const resetBtn = results.querySelector(".load-more");
    if (resetBtn) {
      resetBtn.disabled = false;
      resetBtn.textContent = "Muat lebih banyak";
    }
  }
}

async function reloadProfileOrder(nextOrder, controls) {
  if (profileLoading || !profileUrl || nextOrder === profileOrder) return;
  const previousOrder = profileOrder;
  profileOrder = nextOrder === "oldest" ? "oldest" : "newest";
  const attemptedOrder = profileOrder;
  profileLoading = true;
  controls.forEach(control => { control.disabled = true; });
  showLoader(profileOrder === "oldest" ? "Mengurutkan dari media terlama…" : "Mengurutkan dari media terbaru…");
  try {
    const response = await fetch("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: profileUrl, limit: 24, offset: 0, order: profileOrder })
    });
    const body = await readApiResponse(response);
    data = body;
    index = 0;
    profileOffset = body.pagination?.offset ?? 0;
    profileHasMore = Boolean(body.pagination?.hasMore);
    profileOrder = body.pagination?.order || profileOrder;
    render();
    show(profileOrder === "oldest" ? "Media diurutkan dari yang paling lama." : "Media diurutkan dari yang paling baru.", "success");
  } catch (error) {
    profileOrder = previousOrder;
    controls.forEach(control => {
      control.disabled = false;
      control.setAttribute("aria-pressed", String(control.dataset.order === previousOrder));
    });
    const count = formatCount(data?.profile?.mediaCount);
    const detail = error.status === 502 && attemptedOrder === "oldest" && count !== "0"
      ? `Profil ini memiliki sekitar ${count} media. Urutan terlama perlu membaca seluruh timeline dan melewati batas waktu server.`
      : error.message || "Gagal mengubah urutan media.";
    show(detail, "error");
  } finally {
    profileLoading = false;
    hideLoader();
  }
}

document.addEventListener("keydown", event => {
  if (event.key === "Escape") closeModal();
});

profileNotice?.querySelectorAll("[data-close-profile-notice]").forEach(button => button.addEventListener("click", closeProfileNotice));
profileNotice?.addEventListener("click", event => {
  if (event.target === profileNotice) closeProfileNotice();
});
profileNotice?.addEventListener("close", () => {
  document.body.style.overflow = "";
});

renderStats();
observeReveals();
updateUrlFeedback();
openProfileNotice();
