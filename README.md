# ReSo Ekstention

Ekstensi Chrome (Manifest V3) untuk **mengambil nama komentator dari Facebook, TikTok & Instagram**, lalu menyalinnya ke clipboard — siap di-paste ke Excel (1 nama per baris).

Tanpa dependensi, tanpa backend, tanpa API key. Semua berjalan di browser Anda.

## Fitur

- 📘 **Facebook** — ekstrak nama komentator dari postingan (permalink), termasuk balasan (reply) bila diaktifkan.
- 🎵 **TikTok** — ekstrak nickname komentator dari video, termasuk balasan bila diaktifkan.
- 📸 **Instagram** — ekstrak **username** komentator (mis. `user123`, tanpa `@`) dari post & reel. **Wajib login IG** di browser (paling rapuh dari ketiga platform — gunakan dengan hati-hati).
- 🔄 **Deduplikasi otomatis** — nama yang sama (besar/kecil huruf) hanya dihitung sekali.
- 🧹 **Filter pintar** — buang label UI ("Like", "Komentar", "Follow"), timestamp ("2 jam yang lalu", "5h"), URL, dan noise lain.
- 📋 **Copy sekali klik** — hasil langsung siap tempel di Excel/Spreadsheet.
- 📥 **Ekspor CSV** — simpan hasil ke file `.csv` siap Excel (UTF-8 + BOM).
- 🔀 **Gabung Semua** — gabungkan nama unik dari Facebook + TikTok + Instagram sekali klik.
- 💾 **Tersimpan lintas sesi** — hasil & preferensi tidak hilang saat browser ditutup.
- ⚡ **Facebook tanpa scroll** — replay GraphQL pagination otomatis; query dibangun langsung dari ID postingan bila belum ada capture, jadi tidak perlu buka/scroll semua komentar dulu.
- 🛡️ **Proteksi rate-limit, sesi & checkpoint (FB + IG)** — backoff adaptif saat HTTP 429 (mengikuti `Retry-After`), deteksi sesi tidak aktif (FB redirect login) & checkpoint (IG) dengan pesan jelas, batas request per run (top-level + balasan), retry halaman kosong, dan penghentian aman saat akun butuh verifikasi.
- ⚙️ **Halaman Pengaturan** — default "sertakan balasan" per platform + pilih tema (Sistem/Terang/Gelap) untuk popup & semua panel.
- 🌗 Mendukung mode gelap; antarmuka bahasa Indonesia.

## Cara Pasang (Load Unpacked)

1. Buka `chrome://extensions`.
2. Aktifkan **Developer mode** (pojok kanan atas).
3. Klik **Load unpacked** → pilih folder proyek ini (root, atau folder `dist/` hasil build).
4. Ekstensi **ReSo Ekstention** siap dipakai di toolbar.

## Cara Pakai

### Facebook
1. Buka **1 postingan** (permalink), bukan home feed.
2. Pastikan komentar terlihat, lalu buka panel (tombol N di pojok kanan-bawah atau ikon N di bar Like/Comment/Share) dan klik **Proses**. Badge "API komentar: siap" di panel/popup muncul saat berada di halaman post permalink.
3. Tunggu hingga selesai / partial, lalu **Copy nama**.
4. Paste di Excel — 1 nama per baris.

> ⚙️ Saat FB membatasi request (HTTP 429), engine menunggu sejenak lalu lanjut (backoff).
> Jika sesi tidak aktif, run berhenti aman dengan pesan "Sesi Facebook tidak aktif…" —
> login di facebook.com lalu Proses lagi.

### TikTok
1. Buka **1 video** (URL berisi `/video/...`), bukan feed For You saja.
2. Klik ikon **komentar** sampai daftar komentar muncul (badge *"API komentar: siap"*).
3. Klik **Proses**, tunggu selesai, lalu **Copy nama**.

> ⚙️ Saat TikTok membatasi request (HTTP 429), engine menunggu sejenak lalu lanjut (backoff).
> Jika sesi tidak aktif (401), run berhenti aman dengan pesan "Sesi TikTok tidak aktif…" —
> login di tiktok.com lalu Proses lagi. Balasan dibatasi 40 request/run agar akun aman.
> Sejak v1.0.18 ada **pre-check login**: tanpa sesi tiktok.com, Proses gagal cepat dengan pesan tersebut (pola Instagram).

