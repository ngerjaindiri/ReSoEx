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
- **C1 — gap fitur panel vs popup** (search/CSV/merge/backup hanya di popup): belum — v1.1+.
- **C2 — switch (options) vs checkbox (popup/panel) untuk setting sama:** belum — sengaja (language kontrol berbeda per konteks), bisa dipertimbangkan di v1.1.
- **D1 — dua sumber pesan (localDoneMessage vs reasonToMessage):** **✅ Fixed v1.0.24** — helper tunggal `doneMessage` di shared.js (blok `BEGIN-RESO-DONEMSG`, 4 salinan dijamin fixture test): `reasonToMessage` delegasi; ketiga panel + jalur stop-finalize memakai helper. Drift tertutup: suffix `[graphql]/[dom]` FB dihapus (mode tetap di baris "Target:"), checkpoint IG kini menyertakan count, timeout seragam "Klik Copy", wording rate-limit platform-aware, `wordFor` diekspor (popup memakai).
- **E2 — GET_STATE hasTemplate asimetris (TT di-recompute, IG tidak):** **✅ Fixed v1.0.21** — IG kini di-recompute juga (TTL 30 mnt + shape), badge popup selalu akurat.

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
