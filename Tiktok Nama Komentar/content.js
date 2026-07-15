/**
 * Content script — UI + bridge for TikTok Nama Komentar
 */
(function () {
  if (window.__TNK_CONTENT__) return;
  window.__TNK_CONTENT__ = true;

  const INJECT_SOURCE = "tt-nama-komentar-inject";
  const CONTENT_SOURCE = "tt-nama-komentar-content";
  const ROOT_ID = "tnk-root";

  let ui = null;
  let status = "idle";
  let names = [];
  let message = "Buka video, buka komentar, lalu Proses.";
  let videoHint = "";
  let includeReplies = false;
  let hasTemplate = false;
  let engineReady = false;
  let readyWaiter = null;
  let currentRunId = null;
  let stopFinalizeTimer = null;

  function sendBg(type, payload = {}) {
    try {
      return chrome.runtime.sendMessage({ type, ...payload }).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  }

  function postToInject(type, extra = {}) {
    window.postMessage({ source: CONTENT_SOURCE, type, ...extra }, "*");
  }

  async function waitEngineReady(timeoutMs = 5000) {
    if (engineReady) return true;
    return new Promise(async (resolve) => {
      const timer = setTimeout(() => {
        readyWaiter = null;
        resolve(false);
      }, timeoutMs);
      readyWaiter = () => {
        clearTimeout(timer);
        readyWaiter = null;
        resolve(true);
      };
      await sendBg("INJECT_MAIN");
      postToInject("PING_ENGINE");
      let n = 0;
      const iv = setInterval(() => {
        n++;
        postToInject("PING_ENGINE");
        sendBg("INJECT_MAIN");
        if (n >= 10 || engineReady) clearInterval(iv);
      }, 200);
    });
  }

  function mergeNames(list) {
    const map = new Map();
    for (const n of list || []) {
      if (typeof n !== "string") continue;
      let k = n.replace(/\u200b|\u200c|\u200d|\ufeff/g, "").replace(/\s+/g, " ").trim();
      if (k.startsWith("@") && !k.includes(" ")) k = k.slice(1);
      if (k.length >= 1) map.set(k.toLowerCase(), k);
    }
    return [...map.values()];
  }

  function setLocal(patch) {
    if (patch.status) status = patch.status;
    if (patch.names) names = mergeNames(patch.names);
    if (patch.message != null) message = patch.message;
    if (patch.videoHint != null) videoHint = patch.videoHint;
    if (typeof patch.includeReplies === "boolean") includeReplies = patch.includeReplies;
    if (typeof patch.hasTemplate === "boolean") hasTemplate = patch.hasTemplate;
    render();
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

  async function startExtract(opts = {}) {
    if (stopFinalizeTimer) {
      clearTimeout(stopFinalizeTimer);
      stopFinalizeTimer = null;
    }
    currentRunId = opts.runId || makeRunId();
    setLocal({ status: "running", names: [], message: "Menyiapkan…" });
    await sendBg("SET_STATE", {
      patch: {
        status: "running",
        names: [],
        count: 0,
        message: "Menyiapkan…",
        includeReplies,
        runId: currentRunId,
      },
    });

    await waitEngineReady(5000);
    const templateUrl =
      opts.templateUrl || (await refreshTemplateFlag()) || null;

    if (!templateUrl) {
      setLocal({
        message:
          "Mencoba buka komentar… jika gagal, klik ikon komentar manual dulu.",
      });
    } else {
      postToInject("SET_TEMPLATE", { templateUrl });
    }

    postToInject("START", {
      options: {
        maxMs: 120_000,
        includeReplies,
        awemeId: opts.awemeId || null,
        templateUrl,
        runId: currentRunId,
      },
    });
  }

  function stopExtract() {
    postToInject("STOP");
    setLocal({ status: "running", message: "Menghentikan…" });
    if (stopFinalizeTimer) clearTimeout(stopFinalizeTimer);
    stopFinalizeTimer = setTimeout(() => {
      if (status !== "running") return;
      const list = names.slice();
      setLocal({
        status: list.length ? "stopped" : "error",
        message: list.length
          ? `Dihentikan — ${list.length} nama. Klik Copy.`
          : "Dihentikan — belum ada nama.",
      });
      sendBg("NAMES_DONE", {
        names: list,
        stopReason: "stopped",
        runId: currentRunId,
        videoHint,
      });
    }, 2800);
  }

  async function copyNames() {
    const text = names.join("\n");
    if (!text) {
      setLocal({ message: "Belum ada nama untuk disalin." });
      return false;
    }
    try {
      await navigator.clipboard.writeText(text);
      setLocal({
        message: `Tersalin ${names.length} nama. Paste di Excel (Ctrl+V).`,
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
        setLocal({ message: `Tersalin ${names.length} nama. Paste di Excel.` });
        return true;
      } catch {
        setLocal({ message: "Gagal copy. Coba lewat ikon extension." });
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
    root.innerHTML = `
      <div class="tnk-panel">
        <div class="tnk-header">
          <span class="tnk-logo">T</span>
          <span class="tnk-title">Nama Komentar</span>
          <button type="button" class="tnk-min" data-tnk="min">–</button>
        </div>
        <div class="tnk-body">
          <div class="tnk-status" data-tnk="status"></div>
          <div class="tnk-hint" data-tnk="hint"></div>
          <div class="tnk-count" data-tnk="count">0 nama</div>
          <div class="tnk-badge" data-tnk="badge"></div>
          <label class="tnk-check">
            <input type="checkbox" data-tnk="replies" />
            Sertakan balasan (reply)
          </label>
          <div class="tnk-actions">
            <button type="button" class="tnk-btn tnk-primary" data-tnk="process">Proses</button>
            <button type="button" class="tnk-btn" data-tnk="stop" hidden>Stop</button>
            <button type="button" class="tnk-btn tnk-success" data-tnk="copy" disabled>Copy nama</button>
          </div>
        </div>
      </div>
      <button type="button" class="tnk-fab" data-tnk="fab" data-count="">T</button>
    `;
    (document.body || document.documentElement).appendChild(root);
    ui = root;

    root.addEventListener("click", (e) => {
      const t = e.target.closest("[data-tnk]");
      if (!t) return;
      const act = t.getAttribute("data-tnk");
      if (act === "process") startExtract();
      if (act === "stop") stopExtract();
      if (act === "copy") copyNames();
      if (act === "min") root.classList.add("tnk-collapsed");
      if (act === "fab") root.classList.remove("tnk-collapsed");
    });
    root.addEventListener("change", (e) => {
      if (e.target?.getAttribute?.("data-tnk") === "replies") {
        includeReplies = !!e.target.checked;
      }
    });
    return root;
  }

  function render() {
    if (!ui) createUi();
    const statusEl = ui.querySelector('[data-tnk="status"]');
    const hintEl = ui.querySelector('[data-tnk="hint"]');
    const countEl = ui.querySelector('[data-tnk="count"]');
    const badgeEl = ui.querySelector('[data-tnk="badge"]');
    const processBtn = ui.querySelector('[data-tnk="process"]');
    const stopBtn = ui.querySelector('[data-tnk="stop"]');
    const copyBtn = ui.querySelector('[data-tnk="copy"]');
    const fab = ui.querySelector('[data-tnk="fab"]');
    const replies = ui.querySelector('[data-tnk="replies"]');

    if (statusEl) statusEl.textContent = message;
    if (hintEl)
      hintEl.textContent = videoHint
        ? `Video: ${videoHint}`
        : "Buka URL /@user/video/...";
    if (countEl) countEl.textContent = names.length ? `${names.length} nama` : "0 nama";
    if (badgeEl) {
      badgeEl.textContent = hasTemplate
        ? "API komentar: siap"
        : "API komentar: belum — buka panel komentar";
      badgeEl.classList.toggle("tnk-ok", hasTemplate);
      badgeEl.classList.toggle("tnk-warn", !hasTemplate);
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
    if (fab) {
      fab.setAttribute("data-count", names.length > 0 ? String(names.length) : "");
      fab.classList.toggle("tnk-running", running);
      fab.classList.toggle(
        "tnk-done",
        (status === "done" || status === "partial" || status === "stopped") &&
          names.length > 0
      );
    }
  }

  function mapDone(stopReason, count) {
    if (stopReason === "stopped") return "stopped";
    if (stopReason === "timeout") return "partial";
    if (
      stopReason === "error" ||
      stopReason === "no_template" ||
      stopReason === "no_video"
    )
      return "error";
    return count ? "done" : "error";
  }

  function localDoneMessage(stopReason, count) {
    if (stopReason === "stopped")
      return count
        ? `Dihentikan — ${count} nama. Klik Copy.`
        : "Dihentikan — belum ada nama.";
    if (stopReason === "timeout")
      return count
        ? `Waktu habis — ${count} nama (mungkin belum semua).`
        : "Waktu habis — belum ada nama.";
    if (stopReason === "no_template")
      return "Belum ada template API. Buka panel komentar dulu, tunggu list muncul, Proses lagi.";
    if (stopReason === "no_video")
      return "Buka halaman video TikTok (/video/...), bukan For You saja.";
    if (stopReason === "complete" || stopReason === "idle")
      return count
        ? `Selesai — ${count} nama. Klik Copy.`
        : "Tidak ada nama. Pastikan komentar terbuka.";
    return count ? `${count} nama` : "Selesai.";
  }

  function isCurrentRun(runId) {
    if (!runId || !currentRunId) return true;
    return runId === currentRunId;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== INJECT_SOURCE) return;

    if (data.type === "READY") {
      engineReady = true;
      if (readyWaiter) readyWaiter();
    }
    if (data.type === "NEED_TEMPLATE") {
      refreshTemplateFlag().then((url) => {
        if (url) postToInject("SET_TEMPLATE", { templateUrl: url });
      });
    }
    if (data.type === "PROGRESS") {
      if (!isCurrentRun(data.runId)) return;
      setLocal({
        status: "running",
        names: data.names || [],
        message: data.message || `Mengumpulkan… ${(data.names || []).length}`,
        videoHint: data.videoHint || videoHint,
      });
      sendBg("NAMES_PROGRESS", {
        names: data.names || [],
        message: data.message,
        videoHint: data.videoHint,
        runId: currentRunId,
      });
    }
    if (data.type === "DONE") {
      if (!isCurrentRun(data.runId)) return;
      if (stopFinalizeTimer) {
        clearTimeout(stopFinalizeTimer);
        stopFinalizeTimer = null;
      }
      const list = data.names || [];
      const stopReason = data.stopReason || "complete";
      setLocal({
        status: mapDone(stopReason, list.length),
        names: list,
        message: localDoneMessage(stopReason, list.length),
        videoHint: data.videoHint || videoHint,
      });
      sendBg("NAMES_DONE", {
        names: list,
        stopReason,
        videoHint: data.videoHint,
        runId: currentRunId,
      });
    }
    if (data.type === "ERROR") {
      if (!isCurrentRun(data.runId)) return;
      if (stopFinalizeTimer) {
        clearTimeout(stopFinalizeTimer);
        stopFinalizeTimer = null;
      }
      setLocal({
        status: "error",
        message: data.message || "Error",
      });
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
        awemeId: msg.awemeId,
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
      sendResponse({ ok: true, status, names, message, videoHint, hasTemplate });
      return;
    }
  });

  // Template may arrive while browsing — refresh badge
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.tnk_comment_url) {
      hasTemplate = !!changes.tnk_comment_url.newValue;
      render();
    }
  });

  function boot() {
    createUi();
    render();
    refreshTemplateFlag();
    sendBg("INJECT_MAIN").then(() => postToInject("PING_ENGINE"));

    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        engineReady = false;
        if (stopFinalizeTimer) {
          clearTimeout(stopFinalizeTimer);
          stopFinalizeTimer = null;
        }
        postToInject("STOP");
        currentRunId = null;
        setLocal({
          status: "idle",
          names: [],
          message: "Halaman berubah. Buka komentar video ini, lalu Proses.",
          videoHint: "",
        });
        sendBg("SET_STATE", {
          patch: {
            status: "idle",
            names: [],
            count: 0,
            message: "Halaman berubah. Buka komentar video ini, lalu Proses.",
            stopReason: null,
            videoHint: "",
            runId: null,
          },
        });
        sendBg("INJECT_MAIN");
        refreshTemplateFlag();
      }
      if (!document.getElementById(ROOT_ID)) {
        createUi();
        render();
      }
    }, 1600);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