### Instagram
1. **Login Instagram** di browser ini (wajib — tanpa sesi, komentar tidak bisa dimuat).
2. Buka **1 post/reel** (URL `/p/...` atau `/reel/...`), klik ikon **komentar** sampai list muncul.
3. Klik **Proses**, tunggu selesai, lalu **Copy username** — hasil adalah username IG tanpa `@`.
4. ⚠️ Instagram paling rentan rate-limit/checkpoint — ekstensi menunggu (backoff) saat 429, berhenti aman saat akun butuh verifikasi ("checkpoint"), saat IG meminta jeda ("Please wait…") atau membatasi akun ("FeedbackRequired"), dan saat permintaan diblokir anti-bot (HTTP 403 — diagnosis akurat, bukan keliru bilang "login"). Replay selalu menyasar post yang sedang dibuka (media_id ditulis ulang dari halaman); endpoint balasan punya fallback `child_comments/`; request menyertakan header `X-IG-WWW-Claim` seperti web IG asli. Ada **cooldown antar-run** (15 dtk, 60 dtk setelah rate limit) agar Proses beruntun tidak memicu checkpoint. Template komentar tidak lagi tertimpa post lain saat run aktif (guard mid-run), dan popup kini konsisten memakai kata "username".

## Pengaturan (Options)

Buka lewat **tombol ⚙ di popup**, atau `chrome://extensions` → **Details** → **Extension options**.

- **Default "Sertakan balasan"** — set nilai awal checkbox reply untuk Facebook, TikTok, dan Instagram (dipakai popup, panel halaman, shortcut, dan menu klik kanan).
- **Tema** — Sistem (ikut perangkat), Terang, atau Gelap; berlaku langsung di popup & panel tanpa reload.

## Struktur Proyek

```
manifest.json          Definisi ekstensi MV3 (izin, host, content scripts)
background.js          Service worker: router pesan, state, injeksi engine
shared.js              Helper murni (normalisasi nama, deteksi platform, state, pesan doneMessage)
content-fb.js / .css   UI + jembatan di halaman Facebook
content-tiktok.js/.css UI + jembatan di halaman TikTok
content-ig.js / .css  UI + jembatan di halaman Instagram
inject-fb.js           Mesin ekstraksi FB (MAIN world) — pagination GraphQL + fallback DOM
inject-tiktok.js       Mesin ekstraksi TikTok (MAIN world) — replay API komentar + fallback DOM
inject-ig.js           Mesin ekstraksi Instagram (MAIN world) — replay API komentar + fallback DOM
popup.html / popup.js / popup.css   Popup toolbar
options.html / .css / .js   Halaman pengaturan (default balasan + tema)
icons/                 Ikon ekstensi (16/48/128)
tests/                 Unit test + fixture parity (zero dependency, Node bawaan)
```

Arsitektur 3 lapisan per platform: **background** (kontrol/state) → **content script** (UI + jembatan) → **engine MAIN world** (ekstraksi). Kontrol dipisahkan dari data: perintah lewat `chrome.scripting.executeScript`, hasil lewat `postMessage` yang divalidasi.

Hasil akhir & preferensi disimpan di `chrome.storage.local` (tahan browser restart); state berjalan sementara di `chrome.storage.session`.

Lihat [`CHANGELOG.md`](./CHANGELOG.md) untuk riwayat versi, dan [`RESEARCH.md`](./RESEARCH.md) untuk riset platform (Facebook, TikTok, Instagram) — batas komentar/like, kebutuan login, dan peta implementasi.

## Pengembangan

```bash
npm test    # jalankan unit test (node --test, tanpa dependensi)
npm run check   # validasi sintaks semua file JS
npm run build   # rakit bundle loadable ke dist/
```

> Catatan: `npm install` tidak diperlukan — proyek tanpa dependensi runtime maupun dev.
> Logika yang dibagi antar-world dipusatkan di `shared.js` dalam blok marker
> `BEGIN/END-RESO-*`: normalisasi nama (`NORMALIZE`) dan pesan akhir run (`DONEMSG`).
> **Fixture test** (`tests/normalization-fixture.test.mjs`) memastikan semua salinan di
> engine (MAIN world) dan content scripts tetap byte-identik — melanggar aturan ini
> membuat `npm test` gagal.
> Pesan yang sama untuk popup & panel dihasilkan oleh satu helper `doneMessage`
> (`reasonToMessage` di background hanya mendelegasikannya), jadi tidak ada drift
> kata/kalimat antar permukaan.

## Paket untuk Chrome Web Store

```bash
npm run build
cd dist && zip -r ../reso-ekstention.zip .   # lalu unggah zip ke Web Store
```

## Disclaimer

Ekstraksi data komentar publik berjalan langsung di halaman dan bergantung pada struktur DOM/API Facebook, TikTok & Instagram yang dapat berubah sewaktu-waktu. Instagram wajib login dan paling rentan terhadap rate-limit/checkpoint akun — gunakan dengan bijak untuk data yang Anda berhak akses, dan patuhi ketentuan layanan platform serta kebijakan Chrome Web Store.
