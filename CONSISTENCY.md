# Aturan Konsistensi ReSo — Tampilan & Respon

> Standar hidup untuk audit dan perbaikan lintas platform (Facebook, TikTok, Instagram).
> Setiap audit berikutnya (FB/TT/IG) wajib diperiksa terhadap dokumen ini; perbaikan apa pun
> harus membuat ketiga platform makin identik, bukan makin berbeda.
> Terakhir diperbarui: v1.0.30 (audit pertama: Instagram).

---

## 1. Prinsip Tampilan (Design System)

### 1.1 Gaya global
- **Flat & minimal.** Tidak ada gradien statis pada header/panel. Satu-satunya gradien yang
  dibolehkan adalah *shimmer* saat status `running` (efek gerak, bukan gaya statis).
- Ikon = **Material Symbols Rounded** (Google), kelas `.rs-ic`. Tombol ikon-only wajib punya
  `title` + `aria-label` (dan `aria-pressed` untuk toggle).
- Panel **default tertutup** di ketiga platform (tidak mengambang menutupi halaman saat scroll).
  Entry point universal = **FAB** (ikon `forum`) dengan badge jumlah hasil. Ekstra entry point
  (mis. chip di bar Like FB) hanya boleh "buka panel" — tidak boleh langsung proses/copy.

### 1.2 Token — wajib identik di 3 CSS panel
`--rs-bg, --rs-card, --rs-text, --rs-muted, --rs-line, --rs-danger, --rs-warn-bg, --rs-warn-text,
--rs-ok-bg, --rs-ok-text, --rs-font, --rs-radius, --rs-radius-sm, --rs-shadow, --rs-ease,
--rs-ease-2, --rs-dur-fast, --rs-dur, --rs-dur-slow`.

Yang **boleh berbeda** (identitas brand platform):
- `--rs-accent` (warna utama: FB `#1877f2`, TT `#fe2c55`, IG `#e1306c`)
- `--rs-accent-2` + `--rs-on-accent-2` (warna "sukses/siap" per platform)

### 1.3 Struktur panel — urutan wajib identik
```
header  : logo-ic (ikon platform) · title · tombol min (close)
body    : status → hint → count → badge API → check "Balasan" →
          tools (search · sort) → list (preview) → actions
actions : process (play_arrow) · stop · copy (content_copy) · csv (download) ·
          reset (restart_alt) · merge (merge_type)   [grid 3 kolom]
FAB     : forum + data-count badge
```
- Ikon tombol aksi **tidak boleh beda urutan/lambang** antar platform.
- Count: angka besar + kata kecil ("0 nama" / "0 username"); saat filter aktif tampilkan
  "X dari N <kata>".
- Badge API: ikon `check_circle` + "Siap" / `error` + "Belum", kelas `-ok`/`-warn`.

### 1.4 Warna status — identik lintas platform
| Status | Count | Catatan |
|---|---|---|
| idle | accent | — |
| running | accent + animasi breathe | shimmer di tombol process, blink di status |
| done | accent-2 | FAB jadi accent-2 + badge jumlah |
| partial | `#f7b928` | FAB accent-2 bila ada hasil |
| stopped | accent | FAB accent-2 bila ada hasil |
| error | danger (teks status) | — |

### 1.5 Gerak (motion)
- Token durasi/easing dari `--rs-*` (fast 140ms / normal 220ms / slow 320ms,
  `--rs-ease: cubic-bezier(0.22,1,0.36,1)`).
- Panel keluar: fade + translateY(10px) scale(0.98) via `visibility`/`opacity` (jangan `display:none`
  langsung — hilangkan transisi).
- `prefers-reduced-motion: reduce` wajib dinonaktifkan di ketiga CSS.
- Dark mode: `@media (prefers-color-scheme: dark)` + override `data-rs-theme` (dari Options).

---

## 2. Prinsip Respon (Perilaku & Pesan)

