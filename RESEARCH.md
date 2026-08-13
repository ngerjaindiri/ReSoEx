# Riset Platform — ReSo Ekstention

> Dokumen riset untuk ekspansi platform & fitur. Tanggal riset: **2026-08-10** (riset web + audit kode).
> ⚠️ Struktur DOM/API platform dapat berubah sewaktu-waktu — verifikasi manual di halaman asli **wajib** sebelum merilis fitur apa pun dari dokumen ini.

## Keputusan Produk (2026-08-10)

- **Cakupan: komentar saja.** Fitur "like/liker" (FB, TikTok, IG) **ditunda/di-skip** untuk sekarang.
- **Instagram: output = username IG** (field `username` dari respons API, tanpa `@`, huruf kecil), **bukan** nama tampilan (`full_name`). Ini beda dari FB/TikTok yang mengumpulkan nama — normalisasi IG harus menangani charset username (`a-z`, `0-9`, `_`, `.`).
- Prioritas berikutnya: **IG komentar (post & reel)** → reuse arsitektur TikTok (capture template via `webRequest` → replay cursor).

---

## Ringkasan Eksekutif

| Platform | Komentar | Like/Reaksi | Butuh login? | Tingkat kerapuhan |
|---|---|---|---|---|
| **Facebook** | ✅ Jalan (GraphQL replay) | ⚠️ Sebagian kecil (cap platform) | Ya (sesi FB) | Sedang |
| **TikTok** | ✅ Jalan (replay API) | ⚠️ ±1.000–2.000 (server cap) | Tidak wajib | Sedang |
| **Instagram** | ⚠️ Feasible tapi paling rapuh | ❌ **Tidak mungkin** | **Wajib** (login gate) | Tinggi |

**Kesimpulan cepat:**
- **FB & TikTok komentar** — sudah berjalan di ekstensi (v1.0.6–1.0.8); batasnya adalah rate-limit & pagination cap di post sangat viral (harus disikapi sebagai *partial*).
- **IG komentar** — layak dikerjakan dengan ekspektasi jujur: wajib login, paling rapuh, cap di post viral; **output = username IG**.
- **TikTok like, FB like skala 10rb+, IG like** — **di-skip** (keputusan produk): platform tidak menyediakan data lengkap untuk FB/IG, dan prioritas sekarang komentar saja.

---

## 1. Facebook

### 1.1 Komentar — ✅ Sudah berjalan
- Mekanisme: **replay GraphQL pagination** (`CometUFICommentsProviderPaginationQuery`).
  - Template query di-capture dari request halaman (hook `fetch`/XHR di MAIN world).
  - Engine memverifikasi kandidat template (harus punya `page_info`), lalu replay dengan `cursor` server-side — **tanpa scroll**.
  - Bila belum ada capture, query dibangun langsung dari ID postingan di URL.
  - Auto-open komentar + scroll fallback hanya jika replay gagal.
- Proteksi yang sudah ada di kode: berhenti dini saat HTTP **429**, cap 120 halaman/run, jitter delay.
- **Batas nyata:** rate-limit FB; pagination depth. Untuk post 10rb+ komentar, realistis **partial** (bisa ribuan, tidak dijamin semua). Status UI `partial` (kuning) sudah menangani ini.

### 1.2 Like / Reaksi — ⚠️ Tidak bisa penuh (batas platform, bukan teknik)
Hasil riset (Graph API resmi + perilaku dialog web):
- **Graph API `/{post-id}/reactions`**: pagination cursor kena batas kedalaman —
  error resmi `(#100) The After Cursor specified exceeds the max limit supported by this endpoint`.
- Rate limit API: kode `4`, `17`, `32` (App/User rate limit) menghantam sebelum 10rb tercapai.
- **Dialog reaksi di web juga di-truncate**: lazy-loading berhenti di beberapa ratus–~ribuan entri, walau dilihat oleh pemilik post.
- **Kesimpulan:** bahkan pemilik post & API resmi **tidak bisa** meng-enumerasi 10rb reaktor. Tool yang mengklaim bisa = bohong/ilegal.
- **Rekomendasi:** jangan janjikan "semua liker FB". Jika dikerjakan, tampilkan sebagai *partial* dan jujur di UI.

---

## 2. TikTok

### 2.1 Komentar — ✅ Sudah berjalan
- Mekanisme: **replay endpoint `tiktok.com/api/comment/list/`** dengan `cursor` + `has_more`.
  - URL template di-capture oleh `webRequest` di background (session storage, **TTL 45 menit**).
  - Engine replay server-side; auto-open panel komentar (v1.0.8) agar template ter-capture tanpa klik manual.
  - Budget 350 request/run + delay acak.
- **Batas nyata:** post viral bisa di-truncate server; `429` atau respons `200` kosong (silent). Hasil = *partial*.

### 2.2 Like — ⚠️ Feasible ±1.000–2.000 nama (server cap)
- Endpoint daftar liker tersedia dengan pola sama seperti komentar (pagination `cursor`/`max_cursor` + `has_more`).
- **Tapi riset mengonfirmasi cap server:** TikTok memotong pagination liker di kisaran **~1.000–2.000 record per video** — `has_more` berubah `false` diam-diam walau `like_count` ratusan ribu.
- Rate limit agresif: `429`, payload kosong, hingga tantangan CAPTCHA; butuh pacing hati-hati.
- **Rekomendasi:** layak dikerjakan dengan ekspektasi jujur di UI ("dapat X nama — cap platform"). Mirip arsitektur komentar: capture template like-list via `webRequest` → replay cursor.

---

## 3. Instagram — BARU (hasil riset 2026-08-10)

### 3.1 Komentar — ⚠️ Feasible, tapi paling rapuh & wajib login

**Output yang dikumpulkan: username IG** (`username`, tanpa `@`), bukan `full_name`. Dari JSON respons, ambil `user.username` (tersedia di setiap komentar).
Endpoint private (bukan Graph API resmi):
```
GET https://www.instagram.com/api/v1/media/{media_id}/comments/?can_support_threading=true&max_id={cursor}
```
**Persyaratan wajib (semuanya):**
| Kebutuhan | Nilai |
|---|---|
| Sesi login | Cookie `sessionid` (tanpa sesi → 302 ke login / 401/403) |
| CSRF | `csrftoken` cookie harus cocok dengan header `X-CSRFToken` |
| App ID | Header `X-IG-App-ID: 936619743392459` (desktop web) |
| User-Agent | Harus meniru browser desktop asli; UA aneh → 429/403 |

**Pagination:** balik `max_id` (string `server_cursor` JSON) sampai `next_max_id` null; `min_id` untuk arah baru.

**Batas & kerapuhan:**
- Rate limit ketat: `429` atau JSON `{"status": "fail"}`; scraping agresif → **checkpoint/lockout akun** (SMS/email verifikasi). Ini risiko terbesar.
- Visibilitas: halaman awal hanya memuat ±12 komentar "most relevant" di HTML; sisanya lewat API.
- Post viral → truncation pagination & reply bertingkat terbatas.
- Login gate: tanpa sesi, komentar **tidak bisa dimuat sama sekali** (beda FB/TikTok yang masih bisa lihat sebagian).
- Arsitektur web IG kini sering meniru Threads — endpoint/header bisa berubah kapan saja → **paling rapuh** dari ketiga platform.

### 3.2 Like — ❌ **Tidak mungkin**
Hasil riset tegas:
- IG **tidak menampilkan daftar liker di mana pun** (app maupun web) — hanya angka, atau pratinjau kecil liker terbaru (kadang disembunyikan penuh).
- **Graph API resmi tidak punya endpoint daftar likes** — hanya `like_count` / `total_like_count` / Insights. (Berbeda dengan FB yang punya edge reaksi.)
- Preferensi kreator "Hide like & share counts" bisa menyembunyikan bahkan angkanya.
- **Kesimpulan: MUSTAHIL untuk pihak mana pun** — jangan dikerjakan.

### 3.3 Link Instagram
| Bentuk URL | Contoh |
|---|---|
| Post (foto/korsel) | `instagram.com/p/{shortcode}/` |
| Reel | `instagram.com/reel/{shortcode}/` (juga `/reels/{shortcode}/`) |
| Share wrapper | `instagram.com/share/p/{shortcode}/` → redirect ke canonical |

**Shortcode → media_id** (dibutuhkan untuk memanggil API):
- Konversi base64 ala legacy **sudah tidak andal** terhadap endpoint modern.
- oEmbed resmi (`graph.facebook.com/.../instagram_oembed`) butuh token Meta + rate limit.
- **Rekomendasi:** jangan resolve sendiri — tiru pola TikTok: **capture template** URL API saat user membuka post (via `webRequest`), lalu replay. Ini menghindari masalah shortcode sepenuhnya.

---

## 4. Penguatan Riset (2026-08-10, sesi ke-2)

Riset ulang untuk memverifikasi/menguatkan detail implementasi komentar IG, TikTok & FB.

### 4.1 Instagram — koreksi & penguatan

- **Base host**: request bisa lewat `i.instagram.com/api/v1/...` (bukan hanya `www.instagram.com`). Capture `webRequest` & validasi template memakai substring `instagram.com/api/v1/media/` → aman untuk keduanya. ✅ sudah ditangani.
- **Field pagination sebenarnya** (sering salah ditulis di tutorial):
  - Top-level: **`has_more_comments`** (bukan `has_more`) + **`next_max_id`**; head-load: `has_more_headload_comments` + `next_min_id`.
  - Balasan: **`has_more_tail_child_comments`** + **`next_max_child_cursor`** (endpoint `.../comments/{id}/child_comments/` atau `inline_child_comments/` tergantung versi klien).
  - ✅ Engine v1.0.9 sudah membaca keempatnya (`parsePage(data, isReplyPage)`).
- **Batch keras 20 komentar/halaman** — pagination banyak halaman untuk post besar; pacing harus ekstra hati-hati.
- **Pacing yang disarankan komunitas**: exponential backoff 5–15 dtk antar halaman untuk scraper produksi; ekstensi memakai jitter 1,8–3,2 dtk + budget 150/run + berhenti dini saat 429/401/403/`status:fail` — kompromi antara kecepatan & keamanan akun. **Tetap risiko checkpoint**; hindari run beruntun.
- Tanpa `sessionid` → `302` ke login / `401` / `403`; sudah di-mapping ke pesan "Login Instagram diperlukan".

