# TukangAmbil

Downloader media publik untuk TikTok, Instagram, Facebook, Threads, dan X. Versi 2 memisahkan klasifikasi URL, orkestrasi provider, validasi hasil, serta proxy download agar kegagalan satu platform tidak merusak platform lain.

## Kemampuan

- Posting, Reel, foto, carousel, dan profil publik.
- Story publik TikTok, Instagram, dan Facebook selama masih aktif dan dapat diakses tanpa login; cookie opsional dapat dipasang untuk media yang memang memerlukan sesi pengguna.
- Fallback provider paralel dengan deadline global.
- Pemilihan format progressive yang memiliki video dan audio.
- Prioritas MP4/H.264 untuk mengurangi green screen dan masalah kompatibilitas.
- Download langsung tanpa menampung seluruh file di memori browser.
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
- `DOWNLOAD_TOKEN_SECRET`: secret acak untuk signed download token. Bila tidak tersedia, proxy hanya menerima permintaan same-origin.
- `MAX_DOWNLOAD_BYTES`: batas ukuran unduhan; default 250 MiB.
- `PUBLIC_ORIGIN`: origin produksi opsional.

## Pengembangan

```bash
npm install
npm run verify
npm run build
npx vercel dev
```

Proses instalasi mengunduh binary yt-dlp Linux. Untuk build yang sepenuhnya reproducible, isi `YTDLP_BINARY_URL` dengan URL versi tetap dan `YTDLP_BINARY_SHA256` dengan checksum resminya.

## Catatan batasan

Platform dapat mengubah endpoint, markup, dan aturan login tanpa pemberitahuan. Story bersifat sementara dan sebagian Story publik tetap memerlukan sesi akun karena aturan platform. Health endpoint membedakan kesiapan runtime dari keterjangkauan provider; provider eksternal tidak dianggap sehat hanya karena terkonfigurasi.