### 2.1 Pesan akhir run — SATU sumber
- Semua pesan terminal (done/partial/stopped/error/rate_limit/blocked/checkpoint/…) lewat
  `doneMessage(reason, count, platform, {extra, tip})` — blok marker **DONEMSG**.
  `reasonToMessage` di background hanya mendelegasikan ke fungsi yang sama.
- Kata hasil: IG = **username**, FB/TT = **nama**.
- Copy/CSV/merge wajib menghormati filter aktif (`vis.length`, bukan `names.length`).

### 2.2 stopReason & status akhir — matriks tunggal
- Kumpulan reason: `complete, idle, stopped, timeout, rate_limit, blocked, checkpoint,
  no_template, no_video, no_login, no_media, error`.
- Pemetaan status (harus sama di `statusFromReason` background, `mapDone` panel, dan CSS):
  - `stopped` → stopped · `timeout` → partial
  - `rate_limit` / `blocked` / `checkpoint` → partial bila ada hasil, error bila kosong
  - `error, no_template, no_video, no_login, no_media` → error
  - `complete` / `idle` → done bila ada hasil, error bila kosong
- Setiap platform wajib memetakan **semua reason yang bisa dikeluarkan engine-nya**.
- Pesan `rate_limit`/`blocked`/`checkpoint` harus menyebut jumlah hasil bila ada + tindakan
  yang jelas (tunggu / selesaikan verifikasi / login).

### 2.3 Badge API — selalu akurat
- Arti badge: "engine siap tanpa capture manual".
  - FB: URL adalah permalink post yang didukung (**FBURLS** → `isFacebookPostPage`).
  - TT/IG: template API valid (TTL + shape) — **GET_TEMPLATE**; TT memfilter `awemeId`.
- Panel wajib re-validasi di `storage.onChanged` lewat `refreshTemplateFlag()`
  (GET_TEMPLATE/GET_STATE), **jangan pernah percaya nilai mentah** session storage.
- IG: keterbatasan diketahui — badge tidak bisa cek same-media (media id tidak tersedia di
  content script); mitigasi: engine menulis ulang media_id dari halaman saat replay.

### 2.4 Gagal cepat sebelum run (pre-check)
- Login: `CHECK_IG_LOGIN` / `CHECK_TT_LOGIN` (cookie `sessionid`) sebelum `START`.
- Halaman: shortcode (`/p/`, `/reel/`) IG · `aweme_id` TT · feedback id FBURLS.
- Pesan pre-check: `no_login` / `no_media` / `no_video` via `doneMessage` — jangan biarkan
  run berjalan sia-sia.

### 2.5 Ketahanan engine — pola baku
- Backoff 429: hormati `Retry-After` (cap ~30 dtk), eskalasi 8s→16s, maks 2 retry, hanya bila
  sisa waktu run cukup; heartbeat PROGRESS selama menunggu.
- Retry jaringan (TypeError): 1× cepat.
- Diagnosis akurat, jangan menyesatkan:
  - 403 ≠ "login" → `blocked` (anti-bot/App-ID)
  - `PleaseWaitFewMinutes` / `FeedbackRequired` / `checkpoint` → reason masing-masing
  - Sesi berakhir → redirect halaman login HTML → `no_login` (jangan dump HTML/JSON ke user)
- Cooldown antar-run + pacing antarpage (platform rapuh = lebih lambat).
- Budget request per-run (top-level + balasan terpisah; balasan tidak boleh memakan jatah
  pagination top-level).

### 2.6 Model interaksi
- Klik FAB / chip = **buka panel** saja (tidak memulai proses).
- Esc / tombol min = tutup panel. Panel tidak pernah auto-buka sendiri.
- Selama `running`: tombol process → spinner (`progress_activity`), tombol stop muncul,
  FAB berdenyut; status "Menghentikan…" saat stop ditekan.
- Toggle "Sertakan balasan": menyimpan pref seketika (`SET_STATE`) di popup &
  ketiga panel — default per platform FB on / TT-IG off (dapat diubah di Options).
- Indikator status `stopped` → accent (count) + FAB hijau bila ada hasil
  (konsisten popup ↔ panel; jangan memakai amber seperti partial).