### 4.2 TikTok — penguatan

- Parameter wajib replay: `aweme_id`, `count`, `cursor`; `sortBy` opsional; `channel_id` jarang dibutuhkan. Balasan: `comment_id` + `item_id` + `count` + `cursor`. ✅ sesuai engine.
- **Signing**: klien otomatis tanpa `msToken`/`X-Bogus` ditolak `403`. Engine ini berjalan di MAIN world (fetch asal halaman + cookie sesi asli) sehingga memakai tanda tangan browser yang sah — inilah kenapa replay jalan di ekstensi tapi gagal di script biasa. Jangan hapus sanitasi `X-Bogus`/`msToken` dari URL **query replay** bila diperlukan (saat ini template ter-sanitasi, dan browser mengisi ulang kredensial — pantau saat regresi 403).
- **Cap pagination**: ±1.000–1.500 komentar per video untuk sesi login; anonim jauh lebih kecil (±100–200). Hasil di atas itu = `partial` — UI sudah menangani (kuning).
- **Soft block diam-diam**: HTTP `200` + `comments: []` + `has_more: false` — engine memperlakukan sebagai selesai (partial). Jangan dianggap bug.

### 4.3 Facebook — penguatan

- Nama query internal (`CometUFICommentsProviderPaginationQuery`) **berubah/obfuscated** antar deploy — strategi yang benar adalah **verifikasi by shape** (`page_info`, `end_cursor`) seperti engine sekarang, bukan by name. Query "dibangun dari URL" hanya fallback; bila ditolak FB, degradasi ke DOM. ✅ sudah diterapkan.
- Pagination Relay: `page_info.has_next_page` + `end_cursor` → `after` cursor. ✅ sesuai engine.
- Replay pakai cookie sesi (bukan app token) → tidak kena rate limit developer API, tapi memicu **behavioral anti-scraping** (429, lockout sementara, CAPTCHA) bila terlalu cepat — pertahankan jitter + cap 120 halaman + berhenti dini 429. ✅ sudah diterapkan.

---

## 5. Peta Implementasi (rekomendasi)

| Fitur | Prioritas | Effort | Catatan |
|---|---|---|---|
| **IG — Komentar (post & reel)** | ✅ **Selesai (v1.0.9)** | — | Username tanpa `@`; wajib login; budget 150/run; `has_more_comments`/`next_max_id` + child cursor; UI peringatan login |
| TikTok — Like | Ditunda | Sedang | Reuse arsitektur komentar; cap ±1–2rb — dikerjakan belakangan jika diminta |
| FB — Like skala besar | Skip | — | Hanya subset yang tampil di dialog |
| IG — Like | ❌ Skip | — | Tidak ada data di platform |

**Yang bisa dipakai ulang dari kode sekarang untuk IG:**
- `webRequest` capture template (pola TikTok) → session storage + TTL.
- Replay cursor + budget request + jitter delay (pola `paginateList`).
- Auto-open panel komentar (pola `tryOpenComments`).
- Fallback DOM → API.
- Normalisasi nama + dedup + ekspor (sudah agnostik platform via `normalizeName(name, platform)`).

**Risiko wajib dipahami sebelum IG:**
1. Butuh sesi login user (`sessionid`) — produk jadi "wajib login IG" (bedakan dari FB/TikTok yang lebih permisif).
2. Risiko checkpoint akun jika pacing kurang hati-hati → budget ketat (mis. 150–200 request/run) + delay besar.
3. Endpoint private bisa berubah → simpan template dengan TTL pendek + pesan error yang jelas.

---

## 6. Catatan Metodologi
- Sumber: riset web terhadap dokumentasi resmi (Graph API Meta, TikTok for Developers), dokumentasi tool pihak ketiga (Instaloader/instagrapi), dan perilaku endpoint private/web yang terdokumentasi komunitas.
- Semua klaim "cap/limit" adalah hasil observasi komunitas & dokumentasi — **bukan kontrak resmi**; validasi lapangan di halaman asli tetap wajib.
- Prinsip desain yang dijaga: data hanya nama publik; tanpa backend; tanpa API key; sesi user tidak pernah disimpan permanen (template TikTok disimpan di session storage dengan TTL).

---

## 7. Riset Ulang & Audit Instagram (2026-08-11)

### 7.1 Riset web 2026 — status endpoint & keamanan

- **Endpoint private REST masih valid.** `www.instagram.com/api/v1/media/{media_id}/comments/?can_support_threading=true&max_id={cursor}` dan host `i.instagram.com/api/v1/...` tetap dipakai web IG; header `X-IG-App-ID: 936619743392459` (desktop web) masih berlaku di tool komunitas (granary, ScrapFly, 2026). ✅ Engine sudah memakai keduanya (substring `instagram.com/api/v1/media/` aman untuk `www`/`i`).
- **Kenapa ekstensi ini jalan padahal scraper script gagal:** pertahanan anti-bot 2026 = ~200 request/jam/IP (non-login), IP datacenter diblokir instan, TLS fingerprinting ketat. Ekstensi berjalan di **browser asli user** (TLS asli + sesi asli + IP rumah) sehingga replay API lolos — arsitektur ini tervalidasi.
- **Login gate makin ketat:** tanpa sesi, komentar tidak bisa dimuat sama sekali; sejak 2024 hashtag/search native juga di-login-gate. Pre-check `sessionid` ✅ tepat.
- **Error taxonomy (best practices instagrapi 2026) — bedakan, jangan retry seragam:**
  - `429` / ClientThrottledError → backoff; 
  - **`PleaseWaitFewMinutes`** → lebih serius dari 429, **jangan retry dalam loop** (jeda menit);
  - `FeedbackRequired` → akun dibatasi → berhenti; 
  - `LoginRequired` → sesi invalid; 
  - `ChallengeRequired` / Bloks redirect / `/auth_platform/` → verifikasi manual di app/web resmi.
- **Reuse sesi browser yang sudah ada = pola teraman** (instagrapi menekankan hindari fresh login berulang) — ekstensi tidak pernah login sendiri, hanya memakai sesi user ✅.
- **Alternatif resmi (bukan pengganti):** Graph API `/{media-id}/comments?fields=username,text` hanya untuk post milik Business/Creator yang terhubung token, kuota ~200 call/jam/akun, butuh Meta app review — tidak berlaku untuk post orang lain. Tetap rekomendasi: private web API + sesi user.

### 7.2 Audit kode IG (v1.0.14)

**P1 — benar, wajib diperbaiki:**
1. **Template tidak difilter media → replay post yang salah.** `GET_TEMPLATE` (background) mengembalikan template media mana pun (memanggil `getIgReplayTemplate()` tanpa `requiredMediaId`), `content-ig` tidak mengirim `mediaId` saat START, dan `buildUrl` engine **tidak menulis ulang `media_id` di path**. Bila user buka post B lalu Proses tanpa membuka komentar dulu (template lama post A masih valid dalam TTL 30 mnt) → engine mengambil komentar **post A**. Fix: kirim `mediaId` halaman saat START + rewrite segmen media di `buildUrl` (pola `aweme_id` TikTok), atau tolak template yang media-nya tidak cocok.
2. **Budget balasan 40 per-halaman, bukan per-run.** `let replyUsed = 0` berada di **dalam** loop halaman (`paginateList`) → di-reset tiap halaman; satu-satunya cap global adalah `BUDGET = 150`. Klaim CHANGELOG v1.0.12 "40 request/run" tidak sesuai kode. Fix: pindahkan `replyUsed` ke luar loop (pola `replyRequests` di FB).
3. **`rate_limit` belum jadi `stopReason` resmi** (beda dari FB/TT): engine mengirim `timeout` + postHint 429, dan `mapDone` content-ig tidak punya branch `rate_limit` (dengan hasil → status "done" hijau, padahal harus *partial*). Fix: emit `stopReason: "rate_limit"` + branch di `mapDone`.
4. **`PleaseWaitFewMinutes` / `FeedbackRequired` di JSON `status:"fail"` diklasifikasikan error generik** (bukan rate limit) → diagnosis salah dan tidak "berhenti agar akun aman". Fix: peta ke rate_limit/blocked.
5. **Sleep non-interruptible tersisa di fase awal:** `tryOpenComments` (`sleep(600)`), retry buka komentar & tunggu template (`sleep(700)`/`sleep(300)`), mode scroll (`sleep(900)`) — tidak responsif ke Stop (FB/TT sudah 100% `sleepWhile`). Fix: konversi.

**P2 — penguatan lanjut:**
6. HTTP 403 dikonfirmasi sebagai "login" padahal sering = blok anti-bot/app-id mismatch → pesan menyesatkan.
7. Tidak ada pre-check `no_media` di `startInstagram` (TikTok punya `no_video`): di halaman profil, 45 dtk terbuang dalam mode scroll.
8. Endpoint balasan **hardcode** `inline_child_comments/`; riset mencatat `child_comments/` juga dipakai tergantung versi klien → tambah fallback.
9. Header opsional `X-IG-WWW-Claim` bisa menstabilkan 403 sesekali (belum dipakai).
10. Edge: Stop ditekan saat backoff 429 → pesan tetap "Rate limit (429)" bukan "Dihentikan".
11. Tidak ada cooldown antar-run beruntun padahal seksi 4.1 menyarankan menghindarinya.

**✅ Sudah benar:** pre-check login (`sessionid`), backoff 429 hormati `Retry-After` + heartbeat PROGRESS, deteksi checkpoint terpisah (partial jika ada hasil), empty-page retry 2×, budget global 150 + pacing 1,8–3,2 dtk antar halaman, normalisasi username (lowercase, tanpa @), pesan platform-aware (`username` vs `nama`), TTL template 30 mnt, capture aman untuk `www`/`i.instagram.com`.

## 8. Audit Menyeluruh — Daya Tahan & Konsistensi UI/UX (2026-08-11, v1.0.16)

