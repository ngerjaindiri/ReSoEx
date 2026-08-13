/**
 * Content script — UI + bridge (FB Nama Komentar)
 */
(function () {
  if (window.__FNK_CONTENT__) return;
  window.__FNK_CONTENT__ = true;

  const INJECT_SOURCE = "fb-nama-komentar-inject";
  const ROOT_ID = "fnk-root";

  let ui = null;
  let status = "idle";
  let names = [];
  let message = "Buka 1 postingan Facebook, lalu klik Proses.";
  let postHint = "";
  let includeReplies = true;
  let engineReady = false;
  let currentRunId = null;
  let stopFinalizeTimer = null;
  /** @type {((v: boolean) => void) | null} */
  let readyWaiter = null;

  // Cooldown antar-run — jeda minimum setelah run apa pun, lebih lama lagi
  // setelah rate limit (pola IG, konsisten lintas platform).
  const COOLDOWN_MS = 15_000;
  const COOLDOWN_RATE_LIMIT_MS = 60_000;
  let lastRunEndAt = 0;
  let lastRateLimitAt = 0;
  /** Filter pencarian & urutan daftar nama di panel (parity popup). */
  let query = "";
  let sortAz = false;

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
    // Data plane only — control is ENGINE_CMD (no shared secrets in postMessage)
    const t = data.type;
    return (
      t === "READY" ||
      t === "PROGRESS" ||
      t === "DONE" ||
      t === "ERROR"
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
        if (readyWaiter) readyWaiter(true);
        return true;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return engineReady;
  }

  // BEGIN-RESO-NORMALIZE
  function normalizeCommentName(raw) {
    if (typeof raw !== "string") return "";
    let name = raw
      .replace(/\u200b|\u200c|\u200d|\ufeff/g, "")
      .replace(/\s+/g, " ")
      .trim();
    name = name.replace(/\s+[·•|].*$/, "").trim();
    name = name.replace(
      /\s+(sekitar\s+)?(satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan|sepuluh|beberapa)\s+(jam|menit|detik|hari|minggu|tahun|bulan)\s+(yang\s+lalu|lalu).*$/i,
      ""
    );
    name = name.replace(
      /\s+(sehari|semenit|sejam|setahun|seminggu|sebulan)\s+(yang\s+lalu|lalu).*$/i,
      ""
    );
    name = name.replace(
      /\s+\d+\s+(jam|menit|detik|hari|minggu|tahun|bulan)\s+(yang\s+lalu|lalu).*$/i,
      ""
    );
    name = name.replace(
      /\s+(about\s+)?(a|an|\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago.*$/i,
      ""
    );
    name = name.replace(/\s+just\s+now.*$/i, "");
    name = name.replace(
      /\s+\d+\s*(d|h|m|w|y|jam|menit|hari|minggu|tahun|bulan|hr|min|detik|sec|second|minute|hour|day|week|month|year)s?\b.*$/i,
      ""
    );
    name = name.replace(/\s+Edited$/i, "").trim();
    if (/\bis with\b/i.test(name)) name = name.split(/\bis with\b/i)[0].trim();
    if (!name) return "";
    if (name.length < 2 || name.length > 100) return "";
    if (name.startsWith("@")) return "";
    if (/^\d+$/.test(name)) return "";
    if (/https?:\/\//i.test(name) || /@\w+\.\w+/.test(name)) return "";
    if (/^(wa\.me|bit\.ly|t\.co|goo\.gl|tinyurl\.com|s\.id|link\.)\b/i.test(name)) return "";
    if (/\b(wa\.me|bit\.ly|t\.co)\b/i.test(name)) return "";
    if (/^[a-z0-9][-a-z0-9]*\.[a-z]{2,6}\//i.test(name)) return "";
    const blocked = [
      /^view\b/i, /^see\b/i, /^like\b/i, /^likes$/i, /^reply\b/i, /^share\b/i,
      /^comment\b/i, /^write\b/i, /^log\s*in/i, /^sign\s*up/i, /^facebook$/i,
      /^meta$/i, /^suka$/i, /^balas$/i, /^bagikan$/i, /^komentar$/i, /^tulis/i,
      /^lihat/i, /^tampilkan/i, /^semua$/i, /^most relevant$/i, /^all comments$/i,
      /^newest$/i, /^terbaru$/i, /^paling relevan$/i, /^edited$/i, /^sponsor/i,
      /^follow$/i, /^following$/i, /^followers$/i, /^ikuti$/i, /^send\b/i,
      /^kirim$/i, /^hide\b/i, /^open\b/i, /^photo$/i, /^video$/i, /^reels?$/i,
      /^add a comment/i, /^tulis komentar/i, /^write a comment/i,
      /^see more$/i, /^lihat selengkapnya$/i,
      /^tiktok$/i,
    ];
    if (blocked.some((re) => re.test(name))) return "";
    try {
      if (!/[\p{L}\p{N}]/u.test(name)) return "";
    } catch {
      if (!/[a-zA-Z0-9\u00C0-\u024F]/.test(name)) return "";
    }
    return name;
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

  function mergeNames(list) {
    const map = new Map();
    for (const n of list || []) {
      const k = normalizeCommentName(n);
      if (k && !map.has(k.toLowerCase())) map.set(k.toLowerCase(), k);
    }
    return [...map.values()];
  }

  /** Daftar nama yang terlihat — hormati filter pencarian & urutan A–Z. */
  function visible() {
    let out = filterNames(names, query);
    if (sortAz) out = sortNamesAz(out);
    return out;
  }

  function toggleSort() {
    sortAz = !sortAz;
    renderUi();
  }

  async function exportCsv() {
    const vis = visible();
    if (!vis.length) {
      setLocalState({ message: "Belum ada nama untuk diekspor." });
      return;
    }
    const date = new Date().toISOString().slice(0, 10);
    downloadTextFile(
      `reso-nama-${date}.csv`,
      csvContent(vis, false),
      "text/csv;charset=utf-8"
    );
    setLocalState({ message: `CSV tersimpan: ${vis.length} nama.` });
  }

  async function mergeAll() {
    // Merge dijalankan di background (shared.js punya ketiga normalizer
    // platform); content script hanya membawa normalizer platform-nya sendiri.
    const res = await sendBg("MERGE_ALL");
    const merged = Array.isArray(res?.names) ? res.names : [];
    if (!merged.length) {
      setLocalState({
        message: "Belum ada hasil di Facebook, TikTok, maupun Instagram.",
      });
      return;
    }
    try {
      await navigator.clipboard.writeText(merged.join("\n"));
      setLocalState({
        message: `Gabung: ${merged.length} nama unik tersalin. Paste di Excel.`,
      });
    } catch {
      setLocalState({
        message: `Gabung: ${merged.length} nama unik. Buka hasil lalu Copy per platform.`,
      });
    }
  }

  function setLocalState(patch) {
    if (patch.status) status = patch.status;
    if (patch.names) names = mergeNames(patch.names);
    if (patch.message != null) message = patch.message;
    if (patch.postHint != null) postHint = patch.postHint;
    if (typeof patch.includeReplies === "boolean") includeReplies = patch.includeReplies;
    renderUi();
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
    // A newer start/stop superseded this one
    if (gen !== startGen) return;

    // Cooldown antar-run — run beruntun adalah pemicu rate-limit (pola IG
    // v1.0.15, konsisten lintas platform): jeda minimum setelah run apa pun,
    // lebih lama lagi setelah rate limit.
    const nowC = Date.now();
    const sinceEnd = lastRunEndAt ? nowC - lastRunEndAt : Infinity;
    const sinceRl = lastRateLimitAt ? nowC - lastRateLimitAt : Infinity;
    const coolMs =
      sinceRl < COOLDOWN_RATE_LIMIT_MS
        ? COOLDOWN_RATE_LIMIT_MS - sinceRl
        : Math.max(0, COOLDOWN_MS - sinceEnd);
    if (coolMs > 0) {
      const waitSec = Math.ceil(coolMs / 1000);
      setLocalState({
        status: "idle",
        message: `Tunggu ${waitSec} dtk sebelum Proses lagi (cooldown anti rate-limit).`,
      });
      setTimeout(() => {
        if (status !== "running") {
          setLocalState({
            message: "Cooldown selesai — klik Proses untuk mulai.",
          });
        }
      }, coolMs);
      return;
    }

    // Pre-check login (pola IG/TT): replay GraphQL butuh sesi Facebook.
    // Gagal cepat dengan pesan jelas alih-alih run yang sia-sia saat logout.
    const login = await sendBg("CHECK_FB_LOGIN");
    if (gen !== startGen) return;
    if (login && login.loggedIn === false) {
      const noLoginMsg =
        "Sesi Facebook tidak aktif — login di facebook.com lalu Proses lagi.";
      setLocalState({
        status: "error",
        names: [],
        message: noLoginMsg,
        postHint: "",
      });
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

    currentRunId = opts.runId || makeRunId();
    setLocalState({
      status: "running",
      names: [],
      message: "Menyiapkan engine…",
    });
    // tabId stamped by background from sender.tab
    const stRes = await sendBg("SET_STATE", {
      patch: {
        status: "running",
        names: [],
        count: 0,
        message: "Menyiapkan engine…",
        stopReason: null,
        includeReplies,
        runId: currentRunId,
      },
    });
    if (gen !== startGen) return;
    if (stRes && stRes.ok === false) {
      setLocalState({
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
      setLocalState({
        status: "error",
        message:
          "Engine belum siap. Refresh halaman Facebook, lalu coba lagi.",
      });
      await sendBg("NAMES_ERROR", {
        message: "Engine belum siap.",
        runId: currentRunId,
      });
      return;
    }

    markBestPostRoot();
    setLocalState({ message: "Memulai ekstrak…" });
    const started = await engineCmd("START", {
      maxMs: 150_000,
      includeReplies,
      runId: currentRunId,
    });
    if (gen !== startGen) return;
    if (!started?.ok) {
      setLocalState({
        status: "error",
        message:
          started?.error === "Run active on another tab — stop it first"
            ? "Sudah ada proses di tab lain. Stop dulu, lalu coba lagi."
            : "Gagal memulai engine. Refresh postingan lalu coba lagi.",
      });
      await sendBg("NAMES_ERROR", {
        message: started?.error || "START failed",
        runId: currentRunId,
      });
      // Ensure MAIN engine is not left half-started
      await engineCmd("STOP");
    }
  }

  function stopExtract() {
    // Invalidate any in-flight startExtract
    startGen += 1;
    engineCmd("STOP");
    setLocalState({ status: "running", message: "Menghentikan…" });
    // Finalize if inject never answers
    if (stopFinalizeTimer) clearTimeout(stopFinalizeTimer);
    const stopRunId = currentRunId;
    stopFinalizeTimer = setTimeout(() => {
      if (status !== "running") return;
      if (currentRunId !== stopRunId) return;
      const list = names.slice();
      lastRunEndAt = Date.now();
      setLocalState({
        status: list.length ? "stopped" : "error",
        message: doneMessage("stopped", list.length, "facebook"),
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
    setLocalState({
      status: "idle",
      names: [],
      message: "Buka 1 postingan Facebook, lalu klik Proses.",
      postHint: "",
    });
    await sendBg("RESET");
  }

  function markBestPostRoot() {
    // Clear old marks
    document.querySelectorAll("[data-fnk-post-root]").forEach((el) => {
      el.removeAttribute("data-fnk-post-root");
    });

    // Prefer host of inline bar if docked inside a post
    const bar = document.getElementById("fnk-inline");
    if (bar) {
      const host =
        bar.closest('[role="article"]') ||
        bar.closest('[data-pagelet*="FeedUnit"]') ||
        bar.closest('[data-pagelet*="Permalink"]') ||
        bar.closest('[data-pagelet*="CometSinglePost"]');
      if (host) {
        host.setAttribute("data-fnk-post-root", "1");
        return;
      }
    }

    // Permalink: mark largest article
    const arts = [
      ...document.querySelectorAll(
        'div[role="article"], div[data-pagelet*="FeedUnit"], div[data-pagelet*="Permalink"]'
      ),
    ];
    let best = null;
    let bestH = 0;
    for (const a of arts) {
      const h = a.getBoundingClientRect().height;
      if (h > bestH) {
        bestH = h;
        best = a;
      }
    }
    if (best) best.setAttribute("data-fnk-post-root", "1");
  }

  async function copyNames() {
    const vis = visible();
    const text = vis.join("\n");
    if (!text) {
      setLocalState({ message: "Belum ada nama untuk disalin." });
      return false;
    }
    try {
      await navigator.clipboard.writeText(text);
      setLocalState({
        message: `Tersalin ${vis.length} nama. Paste di Excel (Ctrl+V).`,
      });
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        document.execCommand("copy");
        setLocalState({
          message: `Tersalin ${vis.length} nama. Paste di Excel.`,
        });
        return true;
      } catch {
        setLocalState({ message: "Gagal copy. Coba lagi dari panel atau popup." });
        return false;
      } finally {
        ta.remove();
      }
    }
  }

  function markPostFromEl(el) {
    document.querySelectorAll("[data-fnk-post-root]").forEach((n) => {
      n.removeAttribute("data-fnk-post-root");
    });
    const host =
      el?.closest?.('[role="article"]') ||
      el?.closest?.('[data-pagelet*="FeedUnit"]') ||
      el?.closest?.('[data-pagelet*="Permalink"]') ||
      el?.closest?.('[data-pagelet*="CometSinglePost"]');
    if (host) host.setAttribute("data-fnk-post-root", "1");
  }

  function createUi() {
    if (document.getElementById(ROOT_ID)) {
      ui = document.getElementById(ROOT_ID);
      return ui;
    }
    const root = document.createElement("div");
    root.id = ROOT_ID;
    // Default visibility: TERTUTUP selalu (flat minimal) — panel tidak
    // mengambang menutupi halaman saat scrolling. Buka lewat FAB atau ikon
    // di bar Like; hasil tetap terlihat di badge FAB.
    root.classList.add("fnk-collapsed");
    ensureIconFont();
    root.innerHTML = `
      <div class="fnk-panel" role="region" aria-label="FB Nama Komentar">
        <div class="fnk-header">
          <span class="rs-ic fnk-logo-ic" aria-hidden="true">facebook</span>
          <span class="fnk-title">Nama Komentar</span>
          <button type="button" class="fnk-min" title="Tutup" aria-label="Tutup panel" data-fnk="min"><span class="rs-ic" aria-hidden="true">close</span></button>
        </div>
        <div class="fnk-body">
          <div class="fnk-status" data-fnk="status" aria-live="polite"></div>
          <div class="fnk-hint" data-fnk="hint"></div>
          <div class="fnk-count" data-fnk="count">0 nama</div>
          <div class="fnk-badge" data-fnk="badge"></div>
          <label class="fnk-check">
            <input type="checkbox" data-fnk="replies" />
            <span class="rs-ic" aria-hidden="true">forum</span>
            <span>Balasan</span>
          </label>
          <div class="fnk-tools">
            <span class="rs-ic fnk-search-ic" aria-hidden="true">search</span>
            <input class="fnk-search" type="search" data-fnk="search" placeholder="Cari…" aria-label="Cari nama" />
            <button type="button" class="fnk-btn fnk-sort" data-fnk="sort" title="Urutkan A–Z" aria-label="Urutkan A–Z" aria-pressed="false"><span class="rs-ic" aria-hidden="true">sort</span></button>
          </div>
          <div class="fnk-list" data-fnk="list" hidden></div>
          <div class="fnk-actions">
            <button type="button" class="fnk-btn fnk-primary" data-fnk="process" title="Mulai ambil nama" aria-label="Mulai ambil nama"><span class="rs-ic" aria-hidden="true">play_arrow</span></button>
            <button type="button" class="fnk-btn" data-fnk="stop" hidden title="Hentikan" aria-label="Hentikan"><span class="rs-ic" aria-hidden="true">stop</span></button>
            <button type="button" class="fnk-btn fnk-success" data-fnk="copy" disabled title="Salin ke clipboard" aria-label="Salin nama"><span class="rs-ic" aria-hidden="true">content_copy</span></button>
            <button type="button" class="fnk-btn" data-fnk="csv" disabled title="Simpan ke CSV (Excel)" aria-label="Simpan CSV"><span class="rs-ic" aria-hidden="true">download</span></button>
            <button type="button" class="fnk-btn fnk-ghost" data-fnk="reset" title="Bersihkan hasil" aria-label="Bersihkan hasil"><span class="rs-ic" aria-hidden="true">restart_alt</span></button>
            <button type="button" class="fnk-btn fnk-ghost" data-fnk="merge" title="Gabung FB + TikTok + IG lalu salin" aria-label="Gabung semua platform"><span class="rs-ic" aria-hidden="true">merge_type</span></button>
          </div>
        </div>
      </div>
      <button type="button" class="fnk-fab" data-fnk="fab" data-count="" title="Nama Komentar" aria-label="Buka panel Nama Komentar"><span class="rs-ic" aria-hidden="true">forum</span></button>
    `;
    (document.body || document.documentElement).appendChild(root);
    ui = root;

    root.addEventListener("click", (e) => {
      const t = e.target.closest("[data-fnk]");
      if (!t) return;
      const act = t.getAttribute("data-fnk");
      if (act === "process") startExtract();
      if (act === "stop") stopExtract();
      if (act === "copy") copyNames();
      if (act === "reset") doReset();
      if (act === "csv") exportCsv();
      if (act === "merge") mergeAll();
      if (act === "sort") toggleSort();
      if (act === "min") {
        root.classList.add("fnk-collapsed");
      }
      if (act === "fab") {
        root.classList.remove("fnk-collapsed");
      }
    });
    root.addEventListener("change", (e) => {
      const t = e.target;
      if (t && t.getAttribute?.("data-fnk") === "replies") {
        includeReplies = !!t.checked;
        // Persist pref seketika (parity popup) — bukan hanya saat run dimulai.
        sendBg("SET_STATE", { patch: { includeReplies } });
      }
    });
    root.addEventListener("input", (e) => {
      if (e.target?.getAttribute?.("data-fnk") === "search") {
        query = e.target.value;
        renderUi();
      }
    });
    // Keyboard: Esc menutup panel (setara tombol min).
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !ui) return;
      if (!ui.classList.contains("fnk-collapsed")) {
        ui.classList.add("fnk-collapsed");
      }
    });

    ensureActionIcon();
    applySettings();
    return root;
  }

  /** Load Material Symbols (Google) sekali — dipakai semua ikon panel/FAB. */
  function ensureIconFont() {
    if (document.getElementById("rs-ms-font")) return;
    const link = document.createElement("link");
    link.id = "rs-ms-font";
    link.rel = "stylesheet";
    link.href =
      "https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,300..700,0..1,-50..200&display=block";
    (document.head || document.documentElement).appendChild(link);
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
          const v = prefs.includeReplies?.facebook;
          if (status !== "running" && typeof v === "boolean" && includeReplies !== v) {
            includeReplies = v;
            renderUi();
          }
        })
        .catch(() => {});
    } catch {
      /* ignore */
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.rsx_prefs) applySettings();
  });

  /** Small icon-only control near Like / Comment / Share */
  function ensureActionIcon() {
    if (document.getElementById("fnk-inline")) return;
    const chip = document.createElement("div");
    chip.id = "fnk-inline";
    chip.className = "fnk-inline-hidden";
    chip.innerHTML = `
      <button type="button" class="fnk-action-icon" data-fnk-inline="main"
        title="Buka panel Nama Komentar"
        aria-label="Buka panel Nama Komentar">
        <svg class="fnk-action-svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <!-- forum — ikon sama dengan FAB (satu entry point, design system CONSISTENCY.md) -->
          <path fill="currentColor" d="M21 6h-2v9H6v2c0 .55.45 1 1 1h11l4 4V7c0-.55-.45-1-1-1zm-4 6V3c0-.55-.45-1-1-1H3c-.55 0-1 .45-1 1v14l4-4h10c.55 0 1-.45 1-1z"/>
        </svg>
        <span class="fnk-action-badge" data-fnk-inline="badge" hidden></span>
      </button>
    `;
    chip.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const t = e.target.closest("[data-fnk-inline]");
      if (!t) return;
      // Model interaksi seragam dengan FAB: klik chip = BUKA PANEL saja
      // (bukan langsung proses/copy). Post tempat chip berada ditandai agar
      // engine menyasar post yang benar saat Proses ditekan.
      markPostFromEl(chip);
      if (ui) {
        ui.classList.remove("fnk-collapsed");
      }
    });
    // Right-click / long alternative: open panel only
    chip.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (ui) ui.classList.toggle("fnk-collapsed");
    });
    document.documentElement.appendChild(chip);
  }

  function findBestPost() {
    const posts = [
      ...document.querySelectorAll(
        'div[role="article"], div[data-pagelet*="FeedUnit"], div[data-pagelet*="Permalink"], div[data-pagelet*="CometSinglePost"]'
      ),
    ];
    let bestPost = null;
    let bestScore = -1;
    const vh = window.innerHeight || 800;
    for (const post of posts) {
      const r = post.getBoundingClientRect();
      if (r.height < 80) continue;
      const mid = (r.top + r.bottom) / 2;
      let score = 1000 - Math.abs(mid - vh / 2);
      const text = (post.innerText || "").slice(0, 500);
      if (/\b(Like|Suka|Comment|Komentar|Share|Bagikan)\b/i.test(text)) score += 300;
      if (/comment|komentar/i.test(text)) score += 200;
      if (score > bestScore) {
        bestScore = score;
        bestPost = post;
      }
    }
    return bestPost;
  }

  /**
   * Find the UFI action row (Like / Comment / Share) inside a post.
   * Toleran terhadap perubahan DOM Facebook (2025–2026): tombol aksi bisa
   * berlabel teks, ikon-only, atau ikon kecil tak berlabel di samping kotak
   * komentar — anchor boleh salah satu dari Like/Comment/Share, dan baris
   * cukup memuat 2+ aksi (tidak wajib Like pertama).
   */
  function actionLabel(btn) {
    return `${btn.innerText || ""} ${btn.getAttribute("aria-label") || ""} ${btn.getAttribute("title") || ""}`
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function findActionRow(post) {
    if (!post) return null;
    const isLike = (t) =>
      /^(like|suka)\b/.test(t) ||
      t === "like" ||
      t === "suka" ||
      /beri reaksi|\breact\b/.test(t);
    const isComment = (t) =>
      /\bcomment\b|\bkomentar\b/.test(t) ||
      /\bleave a comment\b|\btulis komentar\b/.test(t);
    const isShare = (t) => /\bshare\b|\bbagikan\b/.test(t);

    const buttons = post.querySelectorAll('[role="button"]');
    for (const btn of buttons) {
      const t = actionLabel(btn);
      if (!isLike(t) && !isComment(t) && !isShare(t)) continue;
      let row = btn.parentElement;
      for (let i = 0; i < 8 && row; i++) {
        const labels = [...row.querySelectorAll('[role="button"]')]
          .map(actionLabel)
          .filter(Boolean)
          .join(" | ");
        const hasLike = isLike(labels) || /(^|\|)(like|suka)\b/.test(labels);
        const hasComment = isComment(labels) || /(^|\|)(comment|komentar)\b/.test(labels);
        const hasShare = isShare(labels) || /(^|\|)(share|bagikan)\b/.test(labels);
        const score = (hasLike ? 1 : 0) + (hasComment ? 1 : 0) + (hasShare ? 1 : 0);
        if (score >= 2) {
          // Prefer the tightest row that still has 2+ actions
          return row;
        }
        row = row.parentElement;
      }
    }
    return null;
  }

  function placeInlineBar() {
    ensureActionIcon();
    const chip = document.getElementById("fnk-inline");
    if (!chip) return;
    const post = findBestPost();
    if (!post) {
      chip.classList.add("fnk-inline-hidden");
      return;
    }
    const row = findActionRow(post);
    let host = row || null;
    if (!host) {
      // Fallback: baris komposer (kolom "Tulis komentar…") — posisi aksi di
      // layout FB baru (ikon kecil di samping kotak komentar). Hindari chip
      // menempel di ujung bawah post yang tampak "pecah".
      const composer = post.querySelector(
        '[role="textbox"], textarea, [contenteditable="true"]'
      );
      host = (composer && composer.parentElement) || null;
    }
    if (!host) host = post;
    if (chip.parentElement !== host) {
      try {
        // Append at end of Like/Comment/Share row so it sits next to them
        host.appendChild(chip);
      } catch {
        return;
      }
    }
    chip.classList.remove("fnk-inline-hidden");
    chip.classList.add("fnk-inline-docked");
    // Flex-friendly if parent is flex — selalu paling kanan (order 99) agar
    // tidak menggeser tombol Like/Comment/Share Facebook.
    try {
      const cs = getComputedStyle(host);
      if (cs.display === "flex" || cs.display === "inline-flex") {
        chip.style.alignSelf = "center";
        chip.style.order = "99";
      }
    } catch {
      /* ignore */
    }
  }

  // BEGIN-RESO-FBURLS
  /**
   * SINGLE SOURCE OF TRUTH untuk deteksi permalink Facebook — dipakai badge
   * panel (isFacebookPostPage), synthetic template engine (extractFbFeedbackIds),
   * dan pre-check. Disalin byte-identik ke inject-fb.js & content-fb.js; dijamin
   * fixture test FBURLS. Mengembalikan kandidat story/feedback id dari URL;
   * engine mem-probe tiap kandidat (urutan = prioritas) dan memakai yang benar
   * menghasilkan page_info — robust terhadap bentuk URL yang id-nya ambigu
   * (mis. album `set=a.X.Y.Z`, postingan multi-foto `set=pcb.<story>`,
   * dan `photos/a.<uid>.<fbid>`).
   */
  function extractFbFeedbackIds(url) {
    const out = [];
    const add = (id) => {
      if (typeof id !== "string" || !/^[A-Za-z0-9]{8,}$/.test(id)) return;
      if (!out.includes(id)) out.push(id);
    };
    if (!url || typeof url !== "string") return out;
    const href = url;

    // 1) Bentuk path yang membawa story/feedback id
    const direct = [
      /\/posts\/[^/?#]+\/([^/?#]+)/, // posts/<slug>/<id> (gaya baru)
      /\/posts\/([^/?#]+)/, // posts/<id> (klasik & grup)
      /\/permalink\.php\?story_fbid=([^&#]+)/,
      /\/story\.php\?story_fbid=([^&#]+)/,
      /\/photos\/a\.\d+\.(\d+)/, // photos/a.<uid>.<fbid> (album foto)
      /\/photos\/(\d+)/, // foto tunggal (id foto — probe memvalidasi)
      /\/videos\/(\d+)/,
      /\/reel\/(\d+)/,
      /\/video\.php\?v=(\d+)/,
    ];
    for (const re of direct) {
      const m = href.match(re);
      if (m) add(m[1]);
    }

    // 2) Watch (query v=) — bentuk paling umum untuk permalink video
    const watch = href.match(/\/watch(?:[^?#]*\?|\?)[^#]*\bv=(\d+)/i);
    if (watch) add(watch[1]);

    // 3) Param umum (story_fbid/fbid/v, termasuk nilai pfbid alfanumerik)
    //    + set: pcb.<story> = postingan multi-foto (id-nya feedback/story id,
    //      prioritas tinggi karena `fbid` di URL tersebut id foto, bukan story)
    //      dan a.<album>.<user>.<story> (komponen terakhir = story id)
    try {
      const u = new URL(href);
      for (const key of ["story_fbid"]) {
        const val = u.searchParams.get(key);
        if (val) add(val);
      }
      const set = u.searchParams.get("set") || "";
      const parts = String(set).split(".");
      if (parts[0] === "pcb" && parts.length >= 2) add(parts[parts.length - 1]);
      for (const key of ["fbid", "v"]) {
        const val = u.searchParams.get(key);
        if (val) add(val);
      }
      if (parts[0] === "a" && parts.length >= 4) add(parts[3]);
    } catch {
      /* ignore */
    }
    return out;
  }

  /** Kandidat pertama (prioritas tertinggi). */
  function extractFbFeedbackId(url) {
    const ids = extractFbFeedbackIds(url);
    return ids.length ? ids[0] : null;
  }

  /** Apakah URL adalah halaman post permalink FB yang didukung engine? */
  function isFacebookPostPage(url) {
    return extractFbFeedbackIds(url).length > 0;
  }
  // END-RESO-FBURLS

  /** FB: engine dapat paginate via GraphQL bila halaman post permalink
   *  (synthetic template dari feedbackId di URL — via blok FBURLS). */
  function fbGraphqlReady() {
    return isFacebookPostPage(String(location.href));
  }

  function renderUi() {
    if (!ui) createUi();
    ui.setAttribute("data-status", status || "idle");
    const statusEl = ui.querySelector('[data-fnk="status"]');
    const hintEl = ui.querySelector('[data-fnk="hint"]');
    const countEl = ui.querySelector('[data-fnk="count"]');
    const badgeEl = ui.querySelector('[data-fnk="badge"]');
    const processBtn = ui.querySelector('[data-fnk="process"]');
    const stopBtn = ui.querySelector('[data-fnk="stop"]');
    const copyBtn = ui.querySelector('[data-fnk="copy"]');
    const csvBtn = ui.querySelector('[data-fnk="csv"]');
    const mergeBtn = ui.querySelector('[data-fnk="merge"]');
    const replies = ui.querySelector('[data-fnk="replies"]');

    if (statusEl) statusEl.textContent = message;
    if (hintEl) {
      // Sembunyikan detail teknis (mode/template engine) saat run selesai;
      // baris status sudah menjelaskan hasilnya.
      const terminal = ["done", "partial", "stopped", "error"].includes(status);
      hintEl.textContent = terminal
        ? ""
        : postHint
          ? `Target: ${postHint}`
          : "Buka permalink post, buka komentar, lalu Proses.";
    }
    // Count — saat filter aktif tampilkan "X dari N" agar jelas kenapa
    // tombol Copy bisa nonaktif walau ada hasil.
    const vis = visible();
    if (countEl) {
      countEl.textContent = query.trim()
        ? `${vis.length} dari ${names.length} nama`
        : names.length
          ? `${names.length} nama`
          : "0 nama";
    }
    if (badgeEl) {
      const ready = fbGraphqlReady();
      badgeEl.innerHTML = ready
        ? '<span class="rs-ic">check_circle</span>Siap'
        : '<span class="rs-ic">error</span>Belum';
      badgeEl.classList.toggle("fnk-ok", ready);
      badgeEl.classList.toggle("fnk-warn", !ready);
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
        running ? "Memproses…" : "Mulai ambil nama"
      );
    }
    if (stopBtn) stopBtn.hidden = !running;
    if (copyBtn) {
      copyBtn.disabled = vis.length === 0;
      copyBtn.setAttribute(
        "aria-label",
        vis.length ? `Salin nama (${vis.length})` : "Salin nama"
      );
    }
    if (csvBtn) csvBtn.disabled = vis.length === 0;
    if (mergeBtn) mergeBtn.disabled = false;
    const sortBtn = ui.querySelector('[data-fnk="sort"]');
    if (sortBtn) {
      sortBtn.setAttribute("aria-pressed", String(sortAz));
      sortBtn.classList.toggle("fnk-active", sortAz);
      sortBtn.title = sortAz ? "Urutkan asli" : "Urutkan A–Z";
      sortBtn.setAttribute("aria-label", sortAz ? "Urutkan asli" : "Urutkan A–Z");
    }

    // Preview daftar — hormati filter & urutan (parity dengan popup).
    const listEl = ui.querySelector('[data-fnk="list"]');
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

    // Action-bar icon state (chip = pintu panel, seragam dengan FAB)
    const chip = document.getElementById("fnk-inline");
    if (chip) {
      const btn = chip.querySelector(".fnk-action-icon");
      const badge = chip.querySelector('[data-fnk-inline="badge"]');
      chip.classList.toggle("fnk-inline-running", running);
      chip.classList.toggle(
        "fnk-inline-done",
        !running &&
          names.length > 0 &&
          (status === "done" || status === "partial" || status === "stopped")
      );
      if (btn) {
        if (running) {
          btn.title = "Proses berjalan — buka panel untuk Stop";
          btn.setAttribute("aria-label", "Proses sedang berjalan");
        } else if (names.length > 0) {
          btn.title = `Buka panel — ${names.length} nama terkumpul`;
          btn.setAttribute(
            "aria-label",
            `Buka panel Nama Komentar (${names.length} nama)`
          );
        } else {
          btn.title = "Buka panel Nama Komentar";
          btn.setAttribute("aria-label", "Buka panel Nama Komentar");
        }
      }
      if (badge) {
        if (names.length > 0) {
          badge.hidden = false;
          badge.textContent = names.length > 99 ? "99+" : String(names.length);
        } else if (running) {
          badge.hidden = false;
          badge.textContent = "…";
        } else {
          badge.hidden = true;
          badge.textContent = "";
        }
      }
    }

    // FAB (model interaksi seragam dengan TikTok/Instagram): badge jumlah,
    // pulse saat running, warna done saat ada hasil — klik membuka panel.
    const fab = ui.querySelector('[data-fnk="fab"]');
    if (fab) {
      fab.setAttribute("data-count", names.length > 0 ? String(names.length) : "");
      fab.classList.toggle("fnk-running", running);
      fab.classList.toggle(
        "fnk-done",
        (status === "done" || status === "partial" || status === "stopped") &&
          names.length > 0
      );
      // Title/aria dinamis mengikuti state (chip bar Like sudah melakukannya).
      const fabTitle = running
        ? "Proses berjalan — buka panel untuk Stop"
        : names.length > 0
          ? `Buka panel — ${names.length} nama terkumpul`
          : "Nama Komentar";
      fab.title = fabTitle;
      fab.setAttribute("aria-label", fabTitle);
    }
  }

  function placeUi() {
    createUi();
    placeInlineBar();
    renderUi();
  }

  function mapDoneStatus(stopReason, count) {
    if (stopReason === "stopped") return "stopped";
    if (stopReason === "timeout") return "partial";
    if (stopReason === "rate_limit") return count ? "partial" : "error";
    if (
      stopReason === "error" ||
      stopReason === "no_template" ||
      stopReason === "no_login"
    )
      return "error";
    if (stopReason === "complete") return count ? "done" : "error";
    if (stopReason === "idle") return count ? "done" : "error";
    return count ? "done" : "error";
  }

  /**
   * Strict run match — reject spoofed/idle inject events.
   * READY is handled separately (no runId).
   */
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
      if (readyWaiter) readyWaiter(true);
      return;
    }

    if (data.type === "PROGRESS") {
      if (status !== "running") return;
      if (!isCurrentRun(data.runId)) return;
      const list = Array.isArray(data.names) ? data.names : [];
      setLocalState({
        status: "running",
        names: list,
        message:
          typeof data.message === "string"
            ? data.message
            : `Mengumpulkan… ${list.length} nama`,
        postHint:
          typeof data.postHint === "string" ? data.postHint : postHint,
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
      lastRunEndAt = Date.now();
      if (stopReason === "rate_limit" || /rate\s*limit|429/i.test(data.postHint || "")) {
        lastRateLimitAt = Date.now();
      }
      const st = mapDoneStatus(stopReason, list.length);
      // Pesan akhir via helper tunggal (DONEMSG) — konsisten dengan popup &
      // platform lain. Suffix [graphql]/[dom] dihapus (mode tetap terlihat
      // di baris "Target:").
      const tip =
        !list.length && data.postHint && /Tip:/i.test(data.postHint)
          ? data.postHint.replace(/^[\s\S]*?Tip:/i, "Tip:")
          : "";
      const finalMsg = doneMessage(stopReason, list.length, "facebook", {
        tip,
      });
      setLocalState({
        status: st,
        names: list,
        message: finalMsg,
        postHint:
          typeof data.postHint === "string" ? data.postHint : postHint,
      });
      // Default visibility = TETAP TERTUTUP (flat minimal) — hasil terlihat
      // di badge FAB; panel hanya dibuka oleh user (FAB / ikon bar Like).
      sendBg("NAMES_DONE", {
        names: list,
        stopReason,
        postHint: data.postHint,
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
      setLocalState({
        status: "error",
        message:
          typeof data.message === "string" ? data.message : "Error",
      });
      sendBg("NAMES_ERROR", { message: data.message, runId: currentRunId });
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === "PING") {
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "START_EXTRACT") {
      if (typeof msg.includeReplies === "boolean") includeReplies = msg.includeReplies;
      startExtract({ runId: msg.runId }).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.type === "STOP_EXTRACT") {
      stopExtract();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "GET_PAGE_STATE") {
      sendResponse({ ok: true, status, names, message, postHint, includeReplies });
      return;
    }
    if (msg.type === "COPY_FROM_PAGE") {
      copyNames().then((ok) => sendResponse({ ok }));
      return true;
    }
  });

  function boot() {
    placeUi();
    // Default visibility: TETAP TERTUTUP (flat minimal) — hasil tersimpan
    // dipulihkan ke state panel, badge FAB menampilkan jumlah, tapi panel
    // tidak mengambang terbuka di atas halaman.
    sendBg("GET_STATE").then((res) => {
      if (!res?.ok || !res?.state) return;
      const st = res.state;
      const saved = Array.isArray(st.names) ? st.names : [];
      if (saved.length > 0 && st.status !== "running") {
        setLocalState({
          status: st.status === "idle" ? "done" : st.status,
          names: saved,
          message:
            typeof st.message === "string"
              ? st.message
              : `Hasil tersimpan — ${saved.length} nama. Klik Copy.`,
          postHint: typeof st.postHint === "string" ? st.postHint : "",
        });
      }
    });
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
      setLocalState({
        status: "idle",
        names: [],
        message: "Halaman berubah. Klik Proses di postingan ini.",
        postHint: "",
      });
      sendBg("SET_STATE", {
        patch: {
          status: "idle",
          names: [],
          count: 0,
          message: "Halaman berubah. Klik Proses di postingan ini.",
          stopReason: null,
          postHint: "",
          runId: null,
        },
      });
      sendBg("INJECT_MAIN").then(() => engineCmd("PING")).then((r) => {
        if (r?.ok) engineReady = true;
      });
    }

    function scheduleNavCheck() {
      if (navTimer) clearTimeout(navTimer);
      navTimer = setTimeout(() => {
        onNavigation();
        if (!document.getElementById(ROOT_ID)) placeUi();
        else placeInlineBar();
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
    // Chip bar Like: React Facebook sering me-render ulang post (buka komentar,
    // scroll, like) dan chip ikut terlepas dari DOM. Coalescing timer (TIDAK
    // di-reset tiap mutasi) memastikan chip selalu terpasang kembali walau
    // halaman bermutasi terus-menerus — tanpa polling.
    let chipTimer = null;
    try {
      new MutationObserver(() => {
        if (chipTimer) return;
        chipTimer = setTimeout(() => {
          chipTimer = null;
          const chip = document.getElementById("fnk-inline");
          if (!chip || !chip.isConnected) placeInlineBar();
        }, 800);
      }).observe(document.body, { childList: true, subtree: true });
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

  // document_start may run before body exists
  function safeBoot() {
    if (!document.documentElement) {
      setTimeout(safeBoot, 50);
      return;
    }
    if (document.body || document.readyState !== "loading") {
      boot();
    } else {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
      // also try after a tick (SPA)
      setTimeout(() => {
        if (!document.getElementById(ROOT_ID)) boot();
      }, 800);
    }
  }
  safeBoot();
})();