- Prefix hint target seragam: `Target: …` di semua panel & popup (jangan
  `Video:`/`Post:` sendiri-sendiri).

---

## 3. Aturan Kode (Anti-Drift)

1. **Blok marker = satu sumber.** `NORMALIZE, DONEMSG, PARSERS, PANELTOOLS, FBURLS` di shared.js
   disalin byte-identik ke file yang memakainya. Setiap perubahan blok = update SEMUA salinan +
   fixture test (`tests/normalization-fixture.test.mjs`) — parity wajib hijau.
2. **Di luar blok marker**, perubahan UI kecil dilakukan di ketiga salinan content-*.js/css dalam
   satu commit; jangan biarkan satu platform tertinggal (contoh nyata: header gradien FB/TT
   yang lolos dari redesign flat v1.0.29).
3. **Hapus kode mati** saat refactor (contoh: `userCollapsed` di content-fb.js yang tidak lagi
   dibaca setelah panel berhenti auto-buka).
4. **Komentar harus jujur**: jangan klaim perilaku yang tidak ada (contoh basi: komentar
   "expanded saat ada hasil" di TT/IG setelah v1.0.29).
5. Penamaan fungsi render diseragamkan ke **`render()`** (FB `renderUi` → dipakai sebagai
   pengecualian historis; kode baru wajib `render()`).
6. Nama field state: `postHint` (FB/IG) vs `videoHint` (TT) — dibiarkan karena sudah teruji,
   tapi kode baru wajib memakai nama sesuai platform-nya dan tidak mencampur keduanya.

---

## 4. Checklist Audit Platform (dipakai audit IG pertama dst.)

| Area | Periksa |
|---|---|
| Panel | Struktur/urutan/ikon/token identik vs 2 platform lain; FAB; default tertutup |
| CSS | Flat (tanpa gradien statis); token sama; dark mode; reduced-motion |
| Badge | Akurat (TTL+shape / URL); re-validasi di onChanged; tidak percaya nilai mentah |
| Engine | Budget; backoff 429; retry; pacing; stopReason lengkap; diagnosis error akurat |
| Pesan | Semua reason via doneMessage; kata platform-aware; copy/csv hormati filter |
| Pre-check | Login + halaman sebelum START; pesan no_login/no_media/no_video |
| Popup | Parity badge/count/aksi/hint dengan panel |
| Test | `npm run check` · `npm test` · `npm run build`; fixture parity hijau |

---

## 5. Status Konsistensi per Platform (v1.0.30)

| Area | FB | TT | IG |
|---|---|---|---|
| Panel flat minimal + FAB + default tertutup | ✅ | ✅ | ✅ |
| Header flat (tanpa gradien) | ✅ v1.0.30 | ✅ v1.0.30 | ✅ |
| Blok marker (NORMALIZE/DONEMSG/PARSERS/PANELTOOLS/FBURLS) | ✅ | ✅ | ✅ |
| Badge API akurat (re-validasi onChanged) | ✅ URL | ✅ awemeId | ✅ TTL+shape* |
| Pre-check login (cookie) | ✅ c_user v1.0.31 | ✅ sessionid | ✅ sessionid |
| Cooldown antar-run + anti rate-limit | ✅ v1.0.31 | ✅ v1.0.31 | ✅ |
| Pre-check halaman | ✅ FBURLS | ✅ aweme_id | ✅ shortcode |
| Backoff 429 + retry jaringan + budget | ✅ | ✅ | ✅ |
| Diagnosis error akurat (403/checkpoint/PleaseWait) | — (tidak relevan) | ✅ | ✅ |
| Deteksi halaman login HTML → no_login | ✅ redirect+HTML | ✅ v1.0.32 | ✅ v1.0.30 |
| Kode mati / komentar basi dibersihkan | ✅ v1.0.30 | ✅ v1.0.30 | ✅ v1.0.30 |

\* IG: badge tidak bisa memverifikasi kesamaan media (media id tidak tersedia di content script);
  mitigasi engine menulis ulang media_id dari halaman saat replay.