Audit seluruh codebase (3 engine + 3 panel + popup + options + background + shared + tests) untuk dua dimensi: **daya tahan** (resilience) dan **konsistensi UI/UX**.

### 8.1 Daya tahan — temuan

**P1 — nyata & berdampak:**
1. **IG: webRequest capture tanpa guard mid-run** (`background.js` ~baris 400–432). TikTok punya guard "jangan timpa template video yang sedang diproses" (`background.js` 466–490), Instagram **tidak**: saat run aktif, API komentar post lain (user scroll ke post/reel beda) menimpa template di session storage. Mitigasi parsial sudah ada (engine menulis ulang `media_id` di `buildUrl`, v1.0.15), tapi jika URL shape beda (post vs reel) pagination bisa menyimpang; dan template untuk run berikutnya menunjuk post yang salah. **✅ Diperbaiki v1.0.17** — guard meniru TikTok: bila run aktif memproses media X dengan template valid, capture media lain dilewati.
2. **FB: tanpa total request budget** (`inject-fb.js` — tidak ada `requestBudget` sama sekali; TT 350, IG 150). Satu-satunya guard: `pages > 120` + `REPLY_BUDGET 40`. Worst case: 120 halaman + 25 thread balasan × 8 halaman ≈ 320 request/run, dan README mengklaim "batas request per run" untuk semua platform. **✅ Diperbaiki v1.0.17** — `requestBudget 350` (cek di loop utama & loop balasan).
3. ~~TT: intercept XHR tidak difilter video aktif~~ — **false positive (dikoreksi)**: `tryParseResponse` (`inject-tiktok.js` 204–209) memanggil `payloadMatchesVideo` untuk **kedua** jalur (fetch 218 & XHR 248). Residual: filter bersifat longgar by design (payload berisi `"comments"`/`has_more` lolos walau tanpa aweme) karena payload komentar kadang tidak menyertakan aweme — risiko rendah, page tidak memuat komentar video lain saat run.

**P2 — penguatan / konsistensi antar-platform:**
4. **`getDtsg`/`getLsd` menserialisasi `document.documentElement.innerHTML`** (`inject-fb.js` 499 & 544). DOM Facebook bisa megabyte; di-cache 5 menit (sekali per TTL), tapi tetap berat dan bisa freeze singkat. **✅ Diperbaiki v1.0.18** — urutan ringan: `require("DTSGInitialData")`/modul memory → scan `<script>` tag terbatas (lewati >400 KB) → input form → innerHTML hanya fallback terakhir.
5. **Tidak ada pre-check login TikTok** (IG punya `CHECK_IG_LOGIN`). TikTok comment/list kadang jalan tanpa login, jadi risiko rendah — tapi run di akun logout membuang waktu & request. **✅ Diperbaiki v1.0.18** — `CHECK_TT_LOGIN` (cookie `sessionid` tiktok.com) di `startTikTok` (popup/shortcut/context menu) & `startExtract` (panel): gagal cepat dengan pesan "Sesi TikTok tidak aktif…". Tradeoff jujur: run tanpa login yang sebelumnya mungkin lolos via intercept/DOM kini diblokir — replay API memang bergantung pada sesi.
6. **FB: `tryOpenComments` menganggap "sudah terbuka" bila `gqlTemplates.size > 0`** — template lama dari post lain masih hidup → bisa skip buka komentar post aktif. Minor (GraphQL replay tetap menyasar via template yang diverifikasi probe). Belum diperbaiki (risiko rendah).
7. **IG cooldown 15/60 dtk hanya di content script** — sudah tercakup semua jalur start (popup/shortcut/context menu melewati content), tapi timestamp tidak dipersist; refresh halaman = cooldown hilang. Minor. Belum diperbaiki.
8. **TT: tanpa `blocked` (403) mapping** — 403 TT jatuh ke error generik `API 403: ...` (bukan diagnosis anti-bot seperti IG). Minor (TT jarang 403 di API web). Belum diperbaiki.

**✅ Yang sudah kuat (terverifikasi):** normalisasi 7 salinan + fixture test anti-drift; typed errors + backoff 429 (Retry-After, 8→16s, max 2) + retry jaringan di 3 engine; empty-page retry 2× di 3 engine; reply budget 40 per-run (IG benar sejak v1.0.15); `sleepWhile` interruptible di 3 engine (sisa `sleep(80)` hanya menunggu run lama berhenti); rewrite `media_id`/`aweme_id`; pre-check login IG + `no_media` + `no_video`; TTL + sanitize template; ownership run satu-per-platform + anti-hijack tab; tab ditutup → run di-finalisasi; persist hasil lintas restart + restore; 57 test hijau + syntax + build.

### 8.2 Konsistensi UI/UX — temuan

**✅ Design system sudah solid:** token `--rs-*` identik di 6 stylesheet (popup/options/3 panel); bahasa animasi seragam (shimmer/breathe/blink/rise); semantik warna status seragam (partial=amber, error=danger, done=success); theme Sistem/Terang/Gelap diterapkan di semua permukaan; hierarki tombol seragam (primary & success full-width, ghost); aria-live + focus-visible + tooltips.

**Inkonsistensi nyata:**
1. **Popup memakai kata "nama" untuk Instagram** (`popup.js` 127/178/208/315/359): count "42 nama", tombol "Copy nama (42)", header CSV "Nama", toast "Tersalin 42 nama" — padahal panel IG benar memakai "username" dan README/menunya bilang username. Fix: label platform-aware di popup (helper `wordFor(platform)`).
2. **Hint popup lupa Instagram** (`popup.js` 124): "Buka tab Facebook atau TikTok untuk mulai." → tambah Instagram.
3. **`reasonToMessage` rate_limit non-FB memakai kata "data"** (`shared.js`): "5 data terkumpul" vs panel TT/IG yang memakai "nama"/"username". Fix: platform-aware.
4. **Popup hardcode key storage `fnk_state/tnk_state/ing_state`** (`popup.js` 440–447) — bukan konstanta `STORAGE_KEY_*` dari shared → risiko drift.
5. **Pesan DONE FB menyisipkan suffix `[graphql]`/`[dom]`/`[error]`** (`content-fb.js`) — TT/IG tidak. Format pesan akhir tidak seragam.
6. **Model interaksi panel berbeda:** FB = chip inline di bar Like/Comment/Share (klik = proses, klik lagi = copy, tidak ada FAB); TT/IG = FAB (klik = buka panel, tidak ada copy-on-click). FB panel default collapsed; TT/IG default expanded.
7. **Glyph tombol tutup tidak seragam:** FB `×`, TT/IG `–`.
8. **FB panel tanpa badge API** (TT/IG punya "API komentar: siap") — wajar karena FB punya synthetic template, tapi user tidak mendapat umpan balik status kesiapan yang sama.
9. **Gap fitur popup vs panel:** popup punya search/sort/CSV/merge/backup/restore; panel hanya Proses/Stop/Copy/Reset.
10. **`mergeNames(..., null)` memakai normalizer FB** → nickname TikTok emoji-only ("😀") hilang saat "Gabung Semua". Minor.
11. **Popup double-render:** poll 1200 ms + `storage.onChanged` serentak.
12. **Checkpoint IG tanpa count di pesan panel** (`content-ig.js`) padahal rate_limit/blocked menyertakan count. Minor.

### 8.3 Rekomendasi prioritas

1. **P1 #1–#3 (daya tahan):** guard template IG mid-run, filter XHR TT, `requestBudget` FB → pola sudah ada di engine lain, eksekusi cepat & aman (v1.0.17).
2. **UI #1–#2 (label IG + hint):** cepat, dampak konsistensi terbesar (bisa digabung di v1.0.17).
3. **P2:** getDtsg ringan, pre-check login TT, reasonToMessage "data"→platform-aware, konstanta storage di popup.
4. **✅ Selesai v1.0.18:** FAB ditambahkan di Facebook — ketiga platform kini punya FAB pojok kanan-bawah (buka panel, badge jumlah, pulse running, warna done); chip inline FB dipertahankan sebagai bonus native. **✅ Badge API FB selesai v1.0.19** (panel + popup, via helper `isFacebookPostPage` ter-uji). Sisa: parity fitur panel (search/CSV/merge di panel) — opsional v1.1+.

### 8.4 Kritik konsistensi UI/UX & perbaikan v1.0.20

Kritik mendalam 2026-08-11 (dari audit menyeluruh seksi 8.2 + verifikasi kode):

