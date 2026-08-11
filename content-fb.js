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
  let message = "Buka 1 postingan, lalu klik Proses.";
  let postHint = "";
  let includeReplies = true;
  let engineReady = false;
  let currentRunId = null;
  let stopFinalizeTimer = null;
  /** @type {((v: boolean) => void) | null} */
  let readyWaiter = null;
  /** true saat user sengaja menutup panel (min) — jangan dipaksa buka lagi */
  let userCollapsed = false;

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

  function mergeNames(list) {
    const map = new Map();
    for (const n of list || []) {
      const k = normalizeCommentName(n);
      if (k && !map.has(k.toLowerCase())) map.set(k.toLowerCase(), k);
    }
    return [...map.values()];
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
      message: "Buka 1 postingan, lalu klik Proses.",
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
    const text = names.join("\n");
    if (!text) {
      setLocalState({ message: "Belum ada nama untuk disalin." });
      return false;
    }
    try {
      await navigator.clipboard.writeText(text);
      setLocalState({
        message: `Tersalin ${names.length} nama. Paste di Excel (Ctrl+V).`,
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
          message: `Tersalin ${names.length} nama. Paste di Excel.`,
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
    // Default visibility: collapsed — otomatis diperluas saat ada hasil
    // (sama dengan TikTok/Instagram). Buka lewat FAB atau ikon di bar Like.
    root.classList.add("fnk-collapsed");
    root.innerHTML = `
      <div class="fnk-panel" role="region" aria-label="FB Nama Komentar">
        <div class="fnk-header">
          <span class="fnk-logo" aria-hidden="true">N</span>
          <span class="fnk-title">Nama Komentar</span>
          <button type="button" class="fnk-min" title="Tutup" aria-label="Tutup panel" data-fnk="min">–</button>
        </div>
        <div class="fnk-body">
          <div class="fnk-status" data-fnk="status" aria-live="polite"></div>
          <div class="fnk-hint" data-fnk="hint"></div>
          <div class="fnk-count" data-fnk="count"></div>
          <div class="fnk-badge" data-fnk="badge"></div>
          <label class="fnk-check">
            <input type="checkbox" data-fnk="replies" checked />
            Sertakan balasan (reply)
          </label>
          <div class="fnk-actions">
            <button type="button" class="fnk-btn fnk-primary" data-fnk="process" title="Mulai ambil nama">Proses</button>
            <button type="button" class="fnk-btn" data-fnk="stop" hidden title="Hentikan">Stop</button>
            <button type="button" class="fnk-btn fnk-success" data-fnk="copy" disabled title="Salin ke clipboard">Copy nama</button>
            <button type="button" class="fnk-btn fnk-ghost" data-fnk="reset" title="Bersihkan hasil & reset">Reset</button>
          </div>
        </div>
      </div>
      <button type="button" class="fnk-fab" data-fnk="fab" data-count="" title="Nama Komentar" aria-label="Buka panel Nama Komentar">N</button>
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
      if (act === "min") {
        root.classList.add("fnk-collapsed");
        userCollapsed = true;
      }
      if (act === "fab") {
        root.classList.remove("fnk-collapsed");
        userCollapsed = false;
      }
    });
    root.addEventListener("change", (e) => {
      const t = e.target;
      if (t && t.getAttribute?.("data-fnk") === "replies") {
        includeReplies = !!t.checked;
      }
    });
    // Keyboard: Esc menutup panel (setara tombol min).
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !ui) return;
      if (!ui.classList.contains("fnk-collapsed")) {
        ui.classList.add("fnk-collapsed");
        userCollapsed = true;
      }
    });

    ensureActionIcon();
    applySettings();
    return root;
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
          <path fill="currentColor" d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v1h16v-1c0-2.66-5.33-4-8-4z"/>
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
        userCollapsed = false;
      }
    });
    // Right-click / long alternative: open panel only
    chip.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (ui) userCollapsed = ui.classList.toggle("fnk-collapsed");
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
   */
  function findActionRow(post) {
    if (!post) return null;
    const buttons = post.querySelectorAll('[role="button"]');
    for (const btn of buttons) {
      const t = `${btn.innerText || ""} ${btn.getAttribute("aria-label") || ""}`
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      if (!/^(like|suka)\b/.test(t) && t !== "like" && t !== "suka") continue;
      let row = btn.parentElement;
      for (let i = 0; i < 8 && row; i++) {
        const labels = [...row.querySelectorAll('[role="button"]')]
          .map((b) =>
            `${b.innerText || ""} ${b.getAttribute("aria-label") || ""}`
              .toLowerCase()
              .trim()
          )
          .join(" | ");
        const hasLike = /(^|\|)(like|suka)\b/.test(labels) || /\blike\b|\bsuka\b/.test(labels);
        const hasComment =
          /\bcomment\b|\bkomentar\b/.test(labels) ||
          /\bleave a comment\b|\btulis komentar\b/.test(labels);
        const hasShare = /\bshare\b|\bbagikan\b/.test(labels);
        if (hasLike && (hasComment || hasShare)) {
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
    const host = row || post;
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
    // Flex-friendly if parent is flex
    try {
      const cs = getComputedStyle(host);
      if (cs.display === "flex" || cs.display === "inline-flex") {
        chip.style.alignSelf = "center";
      }
    } catch {
      /* ignore */
    }
  }

  /** FB: engine dapat paginate via GraphQL bila halaman post permalink
   *  (synthetic template dari feedbackId di URL — mirror shared.isFacebookPostPage). */
  function fbGraphqlReady() {
    const href = String(location.href);
    if (
      /\/posts\/\d+/.test(href) ||
      /\/permalink\.php\?story_fbid=\d+/.test(href) ||
      /\/story\.php\?story_fbid=\d+/.test(href) ||
      /\/photos\/\d+/.test(href) ||
      /\/videos\/\d+/.test(href) ||
      /\/reel\/\d+/.test(href) ||
      /\/watch\/\d+/.test(href) ||
      /[?&](?:story_fbid|fbid)=\d+/.test(href)
    ) {
      return true;
    }
    try {
      const path = new URL(href).pathname.replace(/^\/+|\/+$/g, "");
      if (/^\d{8,}$/.test(path)) return true;
    } catch {
      /* ignore */
    }
    return false;
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
          : "Tombol N (pojok kanan) atau ikon di bar Like = buka panel";
    }
    if (countEl) countEl.textContent = names.length ? `${names.length} nama` : "0 nama";
    if (badgeEl) {
      const ready = fbGraphqlReady();
      badgeEl.textContent = ready
        ? "API komentar: siap"
        : "API komentar: belum — buka permalink post";
      badgeEl.classList.toggle("fnk-ok", ready);
      badgeEl.classList.toggle("fnk-warn", !ready);
    }
    if (replies) replies.checked = includeReplies;

    const running = status === "running";
    if (processBtn) {
      processBtn.disabled = running;
      processBtn.textContent = running ? "Memproses…" : "Proses";
    }
    if (stopBtn) stopBtn.hidden = !running;
    if (copyBtn) {
      copyBtn.disabled = names.length === 0;
      copyBtn.textContent = names.length ? `Copy nama (${names.length})` : "Copy nama";
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
    if (stopReason === "no_login") return "error";
    if (stopReason === "error") return "error";
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
      // Default visibility = expanded saat ada hasil (sama dengan TT/IG) —
      // run dari popup/shortcut ikut menampilkan hasilnya di panel.
      if (list.length > 0 && !userCollapsed && ui) {
        ui.classList.remove("fnk-collapsed");
      }
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
    // Default visibility: expanded saat ada hasil tersimpan (sama dengan
    // TikTok/Instagram) — pulihkan hasil lintas reload & buka panel.
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
        if (ui) {
          ui.classList.remove("fnk-collapsed");
          userCollapsed = false;
        }
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
