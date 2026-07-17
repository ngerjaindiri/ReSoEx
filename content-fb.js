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

  function mergeNames(list) {
    const map = new Map();
    const blocked =
      /^(view|see|like|likes|reply|share|comment|facebook|meta|suka|balas|bagikan|komentar|lihat|semua|edited|photo|video|reels?)$/i;
    for (const n of list || []) {
      if (typeof n !== "string") continue;
      let k = n
        .replace(/\u200b|\u200c|\u200d|\ufeff/g, "")
        .replace(/\s+/g, " ")
        .trim();
      k = k
        .replace(/\s+[·•|].*$/, "")
        .replace(/\s+\d+\s*(d|h|m|w|jam|menit|hari)\b.*$/i, "")
        .trim();
      if (k.length < 2 || k.length > 100) continue;
      if (/^\d+$/.test(k) || /^@/.test(k) || /https?:\/\//i.test(k)) continue;
      if (blocked.test(k)) continue;
      map.set(k.toLowerCase(), k);
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
        message: list.length
          ? `Dihentikan — ${list.length} nama. Klik Copy.`
          : "Dihentikan — belum ada nama.",
      });
      sendBg("NAMES_DONE", {
        names: list,
        stopReason: "stopped",
        runId: stopRunId,
        postHint,
      });
    }, 2800);
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
        setLocalState({ message: "Gagal copy. Coba lewat ikon extension." });
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
    // Panel starts collapsed — control utama = ikon di bar Like/Comment/Share
    root.classList.add("fnk-collapsed");
    root.innerHTML = `
      <div class="fnk-panel" role="region" aria-label="FB Nama Komentar">
        <div class="fnk-header">
          <span class="fnk-logo">N</span>
          <span class="fnk-title">Nama Komentar</span>
          <button type="button" class="fnk-min" title="Tutup" data-fnk="min">×</button>
        </div>
        <div class="fnk-body">
          <div class="fnk-status" data-fnk="status"></div>
          <div class="fnk-hint" data-fnk="hint"></div>
          <div class="fnk-count" data-fnk="count"></div>
          <label class="fnk-check">
            <input type="checkbox" data-fnk="replies" checked />
            Sertakan balasan
          </label>
          <div class="fnk-actions">
            <button type="button" class="fnk-btn fnk-primary" data-fnk="process">Proses</button>
            <button type="button" class="fnk-btn" data-fnk="stop" hidden>Stop</button>
            <button type="button" class="fnk-btn fnk-success" data-fnk="copy" disabled>Copy nama</button>
          </div>
        </div>
      </div>
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
      if (act === "min") root.classList.add("fnk-collapsed");
    });
    root.addEventListener("change", (e) => {
      const t = e.target;
      if (t && t.getAttribute?.("data-fnk") === "replies") {
        includeReplies = !!t.checked;
      }
    });

    ensureActionIcon();
    return root;
  }

  /** Small icon-only control near Like / Comment / Share */
  function ensureActionIcon() {
    if (document.getElementById("fnk-inline")) return;
    const chip = document.createElement("div");
    chip.id = "fnk-inline";
    chip.className = "fnk-inline-hidden";
    chip.innerHTML = `
      <button type="button" class="fnk-action-icon" data-fnk-inline="main"
        title="Ambil nama komentar (klik lagi untuk copy)"
        aria-label="Ambil nama komentar">
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
      markPostFromEl(chip);
      const running = status === "running";
      if (running) {
        stopExtract();
        return;
      }
      // Done with names → copy; else start extract
      if (
        names.length > 0 &&
        (status === "done" || status === "partial" || status === "stopped")
      ) {
        copyNames();
        if (ui) {
          ui.classList.remove("fnk-collapsed");
        }
        return;
      }
      // Open tiny panel for progress feedback, then process
      if (ui) ui.classList.remove("fnk-collapsed");
      startExtract();
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

  function renderUi() {
    if (!ui) createUi();
    const statusEl = ui.querySelector('[data-fnk="status"]');
    const hintEl = ui.querySelector('[data-fnk="hint"]');
    const countEl = ui.querySelector('[data-fnk="count"]');
    const processBtn = ui.querySelector('[data-fnk="process"]');
    const stopBtn = ui.querySelector('[data-fnk="stop"]');
    const copyBtn = ui.querySelector('[data-fnk="copy"]');
    const replies = ui.querySelector('[data-fnk="replies"]');

    if (statusEl) statusEl.textContent = message;
    if (hintEl) {
      hintEl.textContent = postHint
        ? `Target: ${postHint}`
        : "Ikon N di bar Like · klik = proses · klik lagi = copy";
    }
    if (countEl) countEl.textContent = names.length ? `${names.length} nama` : "0 nama";
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

    // Action-bar icon state
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
          btn.title = "Stop ambil nama";
          btn.setAttribute("aria-label", "Stop ambil nama");
        } else if (names.length > 0) {
          btn.title = `Copy ${names.length} nama (klik kanan: panel)`;
          btn.setAttribute("aria-label", `Copy ${names.length} nama`);
        } else {
          btn.title = "Ambil nama komentar";
          btn.setAttribute("aria-label", "Ambil nama komentar");
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
  }

  function placeUi() {
    createUi();
    placeInlineBar();
    renderUi();
  }

  function mapDoneStatus(stopReason, count) {
    if (stopReason === "stopped") return "stopped";
    if (stopReason === "timeout") return "partial";
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
      const localMsg = (() => {
        const c = list.length;
        if (stopReason === "stopped")
          return c
            ? `Dihentikan — ${c} nama. Klik Copy.`
            : "Dihentikan — belum ada nama.";
        if (stopReason === "timeout")
          return c
            ? `Waktu habis — ${c} nama (mungkin belum semua). Klik Copy.`
            : "Waktu habis — belum ada nama.";
        if (stopReason === "complete" || stopReason === "idle")
          return c
            ? `Selesai — ${c} nama. Klik Copy.`
            : "Tidak ada nama. Buka permalink, buka komentar sampai list kelihatan, tunggu 2–3 dtk, Proses lagi.";
        return c ? `${c} nama` : "Selesai.";
      })();
      const mode =
        data.postHint && !/Tip:/i.test(data.postHint)
          ? ` [${String(data.postHint).split(" ")[0]}]`
          : "";
      const finalMsg =
        !list.length && data.postHint && /Tip:/i.test(data.postHint)
          ? `Tidak ada nama. ${data.postHint.replace(/^[\s\S]*?Tip:/i, "Tip:")}`
          : localMsg + (list.length ? mode : "");
      setLocalState({
        status: st,
        names: list,
        message: finalMsg,
        postHint:
          typeof data.postHint === "string" ? data.postHint : postHint,
      });
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
    sendBg("INJECT_MAIN").then(() => engineCmd("PING")).then((r) => {
      if (r?.ok) engineReady = true;
    });

    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) {
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
      if (!document.getElementById(ROOT_ID)) placeUi();
      else placeInlineBar();
    }, 1600);
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