- **A1 — model interaksi dua wajah:** chip inline FB (klik = langsung PROSES / copy) vs FAB (buka panel). **✅ Fixed v1.0.20** — chip = buka panel + tandai post (perilaku seragam dengan FAB); status visual chip tetap (badge jumlah, pulse, warna done). Tradeoff jujur: power-user yang suka proses-sekali-klik harus buka panel dulu — konsistensi dipilih.
- **A2 — default visibility beda** (FB collapsed vs TT/IG expanded): **✅ Fixed v1.0.23** — FB kini *expanded saat ada hasil*: boot me-restore hasil tersimpan + buka panel, run selesai dengan hasil membuka panel, toggle manual (`min`) tetap dihormati (`userCollapsed`), tanpa hasil panel tetap collapsed di feed.
- **A3/A4/A5 — kopi basi:** hint FB, steps popup FB, pesan "ikon extension". **✅ Fixed v1.0.20.**
- **B1–B5 — terminologi:** "Sertakan balasan (reply)", "copy ke Excel", placeholder search platform-aware, nama file CSV, warna badge FAB. **✅ Fixed v1.0.20** (B5: IG #262626→#161823).
- **E1 — aksesibilitas:** tidak ada `prefers-reduced-motion` di 5 stylesheet. **✅ Fixed v1.0.20** — di halaman host di-scope ke `#xxx-root` agar tidak menyentuh animasi platform.
- **C1 — gap fitur panel vs popup** (search/sort/CSV/merge hanya di popup): **✅ Fixed v1.0.26** — parity penuh: tiap panel FB/TT/IG kini punya search live, Urutkan A–Z, preview daftar (maks 40), CSV platform-aware, dan Gabung (via `MERGE_ALL` di background — content script hanya membawa normalizer platform-nya sendiri, jadi merge lintas platform harus jalan di shared/background). Copy/CSV menghormati filter ("X dari N"). Backup/restore masih eksklusif popup (sengaja — ruang panel terbatas).
- **C2 — switch (options) vs checkbox (popup/panel) untuk setting sama:** belum — sengaja (language kontrol berbeda per konteks), bisa dipertimbangkan di v1.1.
- **D1 — dua sumber pesan (localDoneMessage vs reasonToMessage):** **✅ Fixed v1.0.24** — helper tunggal `doneMessage` di shared.js (blok `BEGIN-RESO-DONEMSG`, 4 salinan dijamin fixture test): `reasonToMessage` delegasi; ketiga panel + jalur stop-finalize memakai helper. Drift tertutup: suffix `[graphql]/[dom]` FB dihapus (mode tetap di baris "Target:"), checkpoint IG kini menyertakan count, timeout seragam "Klik Copy", wording rate-limit platform-aware, `wordFor` diekspor (popup memakai).
- **E2 — GET_STATE hasTemplate asimetris (TT di-recompute, IG tidak):** **✅ Fixed v1.0.21** — IG kini di-recompute juga (TTL 30 mnt + shape), badge popup selalu akurat. **Panel TT/IG v1.0.27:** `storage.onChanged` mere-validasi via GET_TEMPLATE (bukan nilai mentah) dan boot menerapkan hasTemplate tanpa syarat — badge panel selalu akurat seperti popup.

---

## 9. Audit Motion — 2026-08-11 (v1.0.22)

### Inventaris sebelum fix (5 stylesheet)

| Surface | Animasi/transisi | Masalah |
|---|---|---|
| popup.css | fade-in body, transition icon-btn 0.08s, badge slide/scale, shimmer | easing generik `ease`, durasi acak (0.08–0.3s), tanpa token |
| options.css | card hover, switch 0.2s, segment, toast | easing `ease` bercampur, durasi tak konsisten |
| content-fb.css | panel slide, chip, badge, shimmer/breathe/blink | collapse panel **abrupt** (tanpa transisi), count/badge/status tanpa transisi |
| content-tiktok.css | panel, badge, pulse, shimmer | count/badge/status tanpa transisi, FAB badge muncul instan |
| content-ig.css | panel, badge, pulse, shimmer | sama dengan TT |

### Perbaikan (v1.0.22)
1. **Token motion** di 5 stylesheet: `--rs-ease`, `--rs-ease-soft`, `--rs-dur-fast/.base/.slow`, `--rs-motion: cubic-bezier(.22,.61,.36,1)`.
2. **Soft motion block** per surface: icon button, badge, status, count, tombol, preview, steps, cards, switch, toast, collapse panel (visibility-based + fade/rise 0.3s), FAB badge pop.
3. **`prefers-reduced-motion`** tetap dimatikan untuk semua gerak baru (warisan v1.0.20, di-scope `#xxx-root` di halaman host).

### Keputusan
- Collapse panel FB sekarang fade+rise 0.3s dengan `visibility` delayed — tidak lagi abrupt, tetap tidak mengganggu feed.
- Durasi standar: fast 0.12s (hover), base 0.2s (state umum), slow 0.3s (entrance/collapse). Easing seragam `--rs-motion`.

---

## 10. Audit Detail UI/UX — 2026-08-11 (v1.0.24)

### 🔴 P1 — bug nyata (terverifikasi runtime)

| # | Temuan | Bukti |
|---|---|---|
| **1** | **`wordFor(p)` ReferenceError di handler "Ekspor CSV"** — variabel `p` tidak ada di scope `btnCsv` (popup.js:386). File CSV tetap ter-download (dipanggil duluan), tapi toast konfirmasi gagal + unhandled rejection di setiap klik | `grep -n 'wordFor(' popup.js` — line 386 satu-satunya di luar `render()` yang pakai `p`; handler `btnCopy` benar pakai `platform` |
| **2** | **"Gabung Semua" bocor 2 nama dari 6** (verifikasi `node -e`): ① `mergeNames(..., null)` menerapkan aturan FB ke TT/IG → `@user123` & `😀` TikTok ter-drop; ② pemanggilan bertahap per-platform pun rusak karena `mergeNames` menormalkan ulang `existing` dengan platform incoming → FB "Andi Pratama" hilang saat langkah IG (`normalizeInstagramUsername` menolak spasi) | 6 nama → 4 di kedua cara; butuh helper `mergeAcrossPlatforms` yang menormalkan tiap nama dengan platform-nya sendiri |

### 🟡 P2 — jargon & microcopy

| # | Temuan |
|---|---|
| **3** | Hint menampilkan detail teknis mentah: popup/panel FB "Target: templates:2 buffer:5" (saat running) dan "Target: graphql" (setelah done); TT "Video: 7290000000000000000" (aweme_id); IG "Target: 1234567890" (media_id). Setelah v1.0.24 suffix `[graphql]` dihapus dari pesan, tapi baris "Target:" masih jargon — setengah-setengah. |
| **4** | Tidak ada jalur keyboard Esc untuk menutup panel (3 platform) — hanya FAB/min/ikon bar Like. |

### 🟡 P3 — detail UX kecil

| # | Temuan |
|---|---|
| **5** | Popup double-render: poll `setInterval(refresh, 1200)` + `storage.session.onChanged` — dua sumber update (dari audit lama, masih ada). |
| **6** | Filter aktif 0-match: count tetap "1500 nama" tapi tombol Copy disabled → ambigu; saran tampilkan "0 dari 1500". |
| **7** | FAB title statis (FB "Nama Komentar") saat running/done — chip bar Like sudah update title ("Proses berjalan…"), FAB tidak. |

### ✅ Sudah benar (diverifikasi 2026-08-11)
- Label platform-aware (Copy/CSV/placeholder) via `wordFor` dari shared — satu sumber.
- `doneMessage` satu sumber + fixture parity 4 salinan (v1.0.24).
- Reset saat running → `stopActiveRun` dipanggil (aman, tidak membunuh run di tab lain).
- `focus-visible`, `prefers-reduced-motion`, `aria-live` di semua permukaan.
- Copy fallback lewat halaman saat clipboard gagal; toast status ada di tiap aksi utama.

### Status eksekusi — ✅ v1.0.25 (2026-08-11)
1. **P1 #1 (CSV)**: ✅ Fixed — `wordFor(res?.platform || currentPlatform)`.
2. **P1 #2 (Gabung)**: ✅ Fixed — `mergeAcrossPlatforms` di shared.js (normalisasi per-platform, dedupe case-insensitive) + 3 unit test; popup memakai.
3. **P2 #3 (jargon)**: ✅ Fixed — hint teknis dikosongkan saat status done/partial/stopped/error di popup + 3 panel; tetap tampil saat running.
4. **P2 #4 (Esc)**: ✅ Fixed — Esc menutup panel di 3 platform (FB juga set `userCollapsed`).
5. **P3 #5 (double-render)**: ✅ Fixed — poll 1,2 dtk dihapus (onChanged session sudah mencakup semua `setState`).
6. **P3 #6 (filter 0-match)**: ✅ Fixed — count "X dari N" saat filter aktif.
7. **P3 #7 (FAB title)**: ✅ Fixed — title/aria dinamis di 3 panel.

## 11. Audit Mendalam Facebook + Riset Permalink — 2026-08-11 (v1.0.27)

### 11.1 Ringkasan eksekutif
Audit membaca `inject-fb.js` utuh (1.739 baris), jalur `startFacebook` → `START_EXTRACT` → `runExtract` di background/content, plus 3 salinan deteksi URL permalink. **Kesimpulan: engine GraphQL-nya kuat (backoff 429, retry jaringan, guard no_login, budget request, DOM fallback), tapi deteksi permalink punya celah nyata — terutama untuk bentuk URL yang justru paling umum dipakai saat ini (`/watch?v=`, slug posts, album `/media/set/`).** Verifikasi lapangan di browser asli tetap wajib — audit ini berbasis kode + bentuk URL yang terkonfirmasi riset web.

### 11.2 Riset — bentuk URL permalink FB 2025/2026 (per jenis postingan)
Tabel hasil riset web (contoh URL riil ditemukan di index Google, 2026-08-11):

| Jenis postingan | Bentuk URL permalink | Didukung? | Catatan |
|---|---|---|---|
| **Teks** (post biasa) | `facebook.com/<page>/posts/<id>` | ✅ | `id` = feedback/story id — benar untuk synthetic query |
| **Teks** (gaya baru) | `facebook.com/<page>/posts/<slug>/<id>` | ❌ **MISS** | FB kini memakai slug + id numerik di akhir (contoh riil: `LaraFabianTheNetherlands/posts/2-photos-source-.../960401149426609/`). Regex `/posts/\d+` tidak cocok karena ada slug |
| **Teks** (grup) | `facebook.com/groups/<gid>/posts/<id>` (dan versi slug) | ✅ / ⚠️ | `/posts/<id>` cocok; versi slug sama-sama MISS |
| **Teks** (legacy) | `permalink.php?story_fbid=<id>&id=<page>` | ✅ | `story_fbid` = feedback id — benar |
| **Teks** (legacy) | `story.php?story_fbid=<id>` | ✅ | Benar |
| **Foto tunggal** (legacy) | `photo.php?fbid=<id>&set=a.<album>.<user>.<story>` | ✅ | `fbid` dipakai langsung — OK untuk post 1 foto |
| **Foto / album (kolektif)** | `media/set/?set=a.<album>.<user>.<story>` (+ `&type=3`) | ❌ **MISS** | Story id ada di komponen ke-3 (`a.757108353089224.1812885352.1020472719478` → ambil `1020472719478`). Tanpa ini, album tidak bisa synthetic-paginate |
| **Foto / album** (gaya baru) | `<page>/photos/a.<uid>.<fbid>` | ❌ **MISS** | `fbid` = segmen terakhir setelah titik — komentar album ada di story ini |
| **Foto** (permalink foto) | `<page>/photos/<photo_id>` | ⚠️ | Cocok, tapi `<photo_id>` ≠ story id → synthetic pakai id salah (GraphQL error/wrong thread) |
| **Video** (watch, paling umum) | `facebook.com/watch?v=<id>` / `watch/?v=<id>` | ❌ **MISS** | Bentuk watch aktual adalah `?v=`, bukan `/watch/<id>`. Regex `\/watch\/\d+` tidak pernah cocok |
| **Video live** | `facebook.com/watch/live/?ref=watch_permalink&v=<id>` | ❌ **MISS** | Sama — `v=` query param tidak dicek |
| **Video** (legacy) | `video.php?v=<id>` | ❌ **MISS** | `v` tidak termasuk param yang dicek |
| **Video** (halaman video) | `<page>/videos/<id>` | ✅ | Video id umumnya == story id — OK |
| **Reel** | `facebook.com/reel/<id>` | ✅ | OK |
| **Short link** | `fb.watch/<code>` | ⚠️ redirect | Redirect ke `/watch?v=` atau `permalink.php`; setelah redirect tab URL jadi bentuk di atas — gap `watch?v=` ikut terkena |
| **Profil** (bukan post!) | `facebook.com/<8+ digit user id>` | ❌ **FALSE POSITIVE** | Regex pathname `^\d{8,}$` menyangka ini halaman post → badge "API siap" + synthetic query dengan user id → probe gagal |

### 11.3 Temuan kode — 3 salinan deteksi URL (drift + gap identik)
Deteksi permalink diduplikasi di 3 tempat dengan pola yang sama, dan ketiganya punya gap yang sama:
1. `shared.js` `isFacebookPostPage(url)` (baris ~61–91) — dipakai panel/popup.
2. `inject-fb.js` `feedbackIdFromUrl()` — dipakai synthetic template (pagination tanpa capture).
3. `content-fb.js` `fbGraphqlReady()` (badge "API komentar: siap") — salinan ketiga.

Perbedaan halus yang terverifikasi:
- **Dead branch di inject-fb.js**: regex `^\/(\d{8,})` di-*anchor* ke awal string `location.href` ("https://…") → **tidak pernah cocok**. Untungnya menyelamatkan dari false positive user-id, tapi itu kebetulan, bukan desain.
- **False positive di shared.js & content-fb.js**: cek `new URL(href).pathname` terhadap `^\d{8,}$` **aktif** → halaman profil `facebook.com/100000123456789` dilaporkan sebagai post page (badge hijau + synthetic dengan id user).

### 11.4 Temuan per jenis postingan (dampak ke user)
1. **Teks**: Aman di bentuk lama; **slug-posts gaya baru gagal synthetic** → run mengandalkan capture+DOM saja. Dampak nyata: di permalink slug, badge bilang "belum" padahal halaman sah, dan pagination GraphQL aktif hanya kalau user sudah membuka komentar dulu.
2. **Foto/gambar kolektif (album)**: **Paling lemah.** `media/set/?set=a.X.Y.Z` dan `photos/a.U.F` tidak dikenali sama sekali; `photos/<photo_id>` dikenali tapi id-nya id foto, bukan id story — synthetic query ke feedback yang salah. Komentar album (yang berisi kolektif gambar) praktis hanya bisa lewat capture+DOM.
3. **Video**: `/videos/<id>` dan `/reel/<id>` aman; **dua bentuk paling umum — `/watch?v=` dan `video.php?v=` — tidak dikenali** → sama seperti slug-posts: badge "belum", synthetic tidak terbentuk. Ironis: v1.0.14+ memperkuat video, tapi deteksi URL-nya tertinggal.
4. **Profil user-id**: false positive → user di halaman profil melihat badge "API komentar: siap" dan Proses membuang 1–2 request probe sebelum jatuh ke DOM kosong.

### 11.5 Temuan robustness lain (bukan URL)
1. **Tidak ada filter feedbackId** (setara `mediaId filter` IG yang sudah diperbaiki di v1.0.15). `orderedCandidates()` hanya memilah by shape + recency, **tanpa mencocokkan `variables.feedbackID`/`feedback_id`/`id` template terhadap `feedbackIdFromUrl()`**. Di halaman permalink dengan konten sidebar/iklan, engine bisa mem-paginate template komentar **postingan lain** yang kebetulan ter-capture. Rekomendasi: saat URL memberi feedback id, urutkan candidate yang id-nya cocok di depan (fallback ke semua bila tak ada yang cocok) — pola yang sama dengan guard template IG/TikTok.
2. **Probe gagal → tetap paginate**: jika semua probe error non-429/non-login, kode lanjut `template = candidates[0]` dan terus paginate (sampai budget). Dengan filter (11.5.1) risiko memaginate thread salah berkurang drastis.
3. **HTTP 200 + `errors` GraphQL tidak didiagnosis**: `findPageInfo` null → 2× retry cursor sama → reason "idle" → DOM. User tak diberi tahu bahwa feedback id-nya salah/tidak publik. Cek `errors` array di respons akan menghemat waktu & request.
4. **`findPostRoot` di halaman watch/album**: pagelet watch (`CometWatchFeedQuery` dst) dan album tidak cocok dengan selector `data-pagelet*="Permalink"`/`CometSinglePost` → jatuh ke `[role=main]`. DOM tetap jalan, tapi scoping kurang presisi.
5. **Reply template classification** berbasis nama (`reply|depth1|replies`) — masuk akal, tapi query balasan modern yang bernama tanpa kata kunci itu bisa salah klasifikasi jadi top-level; dampak kecil (hanya urutan candidate).

### 11.6 Yang sudah benar (diverifikasi di kode)
- `graphqlReplayWithBackoff`: 429 hormati `Retry-After` (cap 20 dtk) + eskalasi 8→16 dtk, maks 2 retry, hanya jika sisa waktu cukup; retry 1× untuk blip jaringan; heartbeat PROGRESS saat menunggu.
- Deteksi `no_login` ganda: `res.redirected` ke /login **dan** body HTML login dengan HTTP 200.
- Budget request (350) + batas halaman (120) + batas balasan (40) — akun tidak di-hammer.
- Synthetic template memakai variabel kontrak nyata (`CometUFICommentsProviderPaginationQuery`-style: feedbackID, count, cursor, feedbackSource 44, actionSource, queryPath "/comments/pagination/", dll.) — cocok dengan pola scraper publik.
- Token anti-forgery ringan & di-cache 5 menit (require → scan `<script>` terbatas → form → innerHTML fallback).
- Reply harvest via `feedback.replies_fields.total_count` + antrean unik (maks 25 thread, 8 halaman/thread).
- `findFeedbackIds` memanen id `feedback:*` dari respons — dasar untuk perbaikan 11.5.1.

### 11.7 Rekomendasi prioritas (usulan v1.0.28)
| # | Prioritas | Perbaikan |
|---|---|---|
| **P0** | Satu sumber deteksi URL | `extractFbFeedbackId(url)` di shared.js (blok marker baru, mis. `FBURLS`) + byte-copy ke `inject-fb.js` & `content-fb.js`, di-fixture-test (layout + parity + behavior). Ketiga konsumen (badge, synthetic, pre-check) otomatis sinkron |
| **P0** | Tutup bentuk URL yang MISS | Tambah: `watch?v=`, `watch/?v=`, `watch/live/?v=`, `video.php?v=`, `media/set/?set=a.X.Y.Z` (ambil Z), `photos/a.U.F` (ambil F), `posts/<slug>/<id>` (ambil id akhir); buang false positive bare numeric pathname |
| **P1** | Filter feedbackId (setara IG v1.0.15) | `orderedCandidates()` cocokkan `variables.feedbackID/feedback_id/id` terhadap `extractFbFeedbackId()` saat tersedia; plus deteksi `errors` GraphQL → stop dini dengan pesan jelas |
| **P2** | Badge akurat | Badge "API komentar" memakai `extractFbFeedbackId` — hijau hanya pada bentuk permalink yang benar-benar di-support (bukan profil, bukan watch yang tak dikenali) |

**Verifikasi lapangan wajib** (tidak bisa dari sini): buka masing-masing bentuk URL di atas di browser + login, jalankan Proses, cek hasil. Khusus album multi-foto: pastikan synthetic feedback id = story id (komponen terakhir `set=a.`), bukan album id.

### Status eksekusi — ✅ v1.0.28 (2026-08-11, setelah laporan lapangan)
Laporan lapangan user: "klik gambar 1 di postingan gambar kolektif → permalink API tidak ditemukan; foto/video tunggal sekali klik langsung dapat" — persis gap 11.2/11.4. Eksekusi:
1. **P0 (satu sumber)**: ✅ Fixed — blok `FBURLS` (`extractFbFeedbackIds`/`extractFbFeedbackId`/`isFacebookPostPage`) di shared.js; byte-copy ke `inject-fb.js` & `content-fb.js`; fixture test layout + parity 3 salinan + behavior 22 kasus URL. Badge FB (`fbGraphqlReady`) kini tinggal `isFacebookPostPage(location.href)`.
2. **P0 (tutup bentuk URL)**: ✅ Fixed — `posts/<slug>/<id>`, `watch?v=`/`watch/?v=`/`watch/live/?v=`, `video.php?v=`, `media/set/?set=a.X.Y.Z` (ambil Z), `photos/a.U.F` (ambil F), nilai pfbid alfanumerik di `story_fbid`/`fbid`; false positive bare numeric pathname dihapus (profil `facebook.com/<user id>` → false).
3. **P1 (filter feedbackId)**: ✅ Fixed — `orderedCandidates` mengutamakan template (capture + synthetic) yang `variables.feedbackID/feedback_id/id`-nya cocok dengan id URL; synthetic **selalu** ditambahkan saat URL memberi id (bukan hanya saat tak ada capture) → halaman album/watch/slug langsung paginate tanpa perlu komentar ter-capture. Plus deteksi `errors` array GraphQL → `kind=graphql_error`, probe kandidat berikutnya (bukan diam-diam "idle").
4. **P2 (badge akurat)**: ✅ Fixed — badge hijau hanya untuk bentuk permalink yang didukung; profil/feed/watch-bare → "belum".

Catatan jujur: untuk `photos/<photo_id>` (permalink foto tunggal bentuk lama), id di URL adalah id foto — kandidat di-probe; bila salah, kandidat lain (mis. dari `set=`) di-probe berikutnya, lalu DOM fallback. Verifikasi lapangan bentuk album (setelah fix) tetap wajib: buka album → klik gambar 1 → Proses → cek badge & hasil.

**Amendemen v1.0.28 — temuan lapangan URL multi-foto (`set=pcb.`)**: user melampirkan URL DevTools riil saat klik gambar 1 di postingan gambar kolektif: `facebook.com/photo?fbid=1483436860484357&set=pcb.1483436933817683` (post induk: `kominfojember/posts/pfbid02oqm…`). Temuan: ① path `/photo` (tanpa `.php`) — sudah tertangkap via param `fbid`; ② prefix `set=pcb.` = *photo collection bundle* (postingan multi-foto), id setelah `pcb.` adalah **story id postingan** — blok FBURLS sebelumnya hanya mengenal prefix `a.` sehingga story id tidak diekstrak dan probe menyasar `fbid` (id foto) yang salah. Perbaikan: `set=pcb.<story>` diekstrak dengan prioritas **di atas** `fbid` (urutan param: story_fbid → pcb-story → fbid → v → a-story); `posts/<pfbid>` juga diuji. Parity 3 salinan tetap hijau; kasus URL riil masuk fixture test (22 → 24 kasus).

## 12. Redesign Flat Minimal — v1.0.29 (2026-08-11)

Konteks user: "rombak tampilan — minimalis, clean, simple, flat; pakai icon/indikator
daripada kalimat keterangan; pakai Google icon; widget default tidak terbuka &
mengambang (menutupi halaman saat scroll)."

### Keputusan desain
- **Ikon Material Symbols Rounded (Google Fonts)** — satu stylesheet dimuat di
  popup/options (`<link>`) dan di-inject ke halaman host (FB/TT/IG) oleh content
  script via `ensureIconFont()` (id `rs-ms-font`, sekali). Kelas `.rs-ic` di
  kelima stylesheet. Keterbatasan jujur: di halaman host, pemuatan font bergantung
  CSP situs — jika diblokir, ikon kosong (tooltip `title` tetap menjelaskan).
- **Tombol aksi → ikon-only** di panel & popup: play_arrow/progress_activity
  (Proses), stop, content_copy (Copy), download (CSV), merge_type (Gabung),
  restart_alt (Reset), sort (Urut), close (Tutup), forum (FAB & Balasan),
  check_circle/error (badge Siap/Belum), facebook/music_note/instagram (logo).
- **Badge API → ikon + kata pendek** (sebelumnya kalimat "API komentar: siap —
  buka permalink post").
- **Flat**: header panel tanpa gradien (kartu + border-bottom), FAB solid tanpa
  gradien & shadow besar, popup/options header flat.

### Widget default tertutup (temuan kode — dibaca langsung)
| Platform | Sebelum | Sesudah |
|---|---|---|
| FB | Default `fnk-collapsed`, tapi **auto-expand** saat run selesai (`NAMES_DONE`) dan saat boot restore | Selalu tertutup; buka via FAB / ikon bar Like |
| TikTok | **Terbuka sejak load** (tanpa kelas collapsed) | `tnk-collapsed` default |
| Instagram | **Terbuka sejak load** (tanpa kelas collapsed) | `ing-collapsed` default |

Hasil tetap terlihat di badge jumlah FAB (data-count) — tidak ada info yang hilang.

### Catatan
- Parity blok marker (`NORMALIZE`/`DONEMSG`/`PARSERS`/`PANELTOOLS`/`FBURLS`)
  tidak tersentuh — fixture test tetap hijau (74/74).
- Verifikasi visual di browser asli tetap wajib (popup: klik ikon ekstensi; panel:
  buka FB/TT/IG → FAB → tombol ikon; pastikan font Material termuat).

## 13. Audit Pertama Instagram + Standar Konsistensi — v1.0.30 (2026-08-11)

Konteks user: "audit IG, buat aturan konsistensi tampilan & respon agar audit
selanjutnya dan perbaikannya seragam; seragamkan tampilan tiap fitur di tiap
sosmed; mulai audit pertama IG." → Standar hidup dibuat di **CONSISTENCY.md**;
seksi ini memakai checklist-nya untuk audit IG.

### Lingkup yang dibaca (bukan tebakan)
- `content-ig.js` (1084 baris) + `content-ig.css` — panel, badge, boot/restore, nav
- `inject-ig.js` (1085 baris) — engine replay `api/v1/media/{id}/comments/`
- `background.js` — GET_STATE/GET_TEMPLATE/SET_STATE, webRequest capture IG, startInstagram
- `shared.js` — `sanitizeInstagramTemplateUrl`, `isInstagramTemplateValid`, DONEMSG/PARSERS
- `popup.js`/`options.js` — badge IG di popup, default includeReplies

### Temuan yang DIPERBAIKI di v1.0.30 (inkonsistensi lintas platform)
1. **Header panel FB & TT masih gradien** (`content-fb.css:515` `linear-gradient
   #1877f2→#0a5fd4`; `content-tiktok.css:423` `#fe2c55→#d61f42`) — redesign flat
   v1.0.29 hanya diterapkan penuh di IG. Ini inkonsistensi tampilan terbesar yang
   terlihat langsung: 3 panel mestinya satu bahasa visual. → Gradien dihapus,
   header flat `var(--rs-card)` di ketiga platform.
2. **`userCollapsed` di content-fb.js = kode mati** — hanya ditulis (min/fab/Esc/
   chip), tidak pernah dibaca sejak v1.0.29 menghapus auto-expand. → Dihapus.
3. **Pesan copy FB menyebut `names.length` di fallback** (bukan `vis.length` seperti
   TT/IG) — saat filter aktif, jumlah yang dilaporkan salah. → Dikoreksi.
4. **Ternary mati di stopExtract TikTok** (`list.length ? doneMessage(..., length)
   : doneMessage(..., 0)`) — fungsi menangani 0 sendiri. → Sederhanakan.
5. **Komentar basi** di boot TT/IG: "Default visibility: expanded saat ada hasil
   tersimpan" — salah sejak v1.0.29 (panel tidak pernah auto-buka). → Dikoreksi.
6. **Deteksi halaman login HTML** di engine IG: `fetch` mengikuti redirect, jadi
   cabang `res.status === 302` di `fetchJson` adalah dead code; sesi berakhir
   mendarat di halaman login HTML (200) → JSON.parse gagal → user melihat
   "Respons bukan JSON: <!DOCTYPE html...". → Deteksi `<!doctype html` →
   `loginRequired` → pesan bersih "Login Instagram diperlukan (sesi berakhir)".

### Yang sudah kuat (diverifikasi — dari v1.0.15–1.0.29)
- **Media id filter**: replay menulis ulang segmen `/api/v1/media/{id}/` dari
  halaman (mediaId diutamakan) — tidak menyasar media asal template.
- **Budget per-run**: 150 request top-level + 40 balasan (tidak saling memakan).
- **Backoff 429** hormati `Retry-After` (cap 30 dtk, eskalasi 8s→16s, maks 2 retry,
  hanya bila sisa waktu cukup) + heartbeat PROGRESS selama menunggu.
- **Diagnosis akurat**: 403 → `blocked` (bukan "login"); `PleaseWaitFewMinutes` →
  `rate_limit`; `FeedbackRequired` → `rate_limit` + pesan "akun dibatasi";
  checkpoint → `checkpoint`; 404 reply endpoint → fallback
  `inline_child_comments` ↔ `child_comments`.
- **Pre-check**: login (cookie sessionid) + halaman (shortcode) sebelum START;
  cooldown 15 dtk antar-run / 60 dtk setelah rate limit.
- **Badge**: re-validasi TTL+shape di `storage.onChanged` (pola TT/IG v1.0.27);
  boot menerapkan `hasTemplate` tanpa syarat dari GET_STATE.
- Pacing antarpage 1,8–3,2 dtk; empty-page retry 2×; sleep interruptible.

### Temuan yang TETAP TERBUKA (rekomendasi, butuh verifikasi lapangan)
- **Badge IG tidak bisa cek same-media**: TT memfilter template dengan `awemeId`;
  IG tidak punya media id di content script (hanya shortcode) → badge "Siap" bisa
  tampil untuk template post lain. Mitigasi saat ini: engine menulis ulang
  media_id dari halaman. Opsi P2: `extractMediaIdFromPage` juga cocokkan pola
  `"id":"\d+"` dekat `xdt_api__v1__media` (perlu fixture lapangan).
- **Media id dari halaman** masih best-effort; bila gagal, replay memakai media
  asal template. Risiko kecil bila template di-capture di post lain tanpa buka
  komentar. (Guard webRequest hanya aktif saat run berjalan.)
- **`GET_TEMPLATE` IG mengembalikan `sameVideo: true` tanpa syarat** — flag
  menyesatkan (tidak dipakai badge IG, tapi kode baru jangan meniru).
- Verifikasi visual & lapangan wajib user: buka post/reel → FAB → panel flat;
  jalankan Proses tanpa login → pesan no_login bersih; sesi kedaluwarsa di
  tengah run → pesan "Login Instagram diperlukan (sesi berakhir)".

### Catatan
- Standar yang dipakai di seksi ini: **CONSISTENCY.md** (seksi 4 checklist).
- Blok marker tidak tersentuh — fixture test tetap hijau (74/74) setelah v1.0.30.

## 14. Audit Facebook — Konsistensi (v1.0.31, 2026-08-11)

Audit kedua dengan checklist **CONSISTENCY.md** (seksi 4) — fokus: menyamakan
FB dengan standar yang sudah dipakai IG/TT. (Audit teknis permalink FB pertama:
seksi 11.)

### Lingkup yang dibaca (bukan tebakan)
- `content-fb.js` (1341 baris) + `content-fb.css` — panel, badge URL, chip bar Like
- `inject-fb.js` (1859 baris) — engine GraphQL (synthetic FBURLS, backoff, budget,
  DOM fallback)
- `background.js` — startFacebook, GET_STATE, NAMES_DONE, statusFromReason
- popup.js (badge FB URL) · shared.js (FBURLS, DONEMSG)

### Temuan yang DIPERBAIKI di v1.0.31
1. **Pre-check login FB tidak ada** (beda dari IG/TT yang cek cookie `sessionid`
   sebelum START) — FB hanya mendeteksi no_login di tengah run via probe
   (redirect/HTML login). → `CHECK_FB_LOGIN` (cookie `c_user`) di background +
   pre-check di `startFacebook` (popup/shortcut/context-menu) & `startExtract`
   panel — pola gagal cepat yang identik dengan IG/TT.
2. **Cooldown antar-run hanya di IG** — FB/TT langsung menerima Proses beruntun
   (pemicu 429). → `COOLDOWN_MS` 15 dtk / `COOLDOWN_RATE_LIMIT_MS` 60 dtk
   (nilai & pesan identik dengan IG) di content-fb & content-tiktok;
   `lastRunEndAt`/`lastRateLimitAt` di-set di DONE + stopExtract.
3. **`--rs-text-dim` tidak terdefinisi** di ketiga CSS (dipakai warna daftar
   preview) — fallback ke warna inherit alih-alih dim. → `var(--rs-muted)`
   (token yang terdefinisi di semua konteks tema) di 3 file.
4. **`mapDoneStatus` FB tidak memetakan `no_template` secara eksplisit**
   (reason nyata dari `paginateGraphql` saat semua template berbentuk reply) —
   lolos lewat fallthrough `count ? done : error`. → masuk grup error eksplisit
   (parity pola mapDone IG/TT).
5. **Hint panel FB basi**: "Tombol N (pojok kanan)…" — merujuk FAB huruf dari
   pra-v1.0.29 (FAB kini ikon `forum`). → "Buka permalink post, buka komentar,
   lalu Proses." (gaya panduan URL yang dipakai TT/IG).
6. **Elemen count FB kosong saat render awal** (TT "0 nama", IG "0 username") →
   `0 nama` (parity struktur).

### Yang sudah kuat (diverifikasi ulang)
- Badge URL via FBURLS (synthetic) — re-render pada navigasi, tanpa storage
  mentah; popup & panel memakai sumber yang sama.
- Engine: probe kandidat (filter feedbackId anti salah post), backoff 429
  hormati Retry-After (cap 20 dtk, 8s→16s), retry jaringan 1×, deteksi `errors`
  GraphQL, no_login via redirect **dan** body HTML login 200, budget 350 +
  120 halaman + 40 balasan, sleep interruptible.
- Pesan akhir via DONEMSG; tip platform-aware saat nol hasil.

### Temuan yang TETAP TERBUKA (rekomendasi)
- `userCollapsed` sudah dibersihkan (v1.0.30) — tidak ada lagi sisa auto-expand.
- Chip bar Like hanya ada di FB (FAB universal di semua platform) — sesuai
  CONSISTENCY.md 1.1 (entry ekstra hanya boleh "buka panel"); TT/IG bisa
  mendapat chip serupa bila diinginkan (butuh riset DOM per platform).
- Verifikasi lapangan wajib: logout FB → Proses → pesan no_login cepat;
  Proses beruntun → pesan cooldown; panel FB vs TT vs IG berdampingan → identik.

### Catatan
- Blok marker tidak tersentuh — fixture test tetap hijau (74/74) setelah v1.0.31.


## 15. Audit TikTok — Konsistensi (v1.0.32, 2026-08-11)

Audit ketiga dengan checklist **CONSISTENCY.md** (seksi 4) — TikTok adalah
platform terakhir yang diaudit dengan standar seragam.

### Lingkup yang dibaca (bukan tebakan)
- `inject-tiktok.js` (878 baris) — engine replay `api/comment/list`
- `content-tiktok.js` + `content-tiktok.css` — panel, badge (awemeId), boot
- `background.js` — capture webRequest, GET_TEMPLATE (strict awemeId + replay),
  startTikTok pre-check
- `shared.js` — sanitize/validasi template TT, DONEMSG/PARSERS

### Hasil: TikTok sudah paling selaras — hanya 1 celah nyata
Sebagian besar checklist sudah terpenuhi sejak v1.0.14/v1.0.27/v1.0.31:
- **Panel**: struktur/urutan/ikon/token identik, flat, default tertutup, FAB +
  badge jumlah, hint "Buka URL /@user/video/...".
- **Badge**: `refreshTemplateFlag` dengan `awemeId` (v1.0.27) — template video
  lain ditolak; re-validasi di `storage.onChanged`; boot menerapkan hasTemplate
  tanpa syarat.
- **Pre-check**: login (cookie `sessionid` via CHECK_TT_LOGIN + startTikTok) &
  halaman (`awemeId`); cooldown 15/60 dtk (v1.0.31).
- **Engine**: budget 350 + 40 balasan (cap terpisah), backoff 429 hormati
  Retry-After (cap 20 dtk, 8s→16s, maks 2 retry, hanya bila sisa waktu cukup),
  retry jaringan 1×, empty-page retry 2×, `payloadMatchesVideo` (intercept
  anti video lain), sleep interruptible, stopReason lengkap (termasuk
  no_video/no_template — semua dipetakan `mapDone` content-tiktok).

### Temuan yang DIPERBAIKI di v1.0.32
1. **Deteksi halaman login HTML di `fetchJson`**: 401 JSON sudah jadi
   `no_login`, tapi sesi berakhir yang me-redirect ke halaman login (HTML 200)
   → "Respons bukan JSON: <!DOCTYPE html...\" (dump mentah). → Deteksi
   `<!doctype html` → `no_login` bersih (parity IG v1.0.30 / FB redirect+HTML).
2. **Sanitasi snippet error non-OK**: `API <status>: <text.slice>` bisa
   membocorkan HTML mentah → diganti "halaman HTML (kemungkinan login/error)"
   bila respon berbentuk HTML (aturan CONSISTENCY.md 2.5: jangan dump mentah).

### Yang TETAP TERBUKA (rekomendasi)
- Chip pembuka panel ala FB (bar aksi video) belum ada di TT/IG — FAB universal
  sudah memenuhi standar; chip hanya penambah kenyamanan (butuh riset DOM).
- Pacing TT (0,7–1,6 dtk) lebih cepat dari IG (1,8–3,2 dtk) — disengaja
  (platform rapuh = lebih lambat); amati 429 berulang → naikkan ke nilai IG. (DIEKSEKUSI v1.0.33 — pacing TT kini identik dengan IG: antar-halaman 1,8–3,2 dtk; balasan 1,4–2,4 dtk + jeda antar-thread 1,1–2,0 dtk; retry halaman kosong 2,5 dtk. Catatan: maxMs TT tetap 120 dtk vs IG 150 dtk — samakan bila mau coverage setara.)
- Verifikasi lapangan wajib: logout TT → Proses → pesan no_login cepat;
  sesi kedaluwarsa di tengah run → pesan "Sesi TikTok tidak aktif (login)";
  panel TT vs FB vs IG berdampingan → identik.

### Catatan
- Blok marker tidak tersentuh — fixture test tetap hijau (74/74) setelah v1.0.32.
- **Status konsistensi 3 platform kini penuh**: panel, badge, pre-check,
  cooldown, backoff, diagnosis error (termasuk HTML login) ✅ FB/TT/IG.


## 16. Audit Lintas Permukaan — Ketidakseragaman (v1.0.34, 2026-08-11)

Membandingkan semua permukaan (popup, options, 3 panel, background, shared)
secara berdampingan — melengkapi audit per-platform (seksi 13–15).

### DIPERBAIKI di v1.0.34
1. **Toggle "Balasan" di panel tidak menyimpan pref** — popup kirim SET_STATE
   seketika (pref tersimpan), panel hanya ubah variabel lokal (baru tersimpan
   saat run dimulai). → Ketiga panel kini kirim `SET_STATE {includeReplies}`
   seketika (parity popup).
2. **Prefix hint tidak seragam**: TT panel & popup "Video:", FB/IG "Target:".
   → Semua "Target:".
3. **Pesan reset/idle drift** antara panel dan background: FB panel "Buka 1
   postingan, lalu klik Proses." vs background "…1 postingan Facebook…"; IG
   panel "…pastikan login, lalu klik Proses." vs background "…sudah login…".
   → Disamakan (FB/IG mengikuti wording background; TT sudah cocok).
4. **Dot status "stopped" popup = amber** (sama partial) padahal tabel
   CONSISTENCY.md 1.4: stopped → accent (count panel + FAB hijau saat ada
   hasil). → popup.css stopped dot → accent.
5. **Attr `checked` mati** di checkbox Balasan FB (render() selalu override) —
   TT/IG tidak punya. → Dihapus (parity struktur).
6. **Title tombol Gabung**: popup "Gabung FB+TikTok+IG" vs panel "Gabung FB +
   TikTok + IG lalu salin". → Disamakan.

### Sengaja dibedakan (dokumentasi, bukan ketidakseragaman)
- **Default includeReplies**: FB on, TT/IG off — keputusan produk (thread balasan
  FB dalam; TT/IG lebih rentan); dapat diubah di Options.
- Backup/restore hanya di popup (ruang panel terbatas).
- Chip pembuka panel hanya di FB (bar Like); FAB universal di semua platform.
- `run_at` content: FB `document_start` (capture GraphQL sejak awal), TT/IG
  `document_idle`.
- Badge IG tak bisa cek same-media (media id tak ada di content script) —
  mitigasi: engine menulis ulang media_id dari halaman.
- Field state internal `videoHint` (TT) vs `postHint` (FB/IG) — tidak tampil
  ke user; prefix tampilan kini seragam "Target:".
- Pacing TT = IG (v1.0.33); `maxMs` TT 120 dtk vs IG 150 dtk.

### Catatan
- Tidak ada blok marker yang tersentuh — fixture test tetap hijau (74/74).

## 17. Audit & Riset: Sortir Komentar FB + Scroll Lintas Post — v1.0.35 (2026-08-11)

Konteks user: (1) tanpa ganti ke "Semua Komentar", hanya komentar di mode itu
yang ter-rekap (Paling Relevan / Terbaru); (2) walau sudah "Semua Komentar",
tanpa scroll sampai bawah tidak semua ter-rekap; (3) kadang di akhir run
halaman ke-scroll ke postingan sebelum/bawahnya (terutama di post terbaru
profil/feed).

### Riset sortKey (sumber: Apify OpenAPI facebook-comments-scraper, Goro
facebook-comments, yashodhank/actor-facebook-scraper, dump FB UFI intern)
- Query pagination komentar FB (`CometUFICommentsProviderPaginationQuery`)
  menerima variabel **`sortKey`** dengan enum:
  - `RANKED_THREADED` — "Paling Relevan" (default bila sortKey tidak dikirim)
    → HANYA sebagian komentar + pagination berhenti dini. **Ini akar masalah 1**
    (synthetic template lama tidak mengirim sortKey).
  - `RANKED_UNFILTERED` — "Semua Komentar" (kronologis, unfiltered).
  - `RECENT_ACTIVITY` — "Terbaru" (aktivitas terbaru di atas).
- Template capture membawa sortKey mode yang sedang dipilih user → replay
  mengikuti mode itu (masalah 1 saat mode "Paling Relevan").
- Alasan masalah 2 (scroll memengaruhi hasil): dengan mode default, FB
  mengembalikan subset + `hasNext:false` lebih awal — bukan karena scroll
  itu sendiri; memaksa `RANKED_UNFILTERED` menyelesaikannya.

### Penyebab masalah 3 (scroll ke postingan lain) — dibaca langsung dari kode
- `expandDomLoop`: fallback `window.scrollBy(0, 350)` menggeser HALAMAN (di
  feed/profil = pindah ke postingan berikutnya), `findExpandButtons(document)`
  mengklik "lihat komentar lain" di post lain, `scrapeDomNames(document)`
  memanen nama post lain → kontaminasi lintas post.
- `tryOpenComments`: `scrollIntoView({block:"center"})` menggeser halaman agar
  tombol komentar di tengah (di post teratas profil = melayang ke post bawah)
  dan tidak pernah dikembalikan.

### Perbaikan v1.0.35 (inject-fb.js)
1. Synthetic template memuat `sortKey: "RANKED_UNFILTERED"` — semua komentar
   tanpa perlu ganti mode manual.
2. Probe kandidat mencoba varian "Semua Komentar" (`forceAllComments`) dulu,
   lalu varian asli (mode user) bila FB menolak — hasil tak bergantung pada
   pilihan sortir di halaman.
3. DOM fallback di-scope ke `postRoot`: `window.scrollBy` dihapus (scroll
   hanya kontainer komentar dalam post), klik expand & panen nama tidak lagi
   menyentuh `document`.
4. Posisi scroll halaman di-snapshot di awal `runExtract` dan dikembalikan di
   `finally` — akhir run kembali ke postingan yang sama.

### Validasi
- `npm run check` Syntax OK · `npm test` 74/74 · `npm run build` OK
  (dist/ v1.0.35; marker RANKED_UNFILTERED ×5, savedScrollY ×4,
  `scrapeDomNames(document)` 0, `window.scrollBy(0, 350)` 0).

### Verifikasi lapangan wajib user
1. Post viral: Proses TANPA mengganti sortir → hasil harus mencakup semua
   komentar (bukan cuma "Paling Relevan").
2. Post terbaru di profil: Proses → di akhir run halaman tetap di post yang
   sama, bukan melayang ke post bawah.
3. Bandingkan hasil Proses dengan mode "Semua Komentar" manual (harus sama).

## 18. Audit Hasil v1.0.35 — Kontaminasi Lintas Post di Hook Jaringan (v1.0.36, 2026-08-11)

Audit ulang atas perbaikan v1.0.35 (seksi 17) — memeriksa ulang seluruh jalur
pengambilan nama di inject-fb.js untuk sisa celah kontaminasi lintas post.

### Jalur pengambilan nama & status guard (dibaca langsung)
| Jalur | v1.0.35 | v1.0.36 |
|---|---|---|
| `scrapeDomNames` (DOM) | di-scope ke postRoot ✓ | ✓ |
| Klik expand "lihat komentar lain" | postRoot only ✓ | ✓ |
| Scroll halaman (`window.scrollBy`) | dihapus ✓ | ✓ |
| Restore posisi scroll akhir run | ✓ | ✓ |
| **Hook fetch/XHR (respons GraphQL halaman)** | **❌ tanpa filter — semua respons diproses** | ✓ di-guard `isTargetCommentResponse` |

### Temuan & perbaikan v1.0.36
- **Temuan**: hook `window.fetch`/XHR (always-on, document_start) memanggil
  `extractNamesFromText(t)` untuk SETIAP respons GraphQL saat `running` — di
  feed, komentar postingan lain yang dimuat (auto-load/scroll manual) bocor
  ke hasil. `pushGqlBuffer` ikut terkontaminasi (drain saat run).
- **Perbaikan**: `feedbackIdsFromReqBody(body)` membaca `feedbackID`/
  `feedback_id` dari variabel request; `isTargetCommentResponse(reqIds)`
  hanya memproses respons yang membawa id postingan target — id dari URL
  permalink (`feedbackIdsFromUrl`) + `activeFeedbackId` (dikunci saat probe
  memilih template di `paginateGraphql`, di-reset di awal `runExtract`).
  Request tanpa feedback id (balasan pakai `id` komentar, bentuk tak dikenal)
  tetap diproses → tanpa regresi ekstraksi balasan.
- Template capture tidak berubah: `captureGraphqlRequest` tetap menyimpan
  semua template comment-ish, dan `orderedCandidates` (filter feedbackId
  URL) + probe memilih yang benar untuk replay. Nama dari replay engine
  diekstrak langsung (bukan lewat hook) — sudah target by construction.

### Validasi
- `npm run check` Syntax OK · `npm test` 74/74 · `npm run build` OK
  (dist/ v1.0.36; `isTargetCommentResponse`/`activeFeedbackId` ×7, semua
  `extractNamesFromText` di hook ter-guard).

### Catatan jujur (bukan bug, risiko sisa yang didokumentasikan)
- Probe memvalidasi bentuk (`page_info`) bukan feedback id respons — bila
  SEMUA kandidat URL-matched gagal dan template post lain lolos probe,
  replay bisa menyasar post lain (kasus langka). Follow-up P2: verifikasi
  feedback id di respons probe (`findFeedbackIds`). Tidak diubah sekarang
  agar tidak memutus pagination permalink yang sudah jalan.
- Di feed tanpa URL permalink, sebelum probe memilih template, respons
  halaman tidak diekstrak (tunggu kunci target) — template tetap ter-capture
  dan replay mengekstrak setelah probe.


## 19. Audit UI Facebook — Chip bar Like/Comment pecah (v1.0.37, 2026-08-13)

Konteks user: "audit facebook dong, ui nya pecah" → klarifikasi: "Yang pecah:
Chip di bar Like/Comment".

### Fakta dari kode (bukan tebakan)
- git diff 8249d5a..97cae37 membuktikan chip (ensureActionIcon,
  placeInlineBar, findActionRow, CSS #fnk-inline) TIDAK berubah sama sekali
  antara v1.0.27 dan v1.0.36 — jadi kerusakan bukan regresi dari redesign
  flat v1.0.29.
- Panel FB ≡ IG secara struktur/CSS (set-diff fungsional, audit v1.0.36) dan
  dist/ sinkron dengan source — bagian panel bukan sumber masalah.
- Riset web (Reddit/SocialBee 2025–2026): Facebook menguji posisi baru tombol
  Like/Comment/Share — ikon kecil tanpa label di samping kotak komentar.
  findActionRow lama mensyaratkan tombol pertama berlabel like|suka → dengan
  DOM baru baris tak terdeteksi → chip disembunyikan / ter-dock ke seluruh
  post (menempel di bawah kotak komentar = tampak "pecah").
- placeInlineBar hanya dipicu ulang lewat debounce 300 ms scheduleNavCheck
  yang DI-RESET setiap mutasi — di feed yang sibuk bisa kelaparan
  (starvation) → chip yang dilepas React tidak pernah terpasang kembali.

### Perbaikan v1.0.37 (content-fb.js + content-fb.css)
1. Icon chip → forum (SVG Material, sama dengan FAB) — satu entry point
   visual sesuai CONSISTENCY.md 1.1 (ikon sama untuk fungsi sama).
2. findActionRow ditulis ulang: label dibaca dari teks + aria-label + title;
   anchor boleh Like ATAU Comment ATAU Share (tidak wajib Like pertama);
   baris cukup memuat 2+ aksi; mendukung label reaksi baru
   ("beri reaksi"/"react").
3. Re-dock watcher chip: MutationObserver document.body dengan coalescing
   timer 800 ms yang TIDAK di-reset tiap mutasi → chip yang terlepas (React
   re-render: buka komentar, scroll, like) selalu terpasang kembali, tanpa
   polling dan tanpa beban (callback O(1) saat timer aktif).
4. Chip tidak memecah layout baris: order: 99 saat parent flex (selalu paling
   kanan), dimensi button dikunci min/max 36 px, box-sizing: border-box +
   overflow: visible eksplisit.

### Validasi
- npm run check Syntax OK · npm test 74/74 · npm run build OK
- Marker di dist/: forum — ikon sama dengan FAB x1, chipTimer x4,
  actionLabel x1, score >= 2 x1, order: 99 x1, max-width: 36px x1.

### Verifikasi lapangan wajib user
1. Buka post di feed & permalink → chip muncul di bar Like/Comment/Share,
   ikon obrolan (forum) sama dengan FAB, tidak menggeser tombol FB.
2. Scroll feed / buka komentar / like → chip tetap ada (tidak hilang) dan
   pindah ke post yang sedang dilihat.
3. Post dengan ikon aksi tanpa label (layout baru) → chip tetap ter-dock
   benar.

### Catatan
- Tidak ada blok marker yang tersentuh — fixture test tetap hijau (74/74).
- Bila chip masih terlihat salah di lapangan, lampirkan screenshot + versi
   layout Facebook (baris aksi berlabel / ikon-only / posisi baru) agar
   selektor bisa dipersempit.
