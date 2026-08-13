/**
 * Content script — UI + bridge for Instagram Username Komentar
 */
(function () {
  if (window.__ING_CONTENT__) return;
  window.__ING_CONTENT__ = true;

  const INJECT_SOURCE = "ig-nama-komentar-inject";
  const ROOT_ID = "ing-root";

  let ui = null;
  let status = "idle";
  let names = [];
  let message = "Buka post/reel Instagram, pastikan sudah login, lalu klik Proses.";
  let postHint = "";
  let includeReplies = false;
  let hasTemplate = false;
  let query = "";
  let sortAz = false;
  let engineReady = false;
  let readyWaiter = null;
  let currentRunId = null;
  let stopFinalizeTimer = null;

  // Cooldown antar-run — run beruntun adalah pemicu rate-limit/checkpoint
  // (riset IG 2026): jeda minimum setelah run apa pun, lebih lama lagi setelah
  // rate limit.
  const COOLDOWN_MS = 15_000;
  const COOLDOWN_RATE_LIMIT_MS = 60_000;
  let lastRunEndAt = 0;
  let lastRateLimitAt = 0;

  function sendBg(type, payload = {}) {
    try {
      return chrome.runtime.sendMessage({ type, ...payload }).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  }

  async function engineCmd(cmd, options = {}) {
    return sendBg("ENGINE_CMD", { cmd, options });
  }

  function acceptFromInject(data) {
    if (!data || data.source !== INJECT_SOURCE) return false;
    const t = data.type;
    return (
      t === "READY" ||
      t === "PROGRESS" ||
      t === "DONE" ||
      t === "ERROR" ||
      t === "NEED_TEMPLATE"
    );
  }

  async function waitEngineReady(timeoutMs = 5000) {
    if (engineReady) return true;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sendBg("INJECT_MAIN");
      const res = await engineCmd("PING");
      if (res?.ok) {
        engineReady = true;
        if (readyWaiter) readyWaiter();
        return true;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return engineReady;
  }

  // BEGIN-RESO-NORMALIZE
  function normalizeInstagramUsername(raw) {
    if (typeof raw !== "string") return "";
    let u = raw.replace(/\u200b|\u200c|\u200d|\ufeff/g, "").trim();
    if (/\s/.test(u)) return "";
    if (u.startsWith("@")) u = u.slice(1);
    u = u.trim();
    if (!u) return "";
    if (!/^[a-zA-Z0-9._]{1,30}$/.test(u)) return "";
    if (/\.\./.test(u) || u.startsWith(".") || u.endsWith(".")) return "";
    u = u.toLowerCase();
    const blocked = [
      /^instagram$/i, /^post$/i, /^posts$/i, /^reel$/i, /^reels$/i,
      /^story$/i, /^stories$/i, /^explore$/i, /^direct$/i, /^inbox$/i,
      /^activity$/i, /^following$/i, /^followers$/i, /^follow$/i,
      /^saved$/i, /^settings$/i, /^help$/i, /^about$/i, /^terms$/i,
      /^privacy$/i, /^login$/i, /^signup$/i, /^report$/i, /^more$/i,
      /^comment$/i, /^reply$/i, /^share$/i, /^save$/i, /^like$/i,
      /^sent$/i, /^translate/i, /^view/i, /^username$/i, /^new$/i,
      /^edit/i, /^delete/i, /^cancel$/i, /^close$/i, /^copy/i,
      /^threads$/i, /^threadsapp$/i,
    ];
    if (blocked.some((re) => re.test(u))) return "";
    return u;
  }
  // END-RESO-NORMALIZE

  // BEGIN-RESO-DONEMSG
  /**
   * SINGLE SOURCE OF TRUTH untuk pesan akhir run (DONE). Dipakai oleh
   * background/popup (via reasonToMessage) dan ketiga panel (content-*.js)
   * lewat salinan byte-identik di dalam marker yang sama — dijamin oleh
   * fixture test DONEMSG agar tidak pernah drift.
   * @param {string} reason stopReason dari engine (complete/idle/stopped/...)
   * @param {number} count jumlah hasil terkumpul
   * @param {"facebook"|"tiktok"|"instagram"} platform
   * @param {{extra?: string, tip?: string}} [options] extra = diagnosis tambahan
   *   (mis. 429 saat timeout), tip = panduan saat tidak ada hasil
   * @returns {string}
   */
  function doneMessage(reason, count, platform, options) {
    const word = platform === "instagram" ? "username" : "nama";
    const extra =
      options && typeof options.extra === "string" && options.extra
        ? ` ${options.extra}`
        : "";
    const tip =
      options && typeof options.tip === "string" && options.tip
        ? ` ${options.tip}`
        : "";
    const c = Number.isFinite(count) ? count : 0;

    if (reason === "stopped") {
      return c
        ? `Dihentikan — ${c} ${word}.${extra} Klik Copy.`
        : `Dihentikan — belum ada ${word}.${extra}`;
    }
    if (reason === "timeout") {
      return c
        ? `Waktu habis — ${c} ${word} (mungkin belum semua).${extra} Klik Copy.`
        : `Waktu habis — belum ada ${word}.${extra}`;
    }
    if (reason === "idle" || reason === "complete") {
      if (c) return `Selesai — ${c} ${word}.${extra} Klik Copy.`;
      if (tip) return `Tidak ada ${word}.${tip}`;
      if (platform === "facebook")
        return "Tidak ada nama. Buka permalink post, buka list komentar sampai terlihat, tunggu 2–3 dtk, lalu Proses lagi.";
      if (platform === "tiktok")
        return "Tidak ada nama. Pastikan komentar terbuka di video, lalu Proses lagi.";
      return "Tidak ada username. Pastikan komentar terbuka & sudah login, lalu Proses lagi.";
    }
    if (reason === "error") {
      return extra.trim() || "Terjadi error saat ekstrak.";
    }
    if (reason === "rate_limit") {
      const who =
        platform === "facebook"
          ? "Facebook"
          : platform === "tiktok"
            ? "TikTok"
            : "Instagram";
      return c
        ? `Rate limit ${who} (429) — ${c} ${word} terkumpul. Tunggu beberapa saat, lalu Proses lagi.`
        : `Rate limit ${who} (429) — tunggu beberapa saat, lalu coba lagi.`;
    }
    if (reason === "blocked") {
      return c
        ? `Instagram memblokir permintaan (403) — kemungkinan anti-bot. ${c} username terkumpul. Tunggu beberapa saat, lalu Proses lagi.`
        : "Instagram memblokir permintaan (403) — kemungkinan anti-bot atau App-ID ditolak. Berhenti agar akun aman; coba lagi beberapa saat kemudian.";
    }
    if (reason === "checkpoint") {
      return c
        ? `Instagram minta verifikasi (checkpoint). ${c} username terkumpul — buka instagram.com, selesaikan verifikasi, lalu Proses lagi.`
        : "Instagram minta verifikasi (checkpoint). Buka instagram.com, selesaikan verifikasi, lalu Proses lagi.";
    }
    if (reason === "no_template") {
      if (platform === "instagram") {
        return "Belum ada template API komentar. Buka post/reel, klik ikon komentar dulu, tunggu list muncul, lalu Proses lagi (wajib login).";
      }
      if (platform === "facebook") {
        return "Belum ada template GraphQL komentar. Buka permalink post, buka list komentar sampai terlihat, tunggu 2–3 detik, lalu Proses lagi.";
      }
      return "Belum ada template API komentar. Buka video, klik ikon komentar dulu, tunggu komentar muncul, lalu Proses lagi.";
    }
    if (reason === "no_video") {
      return "Buka halaman video TikTok dulu (URL berisi /video/...), bukan For You feed saja.";
    }
    if (reason === "no_login") {
      if (platform === "facebook")
        return "Sesi Facebook tidak aktif — login di facebook.com lalu Proses lagi.";
      if (platform === "tiktok")
        return "Sesi TikTok tidak aktif — login di tiktok.com lalu Proses lagi.";
      return "Butuh login Instagram. Buka instagram.com, login, lalu buka post & Proses lagi.";
    }
    if (reason === "no_media") {
      return "Buka halaman post/reel Instagram dulu (URL /p/... atau /reel/...).";
    }
    return c ? `${c} ${word}` : "Siap.";
  }
  // END-RESO-DONEMSG

  // BEGIN-RESO-PANELTOOLS
  /**
   * SINGLE SOURCE OF TRUTH untuk perkakas UI daftar nama — dipakai popup
   * (via export) dan ketiga panel (content-*.js) lewat salinan byte-identik
   * di dalam marker yang sama — dijamin fixture test PANELTOOLS.
   */

  /** Saring nama (case-insensitive substring). */
  function filterNames(names, query) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return names || [];
    return (names || []).filter((n) => String(n).toLowerCase().includes(q));
  }

  /** Urutkan A–Z (locale id); false = urutan asli. */
  function sortNamesAz(names) {
    return [...(names || [])].sort((a, b) =>
      String(a).localeCompare(String(b), "id")
    );
  }

  /** Isi file CSV: BOM UTF-8 + header platform-aware + 1 nama/baris. */
  function csvContent(names, isIg) {
    const header = isIg ? "Username" : "Nama";
    return "\uFEFF" + header + "\n" + (names || []).join("\n");
  }

  /** Unduh file teks via blob (berfungsi di popup & content script). */
  function downloadTextFile(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /**
   * Gabung nama dari beberapa platform — tiap nama dinormalisasi dengan
   * aturan platform-nya SENDIRI (FB/TT/IG berbeda), lalu di-dedupe
   * case-insensitive. Menghindari data loss saat normalisasi lintas platform
   * (mis. @handle & emoji TikTok, atau nama FB yang mengandung spasi yang
   * ditolak aturan username Instagram).
   * @param {{platform: "facebook"|"tiktok"|"instagram", names: string[]}[]} groups
   * @returns {string[]}
   */
  function mergeAcrossPlatforms(groups) {
    const map = new Map();
    for (const g of groups || []) {
      const platform =
        g?.platform === "tiktok" || g?.platform === "instagram"
          ? g.platform
          : "facebook";
      for (const n of g?.names || []) {
        const k = normalizeName(n, platform);
        if (k && !map.has(k.toLowerCase())) map.set(k.toLowerCase(), k);
      }
    }
    return [...map.values()];
  }
  // END-RESO-PANELTOOLS

  /** Instagram usernames: lowercase, no @, charset a-z 0-9 _ . */
  function mergeNames(list) {
    const map = new Map();
    for (const n of list || []) {
      const k = normalizeInstagramUsername(n);
      if (k && !map.has(k)) map.set(k, k);
    }
    return [...map.values()];
  }

  /** Daftar username yang terlihat — hormati filter pencarian & urutan A–Z. */
  function visible() {
    let out = filterNames(names, query);
    if (sortAz) out = sortNamesAz(out);
    return out;
  }

  function toggleSort() {
    sortAz = !sortAz;
    render();
  }

  async function exportCsv() {
    const vis = visible();
    if (!vis.length) {
      setLocal({ message: "Belum ada username untuk diekspor." });
      return;
    }
    const date = new Date().toISOString().slice(0, 10);
    downloadTextFile(
      `reso-username-${date}.csv`,
      csvContent(vis, true),
      "text/csv;charset=utf-8"
    );
    setLocal({ message: `CSV tersimpan: ${vis.length} username.` });
  }

  async function mergeAll() {
    // Merge dijalankan di background (shared.js punya ketiga normalizer
    // platform); content script hanya membawa normalizer platform-nya sendiri.
    const res = await sendBg("MERGE_ALL");
    const merged = Array.isArray(res?.names) ? res.names : [];
    if (!merged.length) {
      setLocal({
        message: "Belum ada hasil di Facebook, TikTok, maupun Instagram.",
      });
      return;
    }
    try {
      await navigator.clipboard.writeText(merged.join("\n"));
      setLocal({
        message: `Gabung: ${merged.length} nama unik tersalin. Paste di Excel.`,
      });
    } catch {
      setLocal({
        message: `Gabung: ${merged.length} nama unik. Buka hasil lalu Copy per platform.`,
      });
    }
  }

  function setLocal(patch) {
    if (patch.status) status = patch.status;
    if (patch.names) names = mergeNames(patch.names);
    if (patch.message != null) message = patch.message;
    if (patch.postHint != null) postHint = patch.postHint;
    if (typeof patch.includeReplies === "boolean") includeReplies = patch.includeReplies;
    if (typeof patch.hasTemplate === "boolean") hasTemplate = patch.hasTemplate;
    render();
  }

  function extractShortcode() {
    const m = String(location.href).match(
      /instagram\.com\/(?:share\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i
    );
    return m ? m[1] : "";
  }

  async function refreshTemplateFlag() {
    const res = await sendBg("GET_TEMPLATE");
    hasTemplate = !!res?.url;
    render();
    return res?.url || null;
  }

  function makeRunId() {
    return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  }

  /** Bumps on every start/stop so superseded async starts abort cleanly */
  let startGen = 0;

  async function startExtract(opts = {}) {
    const gen = ++startGen;
    if (stopFinalizeTimer) {
      clearTimeout(stopFinalizeTimer);
      stopFinalizeTimer = null;
    }
    if (status === "running") {
      await engineCmd("STOP");
      await new Promise((r) => setTimeout(r, 100));
    }
    if (gen !== startGen) return;

    // Cooldown antar-run: blok Proses beruntun agar akun aman.
    const nowC = Date.now();
    const sinceEnd = lastRunEndAt ? nowC - lastRunEndAt : Infinity;
    const sinceRl = lastRateLimitAt ? nowC - lastRateLimitAt : Infinity;
    const coolMs =
      sinceRl < COOLDOWN_RATE_LIMIT_MS
        ? COOLDOWN_RATE_LIMIT_MS - sinceRl
        : Math.max(0, COOLDOWN_MS - sinceEnd);
    if (coolMs > 0) {
      const waitSec = Math.ceil(coolMs / 1000);
      setLocal({
        status: "idle",
        message: `Tunggu ${waitSec} dtk sebelum Proses lagi (cooldown anti rate-limit).`,
      });
      setTimeout(() => {
        if (status !== "running") {
          setLocal({ message: "Cooldown selesai — klik Proses untuk mulai." });
        }
      }, coolMs);
      return;
    }

    // Pre-check login: IG memerlukan cookie sessionid. Gagal cepat alih-alih
    // membuang seluruh window scroll/intercept saat belum login.
    const login = await sendBg("CHECK_IG_LOGIN");
    if (gen !== startGen) return;
    if (login && login.loggedIn === false) {
      const noLoginMsg =
        "Butuh login Instagram. Buka instagram.com, login, lalu buka post & Proses lagi.";
      setLocal({ status: "error", names: [], message: noLoginMsg, postHint: "" });
      await sendBg("SET_STATE", {
        patch: {
          status: "error",
          names: [],
          count: 0,
          message: noLoginMsg,
          stopReason: "no_login",
          postHint: "",
          runId: null,
        },
      });
      return;
    }

    // Pre-check halaman: tanpa shortcode (profil/feed), media_id tak bisa
    // ditentukan → gagal cepat alih-alih mode scroll 45 dtk (pola no_video TT).
    if (!extractShortcode()) {
      const noMediaMsg =
        "Buka halaman post/reel Instagram dulu (URL /p/... atau /reel/...).";
      setLocal({
        status: "error",
        names: [],
        message: noMediaMsg,
        postHint: "",
      });
      await sendBg("SET_STATE", {
        patch: {
          status: "error",
          names: [],
          count: 0,
          message: noMediaMsg,
          stopReason: "no_media",
          postHint: "",
          runId: null,
        },
      });
      return;
    }

    currentRunId = opts.runId || makeRunId();
    setLocal({ status: "running", names: [], message: "Menyiapkan…" });
    // tabId stamped by background from sender.tab
    const stRes = await sendBg("SET_STATE", {
      patch: {
        status: "running",
        names: [],
        count: 0,
        message: "Menyiapkan…",
        includeReplies,
        runId: currentRunId,
      },
    });
    if (gen !== startGen) return;
    if (stRes && stRes.ok === false) {
      setLocal({
        status: "error",
        message:
          stRes.error === "Run active on another tab"
            ? "Sudah ada proses di tab lain. Stop dulu di tab itu, lalu coba lagi."
            : "Gagal memulai. Coba lagi.",
      });
      return;
    }

    const ok = await waitEngineReady(5000);
    if (gen !== startGen) return;
    if (!ok) {
      setLocal({
        status: "error",
        message: "Engine belum siap. Refresh halaman Instagram, lalu coba lagi.",
      });
      await sendBg("NAMES_ERROR", {
        message: "Engine belum siap.",
        runId: currentRunId,
      });
      return;
    }

    const templateUrl = opts.templateUrl || (await refreshTemplateFlag()) || null;
    if (gen !== startGen) return;

    if (!templateUrl) {
      setLocal({
        message:
          "Mencoba buka komentar… pastikan sudah login; jika gagal, buka komentar manual dulu.",
      });
    } else {
      await engineCmd("SET_TEMPLATE", { templateUrl });
    }
    if (gen !== startGen) return;

    const started = await engineCmd("START", {
      maxMs: 150_000,
      includeReplies,
      templateUrl,
      runId: currentRunId,
    });
    if (gen !== startGen) return;
    if (!started?.ok) {
      setLocal({
        status: "error",
        message:
          started?.error === "Run active on another tab — stop it first"
            ? "Sudah ada proses di tab lain. Stop dulu, lalu coba lagi."
            : "Gagal memulai engine. Refresh halaman lalu coba lagi.",
      });
      await sendBg("NAMES_ERROR", {
        message: started?.error || "START failed",
        runId: currentRunId,
      });
      await engineCmd("STOP");
    }
  }

  function stopExtract() {
    startGen += 1;
    engineCmd("STOP");
    setLocal({ status: "running", message: "Menghentikan…" });
    if (stopFinalizeTimer) clearTimeout(stopFinalizeTimer);
    const stopRunId = currentRunId;
    stopFinalizeTimer = setTimeout(() => {
      if (status !== "running") return;
      if (currentRunId !== stopRunId) return;
      const list = names.slice();
      lastRunEndAt = Date.now();
      setLocal({
        status: list.length ? "stopped" : "error",
        message: doneMessage("stopped", list.length, "instagram"),
      });
      sendBg("NAMES_DONE", {
        names: list,
        stopReason: "stopped",
        runId: stopRunId,
        postHint,
      });
    }, 5000);
  }

  async function doReset() {
    startGen += 1;
    if (stopFinalizeTimer) {
      clearTimeout(stopFinalizeTimer);
      stopFinalizeTimer = null;
    }
    await engineCmd("STOP");
    currentRunId = null;
    setLocal({
      status: "idle",
      names: [],
      message: "Buka post/reel Instagram, pastikan sudah login, lalu klik Proses.",
      postHint: "",
    });
    await sendBg("RESET");
  }

  async function copyNames() {
    const vis = visible();
    const text = vis.join("\n");
    if (!text) {
      setLocal({ message: "Belum ada username untuk disalin." });
      return false;
    }
    try {
      await navigator.clipboard.writeText(text);
      setLocal({
        message: `Tersalin ${vis.length} username. Paste di Excel (Ctrl+V).`,
      });
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setLocal({ message: `Tersalin ${vis.length} username. Paste di Excel.` });
        return true;
      } catch {
        setLocal({ message: "Gagal copy. Coba lagi dari panel atau popup." });
        return false;
      } finally {
        ta.remove();
      }
    }
  }

  function createUi() {
    if (document.getElementById(ROOT_ID)) {
      ui = document.getElementById(ROOT_ID);
      return ui;
    }
    const root = document.createElement("div");
    root.id = ROOT_ID;
    // Default visibility: TERTUTUP selalu (flat minimal) — panel tidak
    // mengambang menutupi halaman saat scrolling. Buka lewat FAB; hasil
    // tetap terlihat di badge FAB.
    root.classList.add("ing-collapsed");
    ensureIconFont();
    root.innerHTML = `
      <div class="ing-panel" role="region" aria-label="Instagram Username Komentar">
        <div class="ing-header">
          <span class="rs-ic ing-logo-ic" aria-hidden="true">instagram</span>
          <span class="ing-title">Username Komentar</span>
          <button type="button" class="ing-min" data-ing="min" title="Tutup" aria-label="Tutup panel"><span class="rs-ic" aria-hidden="true">close</span></button>
        </div>
        <div class="ing-body">
          <div class="ing-status" data-ing="status" aria-live="polite"></div>
          <div class="ing-hint" data-ing="hint"></div>
          <div class="ing-count" data-ing="count">0 username</div>
          <div class="ing-badge" data-ing="badge"></div>
          <label class="ing-check">
            <input type="checkbox" data-ing="replies" />
            <span class="rs-ic" aria-hidden="true">forum</span>
            <span>Balasan</span>
          </label>
          <div class="ing-tools">
            <span class="rs-ic ing-search-ic" aria-hidden="true">search</span>
            <input class="ing-search" type="search" data-ing="search" placeholder="Cari…" aria-label="Cari username" />
            <button type="button" class="ing-btn ing-sort" data-ing="sort" title="Urutkan A–Z" aria-label="Urutkan A–Z" aria-pressed="false"><span class="rs-ic" aria-hidden="true">sort</span></button>
          </div>
          <div class="ing-list" data-ing="list" hidden></div>
          <div class="ing-actions">
            <button type="button" class="ing-btn ing-primary" data-ing="process" title="Mulai ambil username" aria-label="Mulai ambil username"><span class="rs-ic" aria-hidden="true">play_arrow</span></button>
            <button type="button" class="ing-btn" data-ing="stop" hidden title="Hentikan" aria-label="Hentikan"><span class="rs-ic" aria-hidden="true">stop</span></button>
            <button type="button" class="ing-btn ing-success" data-ing="copy" disabled title="Salin ke clipboard" aria-label="Salin username"><span class="rs-ic" aria-hidden="true">content_copy</span></button>
            <button type="button" class="ing-btn" data-ing="csv" disabled title="Simpan ke CSV (Excel)" aria-label="Simpan CSV"><span class="rs-ic" aria-hidden="true">download</span></button>
            <button type="button" class="ing-btn ing-ghost" data-ing="reset" title="Bersihkan hasil" aria-label="Bersihkan hasil"><span class="rs-ic" aria-hidden="true">restart_alt</span></button>
            <button type="button" class="ing-btn ing-ghost" data-ing="merge" title="Gabung FB + TikTok + IG lalu salin" aria-label="Gabung semua platform"><span class="rs-ic" aria-hidden="true">merge_type</span></button>
          </div>
        </div>
      </div>
      <button type="button" class="ing-fab" data-ing="fab" data-count="" title="Username Komentar" aria-label="Buka panel Username Komentar"><span class="rs-ic" aria-hidden="true">forum</span></button>
    `;
    (document.body || document.documentElement).appendChild(root);
    ui = root;

    root.addEventListener("click", (e) => {
      const t = e.target.closest("[data-ing]");
      if (!t) return;
      const act = t.getAttribute("data-ing");
      if (act === "process") startExtract();
      if (act === "stop") stopExtract();
      if (act === "copy") copyNames();
      if (act === "reset") doReset();
      if (act === "csv") exportCsv();
      if (act === "merge") mergeAll();
      if (act === "sort") toggleSort();
      if (act === "min") root.classList.add("ing-collapsed");
      if (act === "fab") root.classList.remove("ing-collapsed");
    });
    root.addEventListener("change", (e) => {
      if (e.target?.getAttribute?.("data-ing") === "replies") {
        includeReplies = !!e.target.checked;
        // Persist pref seketika (parity popup) — bukan hanya saat run dimulai.
        sendBg("SET_STATE", { patch: { includeReplies } });
      }
    });
    root.addEventListener("input", (e) => {
      if (e.target?.getAttribute?.("data-ing") === "search") {
        query = e.target.value;
        render();
      }
    });
    // Keyboard: Esc menutup panel (setara tombol min).
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !ui) return;
      if (!ui.classList.contains("ing-collapsed")) {
        ui.classList.add("ing-collapsed");
      }
    });
    applySettings();
    return root;
  }

  /** Load ikon font (Material Symbols) sekali — di-bundle ke extension agar
   *  tidak bergantung CSP/jaringan Google Fonts (FB/IG/blocker bisa memblokir). */
  function ensureIconFont() {
    if (document.getElementById("rs-ms-font")) return;
    const style = document.createElement("style");
    style.id = "rs-ms-font";
    style.textContent = `@font-face{font-family:"Material Symbols Rounded";font-style:normal;font-weight:400;font-display:block;src:url(${chrome.runtime.getURL("fonts/material-symbols-rounded.woff2")}) format("woff2")}`;
    (document.head || document.documentElement).appendChild(style);
  }

  /**
   * Apply Options (rsx_prefs): panel theme + default "sertakan balasan".
   * Runs on boot and whenever Options change (storage.onChanged).
   */
  function applySettings() {
    try {
      chrome.storage.local
        .get("rsx_prefs")
        .then((d) => {
          const prefs = d?.rsx_prefs || {};
          const root = document.getElementById(ROOT_ID);
          if (root) {
            const theme =
              prefs.theme === "light" || prefs.theme === "dark"
                ? prefs.theme
                : window.matchMedia("(prefers-color-scheme: dark)").matches
                  ? "dark"
                  : "light";
            root.setAttribute("data-rs-theme", theme);
          }
          const v = prefs.includeReplies?.instagram;
          if (status !== "running" && typeof v === "boolean" && includeReplies !== v) {
            includeReplies = v;
            render();
          }
        })
        .catch(() => {});
    } catch {
      /* ignore */
    }
  }

  function render() {
    if (!ui) createUi();
    ui.setAttribute("data-status", status || "idle");
    const statusEl = ui.querySelector('[data-ing="status"]');
    const hintEl = ui.querySelector('[data-ing="hint"]');
    const countEl = ui.querySelector('[data-ing="count"]');
    const badgeEl = ui.querySelector('[data-ing="badge"]');
    const processBtn = ui.querySelector('[data-ing="process"]');
    const stopBtn = ui.querySelector('[data-ing="stop"]');
    const copyBtn = ui.querySelector('[data-ing="copy"]');
    const csvBtn = ui.querySelector('[data-ing="csv"]');
    const mergeBtn = ui.querySelector('[data-ing="merge"]');
    const fab = ui.querySelector('[data-ing="fab"]');
    const replies = ui.querySelector('[data-ing="replies"]');

    if (statusEl) statusEl.textContent = message;
    if (hintEl) {
      // Sembunyikan detail teknis (media id/template) saat run selesai.
      const terminal = ["done", "partial", "stopped", "error"].includes(status);
      const sc = extractShortcode();
      hintEl.textContent = terminal
        ? ""
        : postHint
          ? `Target: ${postHint}`
          : sc
            ? `Post: ${sc}`
            : "Buka URL /p/... atau /reel/...";
    }
    // Count — saat filter aktif tampilkan "X dari N" agar jelas kenapa
    // tombol Copy bisa nonaktif walau ada hasil.
    const vis = visible();
    if (countEl) {
      countEl.textContent = query.trim()
        ? `${vis.length} dari ${names.length} username`
        : names.length
          ? `${names.length} username`
          : "0 username";
    }
    if (badgeEl) {
      badgeEl.innerHTML = hasTemplate
        ? '<span class="rs-ic">check_circle</span>Siap'
        : '<span class="rs-ic">error</span>Belum';
      badgeEl.classList.toggle("ing-ok", hasTemplate);
      badgeEl.classList.toggle("ing-warn", !hasTemplate);
    }
    if (replies) replies.checked = includeReplies;

    const running = status === "running";
    if (processBtn) {
      processBtn.disabled = running;
      const processIc = processBtn.querySelector(".rs-ic");
      if (processIc) {
        processIc.textContent = running ? "progress_activity" : "play_arrow";
      }
      processBtn.setAttribute(
        "aria-label",
        running ? "Memproses…" : "Mulai ambil username"
      );
    }
    if (stopBtn) stopBtn.hidden = !running;
    if (copyBtn) {
      copyBtn.disabled = vis.length === 0;
      copyBtn.setAttribute(
        "aria-label",
        vis.length ? `Salin username (${vis.length})` : "Salin username"
      );
    }
    if (csvBtn) csvBtn.disabled = vis.length === 0;
    if (mergeBtn) mergeBtn.disabled = false;
    const sortBtn = ui.querySelector('[data-ing="sort"]');
    if (sortBtn) {
      sortBtn.setAttribute("aria-pressed", String(sortAz));
      sortBtn.classList.toggle("ing-active", sortAz);
      sortBtn.title = sortAz ? "Urutkan asli" : "Urutkan A–Z";
      sortBtn.setAttribute("aria-label", sortAz ? "Urutkan asli" : "Urutkan A–Z");
    }

    // Preview daftar — hormati filter & urutan (parity dengan popup).
    const listEl = ui.querySelector('[data-ing="list"]');
    if (listEl) {
      if (vis.length) {
        listEl.hidden = false;
        const show = vis.slice(0, 40);
        listEl.textContent =
          show.join("\n") + (vis.length > 40 ? `\n… +${vis.length - 40} lagi` : "");
      } else {
        listEl.hidden = true;
        listEl.textContent = "";
      }
    }
    if (fab) {
      fab.setAttribute("data-count", names.length > 0 ? String(names.length) : "");
      fab.classList.toggle("ing-running", running);
      fab.classList.toggle(
        "ing-done",
        (status === "done" || status === "partial" || status === "stopped") &&
          names.length > 0
      );
      // Title/aria dinamis mengikuti state.
      const fabTitle = running
        ? "Proses berjalan — buka panel untuk Stop"
        : names.length > 0
          ? `Buka panel — ${names.length} username terkumpul`
          : "Username Komentar";
      fab.title = fabTitle;
      fab.setAttribute("aria-label", fabTitle);
    }
  }

  function mapDone(stopReason, count) {
    if (stopReason === "stopped") return "stopped";
    if (stopReason === "timeout") return "partial";
    if (stopReason === "rate_limit") return count ? "partial" : "error";
    if (stopReason === "blocked") return count ? "partial" : "error";
    if (stopReason === "checkpoint") return count ? "partial" : "error";
    if (
      stopReason === "error" ||
      stopReason === "no_template" ||
      stopReason === "no_login" ||
      stopReason === "no_media"
    )
      return "error";
    return count ? "done" : "error";
  }

  /** Pesan akhir run via helper tunggal (DONEMSG) — konsisten lintas platform. */

  function isCurrentRun(runId) {
    if (!currentRunId) return false;
    if (typeof runId !== "string" || !runId) return false;
    return runId === currentRunId;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!acceptFromInject(data)) return;

    if (data.type === "READY") {
      engineReady = true;
      if (readyWaiter) readyWaiter();
      return;
    }
    if (data.type === "NEED_TEMPLATE") {
      if (status !== "running" || !currentRunId) return;
      refreshTemplateFlag().then((url) => {
        if (url) engineCmd("SET_TEMPLATE", { templateUrl: url });
      });
      return;
    }
    if (data.type === "PROGRESS") {
      if (status !== "running") return;
      if (!isCurrentRun(data.runId)) return;
      const list = Array.isArray(data.names) ? data.names : [];
      setLocal({
        status: "running",
        names: list,
        message:
          typeof data.message === "string"
            ? data.message
            : `Mengumpulkan… ${list.length}`,
        postHint: typeof data.postHint === "string" ? data.postHint : postHint,
      });
      sendBg("NAMES_PROGRESS", {
        names: list,
        message: data.message,
        postHint: data.postHint,
        runId: currentRunId,
      });
      return;
    }
    if (data.type === "DONE") {
      if (!isCurrentRun(data.runId)) return;
      if (stopFinalizeTimer) {
        clearTimeout(stopFinalizeTimer);
        stopFinalizeTimer = null;
      }
      const list = Array.isArray(data.names) ? data.names : [];
      const stopReason =
        typeof data.stopReason === "string" ? data.stopReason : "complete";
      const ph = typeof data.postHint === "string" ? data.postHint : postHint;
      lastRunEndAt = Date.now();
      if (stopReason === "rate_limit" || /rate\s*limit|429/i.test(ph)) {
        lastRateLimitAt = Date.now();
      }
      let msg = doneMessage(stopReason, list.length, "instagram");
      // Surface the engine's rate-limit diagnosis instead of a generic timeout
      if (/rate\s*limit|429/i.test(ph)) {
        msg = doneMessage("rate_limit", list.length, "instagram");
      }
      setLocal({
        status: mapDone(stopReason, list.length),
        names: list,
        message: msg,
        postHint: ph,
      });
      sendBg("NAMES_DONE", {
        names: list,
        stopReason,
        postHint: ph,
        runId: currentRunId,
      });
      return;
    }
    if (data.type === "ERROR") {
      if (!isCurrentRun(data.runId)) return;
      if (stopFinalizeTimer) {
        clearTimeout(stopFinalizeTimer);
        stopFinalizeTimer = null;
      }
      setLocal({
        status: "error",
        message: typeof data.message === "string" ? data.message : "Error",
      });
      lastRunEndAt = Date.now();
      sendBg("NAMES_ERROR", { message: data.message, runId: currentRunId });
    }
  });

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (!msg?.type) return;
    if (msg.type === "PING") {
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "START_EXTRACT") {
      if (typeof msg.includeReplies === "boolean") includeReplies = msg.includeReplies;
      startExtract({
        templateUrl: msg.templateUrl,
        runId: msg.runId,
      }).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.type === "STOP_EXTRACT") {
      stopExtract();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "COPY_FROM_PAGE") {
      copyNames().then((ok) => sendResponse({ ok }));
      return true;
    }
    if (msg.type === "GET_PAGE_STATE") {
      sendResponse({ ok: true, status, names, message, postHint, hasTemplate });
      return;
    }
  });

  // Template may arrive while browsing — refresh badge (session storage).
  // Tidak memakai nilai mentah `newValue` (tanpa cek TTL/shape): re-validasi
  // via GET_TEMPLATE seperti GET_STATE popup, jadi badge "siap" selalu akurat
  // bahkan saat template sudah kadaluarsa.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.ing_comment_url) {
      refreshTemplateFlag();
    }
    if (area === "local" && changes.rsx_prefs) applySettings();
  });

  function boot() {
    createUi();
    render();
    // Default visibility: TETAP TERTUTUP (flat minimal) — hasil tersimpan
    // dipulihkan ke state panel + badge FAB; panel tidak auto-buka.
    sendBg("GET_STATE").then((res) => {
      if (!res?.ok || !res?.state) return;
      const st = res.state;
      const saved = Array.isArray(st.names) ? st.names : [];
      // hasTemplate diterapkan TANPA SYARAT (pola popup: GET_STATE merekomputasi
      // TTL+shape) — badge selalu akurat walau tanpa hasil tersimpan, dan saat
      // service worker baru bangun.
      if (typeof st.hasTemplate === "boolean" && st.status !== "running") {
        hasTemplate = st.hasTemplate;
      }
      if (saved.length > 0 && st.status !== "running") {
        setLocal({
          status: st.status === "idle" ? "done" : st.status,
          names: saved,
          message:
            typeof st.message === "string"
              ? st.message
              : `Hasil tersimpan — ${saved.length} username. Klik Copy.`,
          postHint: typeof st.postHint === "string" ? st.postHint : "",
        });
      }
      render();
    });
    refreshTemplateFlag();
    sendBg("INJECT_MAIN").then(() => engineCmd("PING")).then((r) => {
      if (r?.ok) engineReady = true;
    });

    let lastHref = location.href;
    let navTimer = null;

    function onNavigation() {
      if (location.href === lastHref) return;
      lastHref = location.href;
      if (stopFinalizeTimer) {
        clearTimeout(stopFinalizeTimer);
        stopFinalizeTimer = null;
      }
      engineCmd("STOP");
      engineReady = false;
      currentRunId = null;
      setLocal({
        status: "idle",
        names: [],
        message: "Halaman berubah. Buka komentar post ini, lalu Proses.",
        postHint: "",
      });
      sendBg("SET_STATE", {
        patch: {
          status: "idle",
          names: [],
          count: 0,
          message: "Halaman berubah. Buka komentar post ini, lalu Proses.",
          stopReason: null,
          postHint: "",
          runId: null,
        },
      });
      sendBg("INJECT_MAIN").then(() => engineCmd("PING")).then((r) => {
        if (r?.ok) engineReady = true;
      });
      refreshTemplateFlag();
    }

    function scheduleNavCheck() {
      if (navTimer) clearTimeout(navTimer);
      navTimer = setTimeout(() => {
        onNavigation();
        if (!document.getElementById(ROOT_ID)) {
          createUi();
          render();
        }
      }, 300);
    }

    // SPA navigation detection — no polling:
    // 1) DOM mutations (any route change rewrites the tree)
    try {
      new MutationObserver(scheduleNavCheck).observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    } catch {
      /* ignore */
    }
    // 2) history API + popstate/hashchange (route changes without DOM churn)
    try {
      const h = window.history;
      const origPush = h.pushState;
      const origReplace = h.replaceState;
      h.pushState = function (...a) {
        const r = origPush.apply(this, a);
        scheduleNavCheck();
        return r;
      };
      h.replaceState = function (...a) {
        const r = origReplace.apply(this, a);
        scheduleNavCheck();
        return r;
      };
    } catch {
      /* ignore */
    }
    window.addEventListener("popstate", scheduleNavCheck);
    window.addEventListener("hashchange", scheduleNavCheck);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
