# Changelog

Semua perubahan penting dicatat di sini. Format mengikuti [Keep a Changelog](https://keepachangelog.com/id-ID/1.1.0/), versi mengikuti [Semantic Versioning](https://semver.org/).

## [1.0.37] — 2026-08-13

### Chip di bar Like/Comment Facebook diperbaiki (audit UI pecah)

- **Icon chip diseragamkan ke `forum`** — ikon yang sama dengan FAB (satu entry
  point, design system CONSISTENCY.md 1.1), menggantikan SVG `person` lama.
- **`findActionRow` toleran DOM Facebook baru (2025–2026)** — tombol aksi kini
  bisa ikon-only / tak berlabel di samping kotak komentar; anchor boleh salah
  satu dari Like/Comment/Share (tidak wajib Like pertama), baris cukup memuat
  2+ aksi, dan label dibaca dari teks + `aria-label` + `title`.
- **Chip tidak lagi hilang saat React me-render ulang post** — coalescing
  watcher (tidak di-reset tiap mutasi, tanpa polling) memastikan chip selalu
  terpasang kembali walau halaman bermutasi terus-menerus (buka komentar,
  scroll, like).
- **Chip tidak lagi menggeser/memecah baris aksi** — `order: 99` di flex row
  (selalu paling kanan), dimensi button dikunci (min/max 36px), `box-sizing`
  & `overflow: visible` eksplisit.

## [1.0.36] — 2026-08-11

### Audit hasil v1.0.35 — tutup celah kontaminasi lintas post yang tersisa

- **Temuan audit**: hook fetch/XHR (always-on) mengekstrak nama dari SEMUA
  respons GraphQL selama run berjalan — tanpa filter feedback id. Di feed
  (atau saat user scroll manual), komentar postingan lain yang kebetulan
  dimuat halaman ikut masuk hasil.
- **Perbaikan**: respons halaman hanya diproses bila request-nya membawa
  `feedbackID`/`feedback_id` postingan target — yaitu id dari URL permalink
  atau id template yang sedang di-paginate (`activeFeedbackId`, dikunci saat
  probe memilih template, di-reset tiap run). Request tanpa feedback id
  (balasan, bentuk tak dikenal) tetap diproses — tidak ada regresi ekstraksi.
- Efek: rekap FB kini konsisten anti-kontaminasi di DOM (v1.0.35), buffer
  GraphQL, dan hook jaringan (v1.0.36).

## [1.0.35] — 2026-08-11

### Facebook: mode "Semua Komentar" otomatis + anti scroll ke postingan lain

- **Mode sortir tidak lagi menentukan hasil rekap.** Riset: variabel internal
  `sortKey` query `CometUFICommentsProviderPaginationQuery` memakai enum
  `RANKED_THREADED` (Paling Relevan — default, hanya sebagian komentar),
  `RANKED_UNFILTERED` (Semua Komentar — kronologis, unfiltered),
  `RECENT_ACTIVITY` (Terbaru). Tanpa `sortKey`, FB default ke Paling Relevan
  → itulah kenapa dulu kamu harus pindah ke "Semua Komentar" manual.
- **Synthetic template (dibangun dari URL) kini memuat
  `sortKey: "RANKED_UNFILTERED"`** — langsung paginate semua komentar tanpa
  perlu ganti mode di halaman.
- **Replay template capture di-probe dengan varian "Semua Komentar" dulu**
  (fallback ke mode asli user bila FB menolak) — hasil tidak bergantung pada
  pilihan sortir yang tampil di halaman.
- **Hapus penyebab scroll ke postingan lain di akhir run:**
  `window.scrollBy` di DOM fallback dihapus (scroll hanya kontainer komentar
  dalam post), klik "lihat komentar lain" & panen nama di-scope ke post aktif
  (bukan seluruh dokumen), dan posisi scroll halaman disimpan di awal run lalu
  dikembalikan di akhir (postingan yang kamu proses tetap di tempat).

## [1.0.34] — 2026-08-11

### Audit lintas permukaan — menutup sisa ketidakseragaman

- **Toggle "Balasan" di panel kini menyimpan pref seketika** (SET_STATE) —
  parity dengan popup; sebelumnya pref baru tersimpan saat run dimulai.
- **Prefix hint diseragamkan ke `Target:`** di semua panel & popup (TikTok
  sebelumnya "Video:").
- **Pesan reset/idle disamakan** antara panel dan background (FB: "…1 postingan
  Facebook…"; IG: "…pastikan sudah login, lalu klik Proses.").
- **Dot status "stopped" di popup → accent** (sebelumnya amber seperti partial;
  kini konsisten dengan count panel & FAB hijau).
- **Pembersihan kecil**: attr `checked` mati di checkbox Balasan FB; title tombol
  Gabung popup disamakan dengan panel.
- **RESEARCH.md seksi 16**: temuan ketidakseragaman + daftar perbedaan yang
  sengaja dibiarkan (default includeReplies, backup popup-only, chip FB, dll).

## [1.0.33] — 2026-08-11

### Pacing TikTok disamakan dengan Instagram (keamanan ekstra)

- Jeda antar-halaman komentar TikTok naik dari 0,7–1,6 dtk → **1,8–3,2 dtk**
  (nilai persis Instagram).
- Balasan: 0,4–0,8 dtk → **1,4–2,4 dtk**; jeda antar-thread balasan
  0,3–0,7 dtk → **1,1–2,0 dtk**; retry halaman kosong → **2,5 dtk** (semua
  identik dengan inject-ig.js).
- Percepatan pagination adalah pemicu rate limit — pacing seragam ini
  menurunkan risiko 429/checkpoint di TikTok.
- Catatan: `maxMs` run TikTok tetap 120 dtk (IG 150 dtk) → tiap run lebih
  sedikit halaman; naikkan ke 150 dtk bila ingin coverage setara.

## [1.0.32] — 2026-08-11

### Audit TikTok — konsistensi tuntas di 3 platform

- **Deteksi halaman login HTML di engine TikTok** — sesi berakhir yang
  me-redirect ke halaman login (HTML 200) kini memberi pesan bersih "Sesi
  TikTok tidak aktif (login)" alih-alih dump "Respons bukan JSON:
  <!DOCTYPE html..." (parity IG v1.0.30 / FB redirect+HTML).
- **Sanitasi pesan error non-OK**: `API <status>: …` tidak lagi membocorkan
  HTML mentah — diganti "halaman HTML (kemungkinan login/error)".
- Audit TikTok menyimpulkan platform ini sudah paling selaras dengan
  CONSISTENCY.md (badge awemeId akurat, pre-check, cooldown, backoff, budget,
  stopReason lengkap) — **status konsistensi FB/TT/IG kini penuh** di semua
  area checklist.
- **RESEARCH.md seksi 15**: audit TikTok + rekomendasi terbuka (chip panel,
  pacing).

## [1.0.31] — 2026-08-11

### Audit Facebook — konsistensi dengan standar IG/TK (CONSISTENCY.md)

- **Pre-check login Facebook** (`CHECK_FB_LOGIN`, cookie `c_user`) — pola gagal
  cepat identik dengan IG/TT: logout → pesan no_login sebelum run, bukan
  menunggu probe di tengah run.
- **Cooldown antar-run di Facebook & TikTok** — 15 dtk setelah run apa pun,
  60 dtk setelah rate limit (nilai & pesan identik dengan IG); run beruntun
  tidak lagi jadi pemicu 429.
- **Bug CSS seragam**: `--rs-text-dim` dipakai tapi tak pernah didefinisikan
  di ketiga stylesheet (warna daftar preview jatuh ke warna inherit) →
  `var(--rs-muted)`.
- **`mapDoneStatus` FB**: `no_template` kini dipetakan eksplisit ke error
  (parity pola mapDone IG/TT).
- **Hint panel FB tidak lagi basi**: "Tombol N (pojok kanan)…" (sisa FAB huruf
  pra-v1.0.29) → "Buka permalink post, buka komentar, lalu Proses."; elemen
  count awal `0 nama` (parity struktur TT/IG).
- **RESEARCH.md seksi 14**: audit FB konsistensi + status; CONSISTENCY.md
  diperbarui (pre-check login & cooldown kini ✅ di 3 platform).

## [1.0.30] — 2026-08-11

### Audit pertama Instagram + standar konsistensi tampilan & respon

- **Dokumen baru `CONSISTENCY.md`** — aturan konsistensi tampilan & respon yang
  menjadi standar audit/perbaikan lintas platform (token CSS, struktur panel,
  ikon, warna status, gerak, pesan akhir via DONEMSG, stopReason/status,
  badge akurat, pre-check, ketahanan engine, checklist audit).
- **Header panel FB & TikTok kini flat** — gradien brand yang tersisa dari
  pra-v1.0.29 (`#1877f2`/`#fe2c55`) dihapus; ketiga panel memakai bahasa visual
  yang sama (IG sudah flat).
- **Kode mati dibersihkan**: `userCollapsed` (content-fb.js, tidak pernah dibaca),
  ternary redundan `stopExtract` TikTok, komentar boot basi TT/IG
  ("expanded saat ada hasil" — panel tidak pernah auto-buka sejak v1.0.29).
- **Pesan copy FB dikoreksi**: fallback menyebut `names.length` padahal yang
  disalin `vis.length` (salah saat filter aktif) — kini konsisten dengan TT/IG.
- **Engine IG: deteksi halaman login HTML** — sesi berakhir kini memberi pesan
  bersih "Login Instagram diperlukan (sesi berakhir)" alih-alih dump
  "Respons bukan JSON: <!DOCTYPE html..." (cabang `res.status === 302` selama
  ini dead code karena fetch mengikuti redirect).
- **RESEARCH.md seksi 13**: audit pertama Instagram (temuan diperbaiki, yang
  sudah kuat, yang masih terbuka + verifikasi lapangan yang wajib user).

## [1.0.29] — 2026-08-11

### Desain Flat Minimal — ikon Material (Google), widget default tertutup

- **Ikon Material Symbols (Google)** di semua permukaan — popup, options, dan
  panel FB/TikTok/IG. Tombol aksi jadi ikon (play/stop/copy/download/merge/
  reset/sort/close), indikator status & badge API jadi ikon + kata pendek
  (`check_circle` Siap / `error` Belum), bukan kalimat panjang.
- **Popup minimalis** — header flat, platform + status pakai ikon, count angka
  besar + kata kecil terpisah, grid aksi 4 kolom ikon, search dengan ikon.
- **Panel & FAB flat** — header tanpa gradien (kartu + garis bawah), tombol
  ikon 3 kolom, FAB bulat solid dengan ikon `forum`, checkbox "Balasan"
  ikon `forum` + kata pendek.
- **Widget default TERTUTUP** — panel FB/TikTok/IG tidak lagi mengambang
  terbuka saat halaman dimuat, saat hasil tersimpan dipulihkan, maupun saat
  run selesai. Hasil tetap terlihat di badge jumlah FAB; panel hanya dibuka
  oleh user (klik FAB / ikon bar Like). Sebelumnya: panel TT/IG terbuka sejak
  awal, panel FB otomatis melebar saat ada hasil.
- **Options flat** — header tanpa gradien, ikon platform & tema, tombol
  "Pulihkan default" dengan ikon.

## [1.0.28] — 2026-08-11

### Permalink Facebook lengkap — album/gambar kolektif, watch, video.php, slug-posts

- **Satu sumber deteksi URL permalink (blok `FBURLS`)** — `extractFbFeedbackIds` /
  `extractFbFeedbackId` / `isFacebookPostPage` di `shared.js`, disalin
  byte-identik ke `inject-fb.js` & `content-fb.js`, dijamin fixture test
  (layout + parity 3 salinan + behavior 22 kasus URL). Sebelumnya deteksi URL
  diduplikasi di 3 tempat dengan gap yang sama — badge, synthetic template, dan
  pre-check kini selalu sinkron.
- **Bentuk URL baru yang didukung** (sebelumnya MISS → synthetic GraphQL tidak
  terbentuk): `posts/<slug>/<id>` (post gaya baru), `watch?v=`/`watch/?v=`/
  `watch/live/?v=` (video), `video.php?v=`, `media/set/?set=a.<album>.<user>.<story>`
  (album/gambar kolektif — story id = komponen terakhir), `photos/a.<uid>.<fbid>`
  (album foto), `posts/<pfbid>` (post dengan id alfanumerik), nilai `story_fbid`/`fbid`
  alfanumerik (pfbid).
- **`set=pcb.<story>` (postingan multi-foto) — terverifikasi lapangan**: klik gambar 1
  di post multi-foto menghasilkan URL `facebook.com/photo?fbid=<id foto>&set=pcb.<story id>`.
  Story id dari `pcb.` kini diekstrak dengan prioritas **di atas** `fbid` (yang di URL
  itu id foto, bukan story) — synthetic langsung menyasar komentar postingannya, sama
  seperti foto/video tunggal.
- **False positive dihapus**: path numerik polos (`facebook.com/<8+ digit user id>`
  = halaman profil) tidak lagi dilaporkan sebagai post permalink.
- **Synthetic template multi-kandidat** — engine mem-probe tiap kandidat id dari
  URL (urutan = prioritas) dan memakai yang benar menghasilkan `page_info`;
  robust terhadap bentuk URL yang id-nya ambigu (foto album vs story).
- **Filter feedbackId di `orderedCandidates`** (setara `mediaId filter` IG
  v1.0.15) — template ter-capture yang id feedback-nya cocok dengan URL
  diutamakan, mencegah pagination komentar postingan lain dari sidebar/iklan.
- **Deteksi `errors` GraphQL** — feedback id salah / post tidak publik kini
  berhenti dini dan probe kandidat berikutnya, bukan diam-diam jatuh ke DOM.
- Perbaikan langsung mengatasi laporan lapangan: klik gambar 1 di postingan
  foto kolektif (album) kini langsung mendapat synthetic permalink, sama seperti
  foto/video tunggal.

## [1.0.27] — 2026-08-11

### Badge "API komentar" TikTok selalu akurat (simetris dengan IG & popup)

- **`storage.onChanged` panel TT/IG tidak lagi memakai nilai mentah** — saat
  template API berubah (capture atau kadaluarsa), panel mere-validasi via
  `GET_TEMPLATE` (TTL + shape) alih-alih `!!newValue` yang bisa menampilkan
  badge hijau "siap" padahal template sudah melewati TTL.
- **Boot restore menerapkan `hasTemplate` tanpa syarat** — pola popup
  (`GET_STATE` merekomputasi TTL+shape): badge panel TT/IG kini akurat meski
  tanpa hasil tersimpan dan saat service worker baru bangun.

## [1.0.26] — 2026-08-11

### Parity fitur panel: search + sort + CSV + Gabung di 3 panel

- **Panel FB/TikTok/IG kini setara popup** — tiap panel punya pencarian (filter
  live), tombol Urutkan A–Z, preview daftar hasil (maks 40 + indikator sisa),
  tombol **CSV** (nama file & header platform-aware: `reso-nama-*`/Nama untuk
  FB/TT, `reso-username-*`/Username untuk IG), dan tombol **Gabung** (merge
  FB+TT+IG unik). Copy & CSV kini menghormati filter aktif ("X dari N" di
  count saat filter menyala).
- **Restore hasil saat boot untuk TT/IG** — pola Facebook (v1.0.23): panel
  memanggil `GET_STATE` saat load dan memulihkan hasil tersimpan lintas
  reload beserta status/message/videoHint/postHint/hasTemplate.
- **Parser payload komentar jadi satu sumber kebenaran** — blok `PARSERS`
  (parseTikTokComments/parseIgComments/extractGraphqlNames) di shared.js,
  disalin byte-identik ke ketiga engine inject-*.js dan diuji fixture
  (layout + parity + behavior). Engine sebelumnya punya logika parse lokal
  yang tak teruji otomatis.
- **Perkakas UI daftar jadi satu sumber** — blok `PANELTOOLS`
  (filterNames/sortNamesAz/csvContent/downloadTextFile/mergeAcrossPlatforms)
  di shared.js, disalin byte-identik ke ketiga panel; popup memakainya via
  export. Fixture test menjamin 4 salinan identik.
- **Gabung lintas platform dipindah ke background** (`MERGE_ALL`) — content
  scripts hanya membawa normalizer platform-nya sendiri, jadi merge
  FB+TT+IG yang butuh ketiga aturan normalisasi harus jalan di background
  (shared.js), bukan di halaman. Panel memanggil `MERGE_ALL` dan menampilkan
  hasilnya.

### Ketahanan & internal

- `npm test` naik **65 → 72** (fixture PARSERS + PANELTOOLS + behavior).

## [1.0.25] — 2026-08-11

### Chore & dokumentasi
- **Hapus `icons/logo.svg`** — duplikat byte-identik dari `logo.svg` di root (satu-satunya yang direferensikan popup/options).
- **Hapus `id="logoIcon"`** yang tidak dipakai di popup.html.
- **README diperbarui** — struktur proyek (blok marker `NORMALIZE`/`DONEMSG`, fixture parity, `doneMessage` satu sumber pesan).

### Eksekusi audit detail UI/UX (bug CSV, merge lintas platform, jargon, keyboard)
- **🐛 Fix "Ekspor CSV" ReferenceError** — `wordFor(p)` dengan `p` tidak terdefinisi di handler `btnCsv` (popup.js) → toast konfirmasi gagal + unhandled rejection di setiap klik. Kini `wordFor(res?.platform || currentPlatform)`.
- **🐛 Fix "Gabung Semua" kehilangan data** — helper baru **`mergeAcrossPlatforms`** di shared.js: tiap nama dinormalisasi dengan aturan **platform-nya sendiri** (sebelumnya `mergeNames(..., null)` menerapkan aturan FB ke TT/IG → `@user123` & emoji TikTok ter-drop; pemanggilan bertahap pun menormalkan ulang hasil lama → nama FB "Andi Pratama" hilang). Terverifikasi runtime: 6 nama → kini 6; + 3 unit test.
- **Jargon disembunyikan saat run selesai** — hint "Target: graphql", "Target: templates:2 buffer:5", "Video: 7290…", "Target: 1234…" (media id) kini **kosong di status done/partial/stopped/error** (popup + 3 panel); baris status sudah menjelaskan hasil. Detail teknis tetap tampil saat running (transien, berguna untuk debug).
- **Esc menutup panel** — ketiga panel (FB/TikTok/IG) kini punya jalur keyboard: Esc = setara tombol min (FB juga menghormati flag userCollapsed).
- **Popup: satu sumber render** — poll cadangan 1,2 dtk dihapus; `storage.session.onChanged` sudah memicu pada setiap `setState` background (diverifikasi: semua state lewat `chrome.storage.session.set`).
- **Count "X dari N" saat filter aktif** — popup menampilkan "0 dari 1500 nama" (mis. filter tanpa match) agar tombol Copy yang nonaktif tidak ambigu.
- **FAB title/aria dinamis** — FAB ketiga platform kini update title/aria mengikuti state ("Proses berjalan — buka panel untuk Stop", "Buka panel — N nama/username terkumpul"), seragam dengan chip bar Like FB.

## [1.0.24] — 2026-08-11

### Satu sumber pesan akhir run — `doneMessage` (dari audit D1)
- **`doneMessage(reason, count, platform, { extra, tip })` di shared.js** menjadi **single source of truth** untuk semua pesan akhir run: `reasonToMessage` (popup/background) kini **delegasi** ke helper yang sama, dan ketiga panel (`content-fb/tiktok/ig.js`) memakai salinan byte-identik di dalam marker `BEGIN-RESO-DONEMSG` — dijamin **fixture test parity** (4 salinan) agar tidak pernah drift lagi.
- **Drift yang tertutup**: ① FB panel menyisipkan suffix `[graphql]`/`[dom]` (TT/IG tidak) → dihapus, mode tetap terlihat di baris "Target:"; ② IG panel checkpoint **tanpa jumlah** → kini menyertakan count; ③ TT/IG timeout tanpa "Klik Copy" → seragam; ④ IG panel rate-limit memakai wording sendiri → kini helper tunggal ("Rate limit Instagram (429)…" konsisten dengan popup).
- **`wordFor(platform)`** diekspor dari shared (username untuk IG, nama lainnya) — popup memakainya, salinan lokal dihapus.
- Jalur stop-finalize (content menghentikan run saat inject tak menjawab) ikut diarahkan ke `doneMessage("stopped", …)`.
- Tes: fixture DONEMSG (layout 4+1+2, parity 6+4, kontrak wording platform-aware) + unit test delegasi `reasonToMessage` ≡ `doneMessage` di semua reason/platform.

## [1.0.23] — 2026-08-11

### Default visibility panel FB — expanded saat ada hasil (sama dengan TikTok/Instagram)
- **Boot**: panel Facebook kini memanggil `GET_STATE`; jika ada hasil tersimpan lintas reload, nama dipulihkan ke panel dan panel **langsung terbuka** (sebelumnya selalu collapsed).
- **Run selesai dengan hasil** (termasuk dari popup/shortcut/context-menu): panel otomatis terbuka menampilkan hasil — konsisten dengan TT/IG yang selalu expanded.
- **Toggle manual tetap dihormati**: user yang menutup panel (`min`) tidak akan dipaksa terbuka saat run selesai; FAB/ikon bar Like membuka dan me-reset preferensi.
- **Tanpa hasil**: panel tetap collapsed di feed (tidak mengganggu), FAB adalah pintu seragam.

## [1.0.22] — 2026-08-11

### Soft motion — audit & sistem gerak seragam
- **Token motion di 5 stylesheet** — `--rs-ease`, `--rs-ease-soft`, `--rs-dur-fast/-base/-slow`, `--rs-motion: cubic-bezier(.22,.61,.36,1)`; semua transisi memakai easing konsisten (bukan `ease` generik dengan durasi acak 0.08–0.3s).
- **Semua permukaan kini bergerak lembut**: popup, options, dan panel FB/TikTok/IG — icon button, badge platform/API, status chip, count, tombol, preview, steps, cards, switch, toast, collapse panel, FAB badge pop.
- **Collapse panel kini visibility-based + transisi** — buka/tutup panel FB tidak lagi abrupt (fade+slight rise 0.3s, `visibility` di-delay agar tombol tidak mengganggu klik).
- **Count/badge/status kini bertransisi** — angka naik lembut (0.15s), badge muncul dengan pop ringan, status berubah warna smooth.
- **`prefers-reduced-motion` dipertahankan** dari v1.0.20 — semua gerak baru ikut dimatikan untuk user yang memilih reduced motion (di halaman host tetap di-scope ke `#xxx-root`).
- Audit motion lengkap tersimpan di `RESEARCH.md` seksi 9 (inventaris + inkonsistensi sebelum fix).

## [1.0.21] — 2026-08-11

### Badge API Instagram selalu akurat
- **`GET_STATE` kini merekomputasi `hasTemplate` untuk Instagram** — simetris dengan TikTok: badge "API komentar: siap" di popup dihitung ulang dari session template (TTL 30 mnt + validasi shape) setiap kali state diambil, bukan hanya mengandalkan nilai session yang terakhir di-`setState`. Menutup kondisi edge saat service worker baru bangun / state belum di-refresh.

## [1.0.20] — 2026-08-11

### Konsistensi UI/UX — quick wins (kritik audit)
- **Satu model interaksi entry point** — ikon N di bar Like/Comment/Share Facebook kini **membuka panel** (menandai post tempat ikon berada agar engine menyasar post yang benar), bukan langsung proses/copy — seragam dengan FAB di ketiga platform. Tombol FAB tetap pintu utama; status visual chip (badge jumlah, pulse, warna done) dipertahankan.
- **Kopi segar** — hint FB menyebut FAB; steps popup FB menyebut badge "API siap"; pesan gagal copy kini "Coba lagi dari panel atau popup" (bukan "ikon extension" yang basi).
- **Aksesibilitas: `prefers-reduced-motion`** — semua animasi (shimmer/breathe/blink/pulse/rise) dihormati di 5 stylesheet; di halaman host, scope dibatasi ke panel agar tidak mengganggu animasi Facebook/TikTok/Instagram.
- **Terminologi seragam** — checkbox FB kini "Sertakan balasan (reply)"; sub-header popup "copy ke Excel" untuk semua platform; placeholder & aria search "Cari username…" untuk IG; nama file CSV `reso-username-*.csv` untuk IG; warna badge FAB IG disamakan (#161823).

## [1.0.19] — 2026-08-11

### Badge "API komentar" di panel & popup Facebook
- **Badge API di panel Facebook** — konsisten dengan TikTok & Instagram: di halaman post permalink badge hijau "API komentar: siap" (engine FB selalu bisa paginate via synthetic GraphQL template dari `feedbackId` di URL); di home feed/URL lain badge kuning "belum — buka permalink post".
- **Badge API di popup Facebook** — sama seperti panel (konsisten lintas permukaan).
- Helper baru `isFacebookPostPage` (shared, ter-uji) — cermin logika `feedbackIdFromUrl` engine.

## [1.0.18] — 2026-08-11

### Audit P2 — getDtsg ringan, pre-check login TikTok, satu model interaksi panel
- **`getDtsg`/`getLsd` ringan** — token anti-forgery FB kini diambil dari `require("DTSGInitialData")`/modul memory dulu, lalu scan `<script>` tag terbatas (lewati payload raksasa >400 KB), lalu input form; `document.documentElement.innerHTML` (serialisasi DOM megabyte) hanya jadi fallback terakhir dan tetap di-cache 5 menit.
- **Pre-check login TikTok** — pola IG (`CHECK_TT_LOGIN`): tanpa cookie `sessionid` di tiktok.com, Proses gagal cepat dengan pesan "Sesi TikTok tidak aktif — login di tiktok.com lalu Proses lagi", di jalur panel maupun popup/shortcut/context-menu — tidak lagi membuang run & request saat logout.
- **FAB di Facebook** — model interaksi panel kini seragam di ketiga platform: ikon FAB pojok kanan-bawah (buka panel), badge jumlah, pulse saat running, warna done saat ada hasil. Chip inline di bar Like/Comment/Share tetap dipertahankan sebagai integrasi native FB (klik = proses, klik lagi = copy). Glyph tombol tutup diseragamkan (`–`).

## [1.0.17] — 2026-08-11

### Audit menyeluruh — daya tahan & konsistensi UI/UX (fix terverifikasi)
- **Guard template IG mid-run** — webRequest capture Instagram kini tidak lagi menimpa template media yang sedang diproses saat run aktif (pola guard TikTok): scroll ke post/reel lain tidak mengganggu pagination, dan template untuk run berikutnya tetap menyasar post yang benar.
- **Total request budget di Facebook** — engine FB kini punya `requestBudget` 350/run (sebelumnya hanya guard halaman 120 + budget balasan): konsisten dengan TikTok (350) dan Instagram (150); README "batas request per run" kini benar untuk semua platform.
- **Label popup platform-aware** — popup kini memakai "username" untuk Instagram (count, tombol Copy, toast, header CSV) — sebelumnya selalu "nama" meski panel IG dan menu sudah bilang username.
- **Hint popup menyebut Instagram** — "Buka tab Facebook, TikTok, atau Instagram…" (sebelumnya lupa menyebut Instagram).
- **Wording rate-limit konsisten** — pesan `rate_limit` non-FB kini "X nama" (TikTok) / "X username" (Instagram), bukan kata generik "data".
- **Konstanta storage di popup** — listener `storage.onChanged` memakai `STORAGE_KEY_*` dari shared (bukan string hardcode `fnk_state`/`tnk_state`/`ing_state`).

> ℹ️ Koreksi audit: temuan "TT XHR tidak difilter video" ternyata **false positive** — kedua jalur (fetch & XHR) sama-sama melalui `tryParseResponse` yang memanggil `payloadMatchesVideo`; tidak ada perbaikan yang diperlukan.

## [1.0.16] — 2026-08-11

### Perbaikan audit IG (P2)
- **Pesan 403 akurat** — HTTP 403 tidak lagi diklaim sebagai "login diperlukan"; kini diklasifikasikan sebagai blok anti-bot/App-ID ditolak (`stopReason: "blocked"`): run berhenti aman, status *partial* (jika ada hasil) / *error* (jika kosong), dengan diagnosis eksplisit di panel & popup. HTTP 302/401 tetap = login.
- **Fallback endpoint balasan `child_comments/`** — bila endpoint `inline_child_comments/` menjawab 404 / "not found" (versi klien IG berbeda-beda), engine otomatis mencoba `child_comments/` sekali per thread sebelum menyerah.
- **Pre-check `no_media`** — di halaman profil/feed (tanpa shortcode `/p/` atau `/reel/`), Proses kini gagal cepat dengan pesan "Buka halaman post/reel dulu" (pola `no_video` TikTok), di panel maupun jalur popup/shortcut — tidak lagi membuang 45 dtk dalam mode scroll.
- **Header `X-IG-WWW-Claim: 0`** — dikirim pada request replay (sama seperti web IG asli) untuk menstabilkan 403 sesekali akibat App-ID/claim tidak cocok.
- **Cooldown antar-run** — Proses diblokir sementara setelah run selesai (15 dtk; 60 dtk setelah rate limit) dengan pesan hitung mundur, mencegah run beruntun yang menjadi pemicu rate-limit/checkpoint (riset IG 2026).

## [1.0.15] — 2026-08-11

### Perbaikan audit IG (P1)
- **Replay tidak lagi menyasar post yang salah** — `buildUrl` kini menulis ulang segmen `media_id` di path API sesuai post yang sedang dibuka (pola `aweme_id` TikTok), dan `activeMediaId` diprioritaskan dari halaman (bukan dari template lama). Sebelumnya, template dari post lain (masih valid dalam TTL 30 mnt) membuat engine mengambil komentar post yang salah bila user tidak membuka komentar dulu.
- **Budget balasan benar-benar per-run** — counter `replyRequests` dipindah ke luar loop halaman: maksimal 40 request balasan per run (sebelumnya 40 per halaman, di-reset tiap halaman; cap nyata hanya budget global 150).
- **`rate_limit` jadi `stopReason` resmi** (konsisten dengan FB/TT) — engine mengirim `stopReason: "rate_limit"` alih-alih `timeout`+postHint; panel kini menampilkan status *partial* (jika ada hasil) / *error* (jika kosong) dan pesan "Rate limit Instagram (429)" spesifik (sebelumnya dengan hasil bisa salah jadi hijau "done").
- **`PleaseWaitFewMinutes` / `FeedbackRequired` diklasifikasikan** — `status:"fail"` dengan pesan "please wait a few minutes" / "feedback_required" kini diperlakukan sebagai rate limit/akun dibatasi: run berhenti aman dengan diagnosis jelas (bukan error generik), tanpa retry loop yang membahayakan akun.
- **Sleep interruptible di fase awal** — buka komentar (`tryOpenComments`), retry buka komentar, menunggu template, dan mode scroll kini memakai `sleepWhile` (cek Stop tiap 200 ms); FB/TT dan sisa IG sudah konsisten.

## [1.0.14] — 2026-08-11

### Ketahanan TikTok diperkuat
- **Backoff adaptif saat HTTP 429** — replay API komentar tidak langsung menyerah: menunggu sesuai header `Retry-After` (atau eskalasi 8s → 16s), maksimal 2 retry, dan hanya jika sisa waktu run masih cukup. Heartbeat progress tetap terkirim selama menunggu, jadi panel tidak terlihat beku.
- **Deteksi sesi tidak aktif** — respons HTTP 401 dari API komentar TikTok kini dianggap sesi kadaluarsa: run berhenti aman dengan pesan "Sesi TikTok tidak aktif…" di panel & popup (sebelumnya error generik).
- **Error jaringan ditangani** — blip jaringan (fetch gagal, tab di-throttle) di-retry sekali cepat, tidak langsung mengakhiri run.
- **Retry halaman kosong** — halaman kosong di tengah pagination (sementara `has_more` masih true) tidak lagi dinyatakan "complete": engine mencoba ulang cursor yang sama (2×) sebelum berhenti aman.
- **Budget balasan terpisah** — replay balasan dibatasi **40 request/run** (sebelumnya 30 thread × 15 halaman tanpa batas = hingga ratusan request), dan error 429/sesi tidak aktif di balasan kini menghentikan seluruh run (sebelumnya di-swallow diam-diam — berisiko untuk akun).
- **Sleep interruptible** — semua jeda (pagination, balasan, buka komentar, menunggu template, mode scroll) memeriksa tombol Stop tiap 200 ms, penghentian selalu responsif.
- **Diagnosis dibawa ke UI** — `rate_limit`/`no_login` kini menjadi `stopReason` resmi di panel & popup: status *partial* (jika ada hasil) / *error* (jika kosong), pesan TikTok-specific via `reasonToMessage` (sebelumnya `no_login` selalu menampilkan pesan Instagram).

### Pengujian
- Unit test `reasonToMessage` untuk `rate_limit` dan `no_login` TikTok (platform-aware TT vs FB vs IG) ditambahkan.

## [1.0.13] — 2026-08-10

### Ketahanan Facebook diperkuat
- **Backoff adaptif saat HTTP 429** — replay GraphQL tidak langsung menyerah: menunggu sesuai header `Retry-After` (atau eskalasi 8s → 16s), maksimal 2 retry, dan hanya jika sisa waktu run masih cukup. Heartbeat progress tetap terkirim selama menunggu, jadi panel tidak terlihat beku.
- **Deteksi sesi tidak aktif** — jika Facebook redirect ke halaman login (sesi kadaluarsa / token kedaluwarsa) atau mengembalikan HTML login, run berhenti aman dengan pesan "Sesi Facebook tidak aktif…" alih-alih mengumpulkan sampah atau terus mencoba.
- **Error jaringan ditangani** — blip jaringan (fetch gagal, tab di-throttle) di-retry sekali cepat, tidak langsung mengakhiri run.
- **Retry halaman kosong** — respons kosong / JSON gagal diparse di tengah pagination tidak lagi dianggap "complete": engine mencoba ulang cursor yang sama (2×) sebelum menyatakan berhenti, dan halaman `has_next_page` tanpa cursor dihentikan dengan aman (anti loop tak berujung).
- **Budget balasan terpisah** — replay balasan dibatasi 40 request/run (tidak lagi 25 thread × 8 halaman tanpa batas), dan error 429/sesi kadaluarsa di balasan kini menghentikan seluruh run (sebelumnya di-swallow diam-diam — berisiko untuk akun).
- **Sleep interruptible** — semua jeda (pagination, balasan, DOM fallback, menunggu template) memeriksa tombol Stop tiap 200 ms, penghentian selalu responsif.
- **Diagnosis dibawa ke UI** — `rate_limit`/`no_login` kini menjadi `stopReason` resmi: status *partial* (jika ada hasil) / *error* (jika kosong) di panel & popup, dengan pesan spesifik platform.

### Pengujian
- Unit test `reasonToMessage` untuk `rate_limit` (FB-specific + generic) dan `no_login` platform-aware (FB vs IG) ditambahkan.

## [1.0.12] — 2026-08-10

### Ketahanan Instagram diperkuat
- **Backoff adaptif saat HTTP 429** — engine tidak langsung menyerah: menunggu sesuai header `Retry-After` (atau 8s → 16s), maksimal 2 retry, dan hanya jika sisa waktu run masih cukup. Heartbeat progress tetap terkirim selama menunggu, jadi panel tidak terlihat beku.
- **Deteksi checkpoint & login gate** — `checkpoint_required`/`challenge_required` kini dibedakan dari sekadar login: run berhenti aman dengan status *partial* (jika ada hasil) dan pesan eksplisit "Instagram minta verifikasi (checkpoint)…" di panel & popup. Sebelumnya error ini salah diklasifikasikan sebagai "login"/"timeout" generik.
- **Error jaringan ditangani** — blip jaringan (fetch gagal, tab di-throttle) di-retry sekali cepat, tidak langsung mengakhiri run.
- **Retry halaman kosong** — IG kadang mengembalikan halaman kosong di tengah pagination sementara `has_more_comments` masih true; engine mencoba ulang cursor yang sama (2×) sebelum menyatakan selesai, dan berhenti aman bila `has_more` true tanpa cursor (menghindari loop tak berujung).
- **Cursor `next_max_id` lebih toleran** — menerima angka/string; balasan memakai fallback `next_max_child_id`.
- **Budget balasan terpisah** — replay balasan dibatasi 40 request/run (tidak lagi memakai jatah utama tanpa batas), dan error 429/login/checkpoint di balasan kini menghentikan run (sebelumnya di-swallow diam-diam — berisiko untuk akun).
- **Buka komentar lebih andal** — selektor baru (`View all comments`, `Lihat semua komentar`, `aria-label*="view all"`) + fallback berbasis teks, sehingga template API lebih sering ter-capture tanpa klik manual.
- **`maxMs` IG diseragamkan** — panel memakai 150 dtk (default shared), memberi ruang untuk backoff.
- **Header `Referer`** ditambahkan ke replay API, menyamai perilaku web IG.
- **Sleep interruptible** — semua jeda/backoff memeriksa tombol Stop (tiap 200 ms), penghentian selalu responsif.

### Pengujian
- Unit test `reasonToMessage("checkpoint", …)` + pemetaan status partial/error ditambahkan.

## [1.0.11] — 2026-08-10

### Diperbaiki (hasil audit dalam)
- **Normalisasi nama single-source** — 7 salinan logika normalisasi (shared + engine FB/TikTok/IG + content FB/TikTok/IG) disatukan ke satu referensi (blok `BEGIN/END-RESO-NORMALIZE`) dan dijaga **fixture test paritas** (`npm test`): setiap salinan diverifikasi byte-identik + perilaku identik terhadap korpus fixture. Drift daftar kata terblokir TikTok (engine/content membiarkan "View", "See", "Write", "Log in" lolos padahal shared memblokirnya) sudah disamakan.
- **`:has()` di halaman Options** — diganti kelas `.selected` yang di-set JS; sebelumnya manifest mengklaim dukungan Chrome 102 tapi tombol tema tidak menampilkan state terpilih di Chrome 102–104.
- **Pesan error platform-aware** — `reasonToMessage("no_template")` kini memakai kata-kata sesuai platform (FB: permalink + GraphQL; IG: post/reel + wajib login), bukan lagi pesan TikTok untuk semua platform. Pesan hasil tersimpan juga memakai "username" untuk IG.
- **Diagnosis rate limit (429) sampai ke user** — hint "Rate limit Instagram (429)…" dari engine tidak lagi dibuang: panel IG dan popup menampilkan pesan 429 spesifik (+ status parsial), bukan sekadar "Waktu habis".
- **Pre-check login Instagram** — sebelum mulai, extension memeriksa cookie `sessionid` via `chrome.cookies` (izin `cookies` ditambahkan) dan langsung menampilkan "Butuh login Instagram" tanpa membuang waktu 45 detik di mode scroll. Berlaku di popup, panel, shortcut, dan menu klik kanan.
- **Dead branch di engine Facebook** — `if ("id" in vars) vars.id = fbId; else vars.id = fbId;` diperbaiki menjadi `id` / `feedbackID` / `feedback_id` sesuai nama field yang dipakai template reply.
- **Cache token anti-forgery Facebook** — `getDtsg()`/`getLsd()` tidak lagi serialisasi seluruh DOM Facebook (`document.documentElement.innerHTML`, megabyte) per halaman pagination; di-cache dengan TTL 5 menit.

### Pengujian
- `sanitizeEngineOptions` dipindah ke `shared.js` (pure, teruji) — test mencakup SET_TEMPLATE FB/TT/IG, clamping `maxMs`, sanitasi `awemeId`/`mediaId`, dan `includeReplies` per platform.
- Total unit test naik menjadi **49** (`npm test`).

## [1.0.10] — 2026-08-10

### Ditambahkan
- **Halaman Pengaturan (Options)** — `chrome://extensions` → Details → Extension options (atau tombol ⚙ di popup):
  - **Default "Sertakan balasan" per platform** (Facebook / TikTok / Instagram) — dipakai sebagai nilai awal di popup, panel halaman, shortcut keyboard, dan menu klik kanan.
  - **Tema** — Sistem / Terang / Gelap, diterapkan langsung ke popup, panel Facebook, panel TikTok, panel Instagram, dan halaman Options itu sendiri (dengan preview live).
  - Auto-save setiap perubahan + tombol "Pulihkan default".

## [1.0.9] — 2026-08-10

### Ditambahkan
- **Platform baru: Instagram — username komentator** (post & reel). Output berupa **username IG** (`user123`, tanpa `@`, huruf kecil), bukan nama tampilan.
  - Replay endpoint private `api/v1/media/{media_id}/comments/` dengan cursor `max_id`/`next_max_id` (template di-capture via `webRequest`, TTL 30 menit).
  - Auto-open komentar + intercept `fetch`/XHR + fallback DOM (dialog komentar).
  - Proteksi akun: budget 150 request/run, delay acak besar, berhenti dini saat `429` atau `401/403` (login wajib → pesan jelas).
  - UI peringatan "butuh login" di popup & panel; aksen gradien Instagram (pink→ungu) di popup, panel, dan FAB.
- **Gabung Semua** (popup) — gabungkan nama unik Facebook + TikTok + Instagram.
- Unit test Instagram: normalisasi username (lowercase, tanpa @, charset, whitespace), validasi template, deteksi platform, default state — total **33 test**.

## [1.0.8] — 2026-08-10

### Ditambahkan
- **Badge jumlah nama di ikon ekstensi** — jumlah hasil terlihat langsung di toolbar (hijau saat selesai, kuning saat parsial, animasi saat berjalan), ikut platform tab aktif.
- **Shortcut keyboard** — `Ctrl+Shift+E` untuk Proses/ambil nama, `Alt+Shift+C` untuk salin ke clipboard (bisa diubah di `chrome://extensions/shortcuts`).
- **Menu klik kanan** — "Ambil nama komentator halaman ini" (di halaman FB/TikTok) dan "Buka & ambil nama dari tautan ini" (di link FB/TikTok): tab dibuka lalu ekstraksi berjalan otomatis.
- **Backup & Pulihkan JSON** — simpan hasil + preferensi ke file, pulihkan kapan saja (tombol di popup).
- **Filter & sortir nama di popup** — kotak cari nama + toggle urutkan A-Z; memengaruhi preview, Copy, dan Ekspor CSV.
- **Auto-open komentar TikTok lebih andal** — selector lebih luas (`comment-icon`, `comment-count`, tombol berlabel), klik ulang dengan retry sampai panel komentar benar-benar terbuka, sehingga template API ter-capture tanpa perlu klik manual.

### Diubah
- **Deteksi navigasi SPA tanpa polling** — ganti `setInterval` 1,6 detik dengan `MutationObserver` + hook `history.pushState/replaceState` + `popstate/hashchange` (debounce 300 ms): lebih responsif dan lebih hemat CPU di halaman yang sibuk.

## [1.0.7] — 2026-08-10

### Diperbaiki
- **Gabung FB+TT kini selalu lengkap** — `GET_ALL_STATE` memulihkan hasil tersimpan (`storage.local`) untuk kedua platform sebelum digabung, sehingga nama platform lain tidak hilang dari tombol "Gabung FB+TT" setelah browser restart.

### Disempurnakan
- **Desain lebih modern & hidup** — header gradien per platform, micro-interaction tombol (brightness saat hover, press saat klik), efek shimmer pada tombol Proses saat berjalan, denyut halus pada penghitung nama, indikator titik berkedip pada status *running*, dan animasi masuk panel di halaman Facebook/TikTok. Konsisten di popup, panel FB, dan panel TikTok (mode terang & gelap).

## [1.0.6] — 2026-08-10

### Ditambahkan
- **Hasil tersimpan lintas sesi** — hasil terakhir per platform dan preferensi "sertakan balasan" disimpan di `chrome.storage.local`; tidak hilang saat browser ditutup. Reset menghapus hasil tersimpan.
- **Ekspor CSV** — simpan hasil ke file `.csv` dengan BOM UTF-8 (siap dibuka Excel).
- **Gabung Facebook + TikTok** — gabungkan nama unik dari kedua platform sekali klik, langsung tersalin ke clipboard.
- **Unit test** — 24 test untuk `shared.js` (`npm test`, zero dependency).
- `CHANGELOG.md`, `README.md`, `package.json` (script `build`/`check`/`test`), `.gitignore`.

### Diperbaiki
- **Facebook: tanpa perlu buka/scroll semua komentar** — replay GraphQL pagination otomatis: template pagination dipilih dengan verifikasi (`page_info`) dan, bila belum ada capture, query dibangun langsung dari ID postingan di URL; scroll fallback menyasar kontainer komentar, bukan seluruh halaman.
- **UI/UX terpadu** — popup, panel Facebook, dan panel TikTok kini memakai satu design system (token `--rs-*`): komponen, radius, font, tombol, warna status, dan dark mode identik; panel halaman mendapat tombol Reset, `aria-live`, tooltip, dan warna status (done/partial/error) yang konsisten dengan popup.
- Run tidak lagi menggantung saat tab yang sedang memproses ditutup (`tabs.onRemoved` → status di-finalisasi otomatis).
- Berhenti dini saat Facebook membalas `HTTP 429` (rate limit) dan batas jumlah halaman/request per run (FB 120 halaman, TikTok 350 request) untuk melindungi akun.
- Deteksi `feedback_id` untuk ekspansi balasan (kondisi regex sebelumnya selalu salah).
- Logika normalisasi nama disinkronkan antar `shared.js`, `content-fb.js`, dan `inject-fb.js` (filter unicode + daftar kata terblokir identik).
- Aksesibilitas: FAB TikTok kini punya `aria-label`/`title`.
- Dead branch `fb_dtsg` di replay GraphQL dirapikan.

## [1.0.5] — Sebelumnya
Rilis awal: ekstraksi nama komentator Facebook (GraphQL + DOM) & TikTok (replay API + DOM), copy ke clipboard, deduplikasi, filter timestamp/UI.
