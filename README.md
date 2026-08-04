# TukangAmbil

Downloader media publik untuk TikTok, Instagram, Facebook, Threads, dan X. Versi 2 memisahkan klasifikasi URL, orkestrasi provider, validasi hasil, serta proxy download agar kegagalan satu platform tidak merusak platform lain.

## Kemampuan

- Posting, Reel, foto, carousel, dan profil publik, dengan mode unduhan Video + audio, Gambar, Audio saja, dan Tanpa audio.
- Story publik TikTok, Instagram, dan Facebook selama masih aktif dan dapat diakses tanpa login; cookie opsional dapat dipasang untuk media yang memang memerlukan sesi pengguna.
- Fallback provider paralel dengan deadline global.
- Pemilihan format progressive yang memiliki video dan audio, dengan prioritas **resolusi asli tertinggi** (hingga 4K/super HD sesuai ketersediaan source); MP4/H.264 tetap dipilih saat resolusi sama untuk kompatibilitas pemutar.
- Race provider memakai **jendela kualitas** (±8 detik): hasil cepat tetap dipertimbangkan, tetapi bila provider lain membawa resolusi lebih tinggi dalam jendela itu, hasil tertinggi yang dipakai.
- Untuk TikTok, hasil terbaik diverifikasi **dapat diunduh** server-side; bila stream resolusi tertinggi diblokir tanpa sesi (mis. host `*-webapp-prime` mengembalikan 403), layanan otomatis memakai kualitas publik terbaik yang bisa diunduh dan menambahkan peringatan.
- TikTok memakai MusicalDown sebagai fallback scraping terisolasi. Parser mengikuti nama field form yang dinamis, hanya menerima tautan media dari `fastdl.muscdn.app`, memprioritaskan MP4 HD tanpa watermark, lalu tetap memverifikasi bahwa file dapat diunduh.
- Batas ukuran unduhan default dinaikkan ke **1 GiB** agar video HD/4K tidak tertolak (atur lewat `MAX_DOWNLOAD_BYTES`).
- Download langsung tanpa menampung seluruh file di memori browser.
- Statistik platform populer disimpan lokal di browser pengguna dan tidak dikirim sebagai telemetri server.
- Redirect media divalidasi per-hop, ukuran file dibatasi, dan permintaan dibatasi per IP.
- URL pengguna disanitasi dari log provider.

## Arsitektur dan konfigurasi build

Framework preset Vercel ditetapkan secara eksplisit sebagai **Other** melalui `"framework": null` di `vercel.json`. Proyek ini bukan React, Next.js, Astro, atau framework frontend lain. Arsitekturnya adalah **Vanilla JavaScript + Vercel Node.js Functions**.

Konfigurasi deployment sudah ditentukan di `vercel.json`:

- Install command: `npm install`
- Build command: `npm run build`
- Output directory: `dist`
- Node.js: `24.x`
- API functions: folder `api/`

Script build menyalin aset dari `public/` ke `dist/`, sedangkan Vercel membangun setiap file dalam `api/` sebagai Serverless Function. Saat mengimpor ZIP atau repository ke Vercel, biarkan Framework Preset pada **Other**. Jangan mengirim nilai string `"Other"` atau `"other"` ke properti `framework` di `vercel.json`; Vercel mengharuskan nilai `null` untuk preset ini.

## Environment variables

- `COBALT_API_URL` atau `COBALT_API_URLS`: instance Cobalt opsional.
- `COBALT_API_KEY`: token Cobalt opsional.
- `COBALT_AUTH_SCHEME`: `Api-Key` atau `Bearer`.
- `YTDLP_COOKIES_B64`: cookie Netscape yang di-encode Base64 untuk media yang memerlukan sesi. Jangan gunakan cookie akun utama.
- `YTDLP_BINARY_URL` / `YTDLP_BINARY_SHA256`: saat `YTDLP_BINARY_URL` diisi (pin versi), `YTDLP_BINARY_SHA256` **wajib** diisi; bila tidak, install berhenti dengan error. Tanpa keduanya, binary `latest` dipakai dengan peringatan.
- Contoh lengkap tersedia di `.env.example`.
- `DOWNLOAD_TOKEN_SECRET`: secret acak untuk signed download token. Bila tidak tersedia, proxy hanya menerima permintaan same-origin.
- `MAX_DOWNLOAD_BYTES`: batas ukuran unduhan; default 1 GiB.
- `PUBLIC_ORIGIN`: origin produksi opsional.

## Pengembangan

```bash
npm install
npm run verify
npm run build
npx vercel dev
```

Proses instalasi mengunduh binary yt-dlp Linux. Untuk build yang sepenuhnya reproducible, isi `YTDLP_BINARY_URL` dengan URL versi tetap dan `YTDLP_BINARY_SHA256` dengan checksum resminya; jika hanya salah satunya diisi, install gagal.

## Perlindungan

- Rate limit per IP pada endpoint `/api/extract` (20/menit) dan `/api/download` (40/menit) dengan jendela 60 detik.
- Download media hanya dari daftar host yang diizinkan, dengan redirect divalidasi per-hop, batas ukuran streaming, dan `nosniff`.
- Saat `DOWNLOAD_TOKEN_SECRET` diisi, unduhan memakai token HMAC bertanda tangan dengan masa berlaku 15 menit; tanpa secret, download dibatasi same-origin.
- Header keamanan diterapkan global: CSP, HSTS, `X-Frame-Options: DENY`, COOP/CORP, dan lainnya.
- Health endpoint hanya memaparkan kesiapan runtime, bukan konfigurasi rahasia.

## Catatan batasan

Platform dapat mengubah endpoint, markup, dan aturan login tanpa pemberitahuan. Story bersifat sementara dan sebagian Story publik tetap memerlukan sesi akun karena aturan platform. Health endpoint membedakan kesiapan runtime dari keterjangkauan provider; provider eksternal tidak dianggap sehat hanya karena terkonfigurasi.
