/**
 * Background service worker — Nama Komentar (FB + TikTok unified)
 * Routes messages based on detected platform.
 */
import {
  STORAGE_KEY_FB,
  STORAGE_KEY_TT,
  URL_TEMPLATE_KEY,
  URL_META_KEY,
  defaultStateFor,
  applyStatePatch,
  mergeNames,
  reasonToMessage,
  isFacebookUrl,
  isTikTokUrl,
  detectPlatform,
  extractAwemeId,
  newRunId,
  isStaleRun,
  storageKeyFor,
  sanitizeTikTokTemplateUrl,
  isTikTokTemplateValid,
} from "./shared.js";

// ===================== State Helpers =====================

async function getState(platform) {
  const key = storageKeyFor(platform);
  const data = await chrome.storage.session.get(key);
  return { ...defaultStateFor(platform), ...(data[key] || {}) };
}

async function setState(platform, patch) {
  const key = storageKeyFor(platform);
  const prev = await getState(platform);
  const next = applyStatePatch(prev, patch, platform);

  // TikTok: enrich with template flag (session + TTL)
  if (platform === "tiktok") {
    const { url, meta } = await getTemplate();
    next.hasTemplate = isTikTokTemplateValid(url, meta);
  }

  await chrome.storage.session.set({ [key]: next });
  return next;
}

/**
 * TikTok comment API template — session storage, TTL, optional aweme filter.
 * @param {string|null} [requiredAwemeId] when set, require meta.awemeId match
 */
async function getTemplate(requiredAwemeId = null) {
  const data = await chrome.storage.session.get([
    URL_TEMPLATE_KEY,
    URL_META_KEY,
  ]);
  const url = data[URL_TEMPLATE_KEY] || null;
  const meta = data[URL_META_KEY] || null;

  // Drop expired / malformed templates from session
  if (url && !isTikTokTemplateValid(url, meta, null)) {
    try {
      await chrome.storage.session.remove([URL_TEMPLATE_KEY, URL_META_KEY]);
    } catch {
      /* ignore */
    }
    return { url: null, meta: null };
  }

  if (!isTikTokTemplateValid(url, meta, requiredAwemeId)) {
    return { url: null, meta };
  }

  return { url, meta };
}

/**
 * Template usable as URL shape for replay (rewrite aweme_id), even if captured
 * on another video — still requires TTL + comment/list URL.
 */
async function getReplayTemplate(awemeId = null) {
  const data = await chrome.storage.session.get([
    URL_TEMPLATE_KEY,
    URL_META_KEY,
  ]);
  const url = data[URL_TEMPLATE_KEY] || null;
  const meta = data[URL_META_KEY] || null;
  if (!isTikTokTemplateValid(url, meta, null)) {
    if (url) {
      try {
        await chrome.storage.session.remove([URL_TEMPLATE_KEY, URL_META_KEY]);
      } catch {
        /* ignore */
      }
    }
    return { url: null, meta: null };
  }
  // Prefer same-video template when available; otherwise allow structure reuse
  if (
    awemeId &&
    meta?.awemeId &&
    String(meta.awemeId) === String(awemeId)
  ) {
    return { url, meta, sameVideo: true };
  }
  return { url, meta, sameVideo: !meta?.awemeId };
}

// ===================== Injection Helpers =====================

/** Install MAIN-world extract engine (idempotent). */
async function injectMain(tabId, platform) {
  const file = platform === "tiktok" ? "inject-tiktok.js" : "inject-fb.js";
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: "MAIN",
      injectImmediately: true,
      files: [file],
    });
    return true;
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        world: "MAIN",
        files: [file],
      });
      return true;
    } catch (err) {
      console.warn("injectMain failed", err);
      return false;
    }
  }
}

/**
 * Sanitize START options before crossing into MAIN world.
 */
function sanitizeEngineOptions(cmd, options, platform) {
  const raw = options && typeof options === "object" ? options : {};
  if (cmd === "SET_TEMPLATE") {
    const url =
      typeof raw.templateUrl === "string" ? raw.templateUrl.slice(0, 4000) : null;
    if (
      url &&
      (!url.toLowerCase().includes("tiktok.com/api/comment/list") ||
        url.toLowerCase().includes("/list/reply"))
    ) {
      return { templateUrl: null };
    }
    return { templateUrl: url };
  }
  if (cmd !== "START") return {};

  const maxMs = Number(raw.maxMs);
  const out = {
    maxMs: Number.isFinite(maxMs)
      ? Math.min(180_000, Math.max(8_000, maxMs))
      : platform === "tiktok"
        ? 120_000
        : 150_000,
    includeReplies:
      platform === "tiktok" ? raw.includeReplies === true : raw.includeReplies !== false,
    runId:
      typeof raw.runId === "string" && raw.runId.length <= 80
        ? raw.runId
        : null,
  };
  if (platform === "tiktok") {
    const aweme =
      raw.awemeId != null ? String(raw.awemeId).replace(/\D/g, "").slice(0, 32) : "";
    out.awemeId = aweme || null;
    const url =
      typeof raw.templateUrl === "string" ? raw.templateUrl.slice(0, 4000) : null;
    out.templateUrl =
      url &&
      url.toLowerCase().includes("tiktok.com/api/comment/list") &&
      !url.toLowerCase().includes("/list/reply")
        ? url
        : null;
  }
  return out;
}

/**
 * Control plane: call non-enumerable engine API in MAIN world.
 * Avoids spoofable window.postMessage START/STOP.
 */
async function engineCmd(tabId, platform, cmd, options = {}) {
  await injectMain(tabId, platform);
  const safeOpts = sanitizeEngineOptions(cmd, options, platform);
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: "MAIN",
      func: (plat, command, opts) => {
        const key = plat === "tiktok" ? "__RESO_TNK__" : "__RESO_FNK__";
        const eng = window[key];
        if (!eng) return { ok: false, error: "no_engine" };
        if (command === "PING") {
          return typeof eng.ping === "function"
            ? eng.ping()
            : { ok: true, version: eng.version || 1 };
        }
        if (command === "START") {
          eng.start(opts || {});
          return { ok: true };
        }
        if (command === "STOP") {
          eng.stop();
          return { ok: true };
        }
        if (command === "SET_TEMPLATE") {
          if (typeof eng.setTemplate === "function") {
            eng.setTemplate(opts?.templateUrl || null);
          }
          return { ok: true };
        }
        return { ok: false, error: "unknown_cmd" };
      },
      args: [platform, cmd, safeOpts],
    });
    return result || { ok: false, error: "no_result" };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

async function ensureContent(tabId, platform) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return true;
  } catch {
    const jsFile =
      platform === "tiktok" ? "content-tiktok.js" : "content-fb.js";
    const cssFile =
      platform === "tiktok" ? "content-tiktok.css" : "content-fb.css";
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [jsFile],
      });
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: [cssFile],
      });
      return true;
    } catch (err) {
      console.warn("ensureContent failed", err);
      return false;
    }
  }
}

// ===================== Status Helper =====================

function statusFromReason(reason, count) {
  if (reason === "stopped") return "stopped";
  if (reason === "timeout") return "partial";
  if (
    reason === "error" ||
    reason === "no_template" ||
    reason === "no_video"
  )
    return "error";
  if (reason === "complete" || reason === "idle")
    return count > 0 ? "done" : "error";
  return count > 0 ? "done" : "error";
}

// ===================== TikTok webRequest Capture =====================

function isCommentListUrl(url) {
  if (!url) return false;
  const u = url.toLowerCase();
  if (!u.includes("tiktok.com/api/comment/list")) return false;
  if (u.includes("tiktok.com/api/comment/list/reply")) return false;
  return true;
}

// Observational only — capture URL shape, no headers needed
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!isCommentListUrl(details.url)) return;
    const clean = sanitizeTikTokTemplateUrl(details.url);
    if (!clean) return;

    const awemeId =
      extractAwemeId(clean) ||
      (() => {
        try {
          return new URL(clean).searchParams.get("aweme_id");
        } catch {
          return null;
        }
      })();

    (async () => {
      try {
        // Prefer not clobbering a good same-video template mid-extract with noise
        const st = await getState("tiktok");
        const prev = await chrome.storage.session.get([
          URL_TEMPLATE_KEY,
          URL_META_KEY,
        ]);
        const prevMeta = prev[URL_META_KEY] || null;
        const prevUrl = prev[URL_TEMPLATE_KEY] || null;
        const prevValid = isTikTokTemplateValid(prevUrl, prevMeta, null);
        if (
          st.status === "running" &&
          prevValid &&
          st.videoHint &&
          prevMeta?.awemeId &&
          String(prevMeta.awemeId) === String(st.videoHint) &&
          awemeId &&
          String(awemeId) !== String(st.videoHint)
        ) {
          return;
        }

        await chrome.storage.session.set({
          [URL_TEMPLATE_KEY]: clean,
          [URL_META_KEY]: {
            capturedAt: Date.now(),
            awemeId,
            tabId: details.tabId,
          },
        });

        if (st.status === "running") {
          await setState("tiktok", { hasTemplate: true });
        } else {
          await setState("tiktok", {
            hasTemplate: true,
            message:
              "Template API komentar siap. Klik Proses untuk ambil nama.",
          });
        }
      } catch {
        /* ignore */
      }
    })();
  },
  { urls: ["*://*.tiktok.com/*"] }
);

// ===================== Tab Injection on Navigation =====================

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.session.set({
    [STORAGE_KEY_FB]: { ...defaultStateFor("facebook") },
    [STORAGE_KEY_TT]: { ...defaultStateFor("tiktok") },
  });
  // Drop legacy local template keys from pre-Sprint-A builds
  try {
    await chrome.storage.local.remove([URL_TEMPLATE_KEY, URL_META_KEY]);
  } catch {
    /* ignore */
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const url = tab?.url;
  if (!url) return;

  if (isFacebookUrl(url)) {
    // Inject early so GraphQL buffer captures comments
    if (changeInfo.status === "loading" || changeInfo.status === "complete") {
      await injectMain(tabId, "facebook");
    }
  } else if (isTikTokUrl(url)) {
    if (changeInfo.status === "complete") {
      await injectMain(tabId, "tiktok");
    }
  }
});

// ===================== Message Router =====================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then(sendResponse)
    .catch((err) =>
      sendResponse({ ok: false, error: String(err?.message || err) })
    );
  return true;
});

async function handleMessage(msg, sender) {
  if (!msg || !msg.type) return { ok: false, error: "Invalid message" };

  // Prefer platform from the sending tab (content script); never trust alone for engine cmds
  let platform = null;
  if (sender.tab?.url) {
    platform = detectPlatform(sender.tab.url);
  }
  if (!platform && msg.platform) {
    platform = msg.platform === "tiktok" || msg.platform === "facebook"
      ? msg.platform
      : null;
  }

  switch (msg.type) {
    // ---- Generic messages ----

    case "GET_STATE": {
      // For popup: detect from active tab
      if (!platform) {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        platform = detectPlatform(tab?.url);
      }
      if (!platform) {
        return { ok: true, state: null, platform: null };
      }
      const state = await getState(platform);
      if (platform === "tiktok") {
        let aweme = msg.awemeId || null;
        if (!aweme && sender.tab?.url) aweme = extractAwemeId(sender.tab.url);
        if (!aweme) {
          const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });
          aweme = extractAwemeId(tab?.url);
        }
        const replay = await getReplayTemplate(aweme);
        state.hasTemplate = !!replay.url;
      }
      return { ok: true, state, platform };
    }

    case "GET_TEMPLATE": {
      const awemeId = msg.awemeId || null;
      // Prefer same-video; fall back to replayable structure within TTL
      const strict = await getTemplate(awemeId);
      if (strict.url) return { ok: true, ...strict, sameVideo: true };
      const replay = await getReplayTemplate(awemeId);
      return {
        ok: true,
        url: replay.url,
        meta: replay.meta,
        sameVideo: !!replay.sameVideo,
      };
    }

    case "SET_STATE": {
      if (!platform) {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        platform = detectPlatform(tab?.url);
      }
      if (!platform) {
        return { ok: false, error: "No supported platform" };
      }
      // Whitelist patch fields (prevent arbitrary state injection)
      const raw = msg.patch && typeof msg.patch === "object" ? msg.patch : {};
      const patch = {};
      const allow = [
        "status",
        "names",
        "count",
        "message",
        "stopReason",
        "includeReplies",
        "runId",
        "postHint",
        "videoHint",
        "hasTemplate",
      ];
      for (const k of allow) {
        if (k in raw) patch[k] = raw[k];
      }
      // Never trust client-supplied tabId — stamp from content sender when present
      if (sender.tab?.id) {
        patch.tabId = sender.tab.id;
      }
      const allowedStatus = new Set([
        "idle",
        "running",
        "done",
        "partial",
        "stopped",
        "error",
      ]);
      if (patch.status != null && !allowedStatus.has(patch.status)) {
        delete patch.status;
      }
      if (Array.isArray(patch.names)) {
        patch.names = patch.names
          .filter((n) => typeof n === "string")
          .slice(0, 5000);
      }
      if (typeof patch.message === "string") {
        patch.message = patch.message.slice(0, 500);
      }
      if (typeof patch.runId === "string") {
        patch.runId = patch.runId.slice(0, 80);
      } else if ("runId" in patch && patch.runId != null) {
        delete patch.runId;
      }

      // Prevent tab B from silently hijacking an in-flight run on tab A
      if (patch.status === "running" && sender.tab?.id) {
        const prev = await getState(platform);
        if (
          prev.status === "running" &&
          prev.tabId &&
          prev.tabId !== sender.tab.id
        ) {
          return {
            ok: false,
            error: "Run active on another tab",
            state: prev,
          };
        }
      }

      return {
        ok: true,
        state: await setState(platform, patch),
      };
    }

    case "RESET": {
      if (!platform) {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        platform = detectPlatform(tab?.url);
      }
      if (!platform) {
        return { ok: false, error: "No supported platform", state: null };
      }
      const p = platform;
      const prev = await getState(p);
      if (prev.status === "running") {
        await stopActiveRun(p);
      } else if (prev.tabId) {
        try {
          await chrome.tabs.sendMessage(prev.tabId, {
            type: "STOP_EXTRACT",
            runId: prev.runId,
          });
        } catch {
          /* ignore */
        }
        try {
          await engineCmd(prev.tabId, p, "STOP", {});
        } catch {
          /* ignore */
        }
      }
      const resetPatch =
        p === "tiktok"
          ? {
              status: "idle",
              names: [],
              count: 0,
              message:
                "Buka video TikTok, buka panel komentar, lalu klik Proses.",
              tabId: null,
              stopReason: null,
              videoHint: "",
              runId: null,
            }
          : {
              status: "idle",
              names: [],
              count: 0,
              message: "Buka 1 postingan Facebook, lalu klik Proses.",
              tabId: null,
              stopReason: null,
              postHint: "",
              runId: null,
            };
      const state = await setState(p, resetPatch);
      return { ok: true, state };
    }

    case "INJECT_MAIN": {
      // Only inject into the content script's own tab (ignore foreign tabId)
      const tabId = sender.tab?.id;
      if (!tabId) return { ok: false, error: "INJECT_MAIN requires content tab" };
      if (!platform) {
        try {
          const tab = await chrome.tabs.get(tabId);
          platform = detectPlatform(tab?.url);
        } catch {
          platform = null;
        }
      }
      if (!platform) return { ok: false, error: "Unsupported platform" };
      return { ok: await injectMain(tabId, platform) };
    }

    case "ENGINE_CMD": {
      // Only content scripts (have sender.tab on FB/TT) may drive the engine
      const tabId = sender.tab?.id;
      if (!tabId || !platform) {
        return { ok: false, error: "ENGINE_CMD requires content tab" };
      }
      const cmd = msg.cmd;
      if (!["PING", "START", "STOP", "SET_TEMPLATE"].includes(cmd)) {
        return { ok: false, error: "Invalid engine cmd" };
      }
      if (cmd === "START") {
        const st = await getState(platform);
        const runId = msg.options?.runId;
        // One active extract per platform globally
        if (st.status === "running") {
          if (st.tabId && st.tabId !== tabId) {
            return {
              ok: false,
              error: "Run active on another tab — stop it first",
            };
          }
          if (st.runId && runId && st.runId !== runId) {
            return { ok: false, error: "Another run is active" };
          }
        }
        // START must carry a runId so progress can be correlated
        if (typeof runId !== "string" || !runId) {
          return { ok: false, error: "START requires runId" };
        }
      }
      const options =
        msg.options && typeof msg.options === "object" ? msg.options : {};
      return await engineCmd(tabId, platform, cmd, options);
    }

    // ---- Progress / Done / Error (content scripts only) ----

    case "NAMES_PROGRESS": {
      if (!sender.tab?.id || !platform) {
        return { ok: false, error: "NAMES_* requires content tab" };
      }
      const p = platform;
      const prev = await getState(p);
      if (prev.status !== "running") {
        return { ok: true, state: prev, ignored: true };
      }
      if (isStaleRun(prev.runId, msg.runId)) {
        return { ok: true, state: prev, stale: true };
      }
      // Only accept updates from the tab that owns the run
      if (prev.tabId && prev.tabId !== sender.tab.id) {
        return { ok: true, state: prev, ignored: true };
      }
      const incoming = Array.isArray(msg.names) ? msg.names : [];
      const names =
        incoming.length >= (prev.names?.length || 0)
          ? mergeNames([], incoming, p)
          : mergeNames(prev.names, incoming, p);
      const patchObj = {
        status: "running",
        names,
        message:
          typeof msg.message === "string"
            ? msg.message.slice(0, 300)
            : `Mengumpulkan… ${names.length} nama`,
        tabId: sender.tab.id,
        runId: prev.runId,
      };
      if (p === "tiktok") {
        patchObj.videoHint = msg.videoHint ?? prev.videoHint;
      } else {
        patchObj.postHint = msg.postHint ?? prev.postHint;
      }
      return { ok: true, state: await setState(p, patchObj) };
    }

    case "NAMES_DONE": {
      if (!sender.tab?.id || !platform) {
        return { ok: false, error: "NAMES_* requires content tab" };
      }
      const p = platform;
      const prev = await getState(p);
      if (isStaleRun(prev.runId, msg.runId)) {
        return { ok: true, state: prev, stale: true };
      }
      // Only accept terminal events while a run is in flight (or stop race)
      if (prev.status !== "running") {
        return { ok: true, state: prev, ignored: true };
      }
      if (prev.tabId && prev.tabId !== sender.tab.id) {
        return { ok: true, state: prev, ignored: true };
      }
      const names = mergeNames(
        [],
        Array.isArray(msg.names) ? msg.names : prev.names || [],
        p
      );
      const stopReason = msg.stopReason || "complete";
      const status = statusFromReason(stopReason, names.length);
      const patchObj = {
        status,
        names,
        stopReason,
        message: reasonToMessage(
          stopReason,
          names.length,
          p,
          typeof msg.extra === "string" ? msg.extra.slice(0, 200) : ""
        ),
        tabId: sender.tab.id,
        runId: prev.runId,
      };
      if (p === "tiktok") {
        patchObj.videoHint = msg.videoHint ?? prev.videoHint;
      } else {
        patchObj.postHint = msg.postHint ?? prev.postHint;
      }
      return { ok: true, state: await setState(p, patchObj) };
    }

    case "NAMES_ERROR": {
      if (!sender.tab?.id || !platform) {
        return { ok: false, error: "NAMES_* requires content tab" };
      }
      const p = platform;
      const prev = await getState(p);
      if (prev.status !== "running") {
        return { ok: true, state: prev, ignored: true };
      }
      if (isStaleRun(prev.runId, msg.runId)) {
        return { ok: true, state: prev, stale: true };
      }
      if (prev.tabId && prev.tabId !== sender.tab.id) {
        return { ok: true, state: prev, ignored: true };
      }
      return {
        ok: true,
        state: await setState(p, {
          status: "error",
          stopReason: "error",
          message:
            typeof msg.message === "string"
              ? msg.message.slice(0, 400)
              : "Terjadi error saat ekstrak.",
          tabId: sender.tab.id,
        }),
      };
    }

    // ---- Start / Stop from Popup ----

    case "START_FROM_POPUP": {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      const p = detectPlatform(tab?.url);

      if (!tab?.id || !p) {
        return {
          ok: false,
          state: null,
          platform: null,
          error: "Not on supported platform",
          message: "Buka tab Facebook atau TikTok terlebih dahulu.",
        };
      }

      if (p === "facebook") {
        return await startFacebook(tab, msg);
      } else {
        return await startTikTok(tab, msg);
      }
    }

    case "STOP_FROM_POPUP": {
      for (const p of ["facebook", "tiktok"]) {
        const state = await getState(p);
        if (state.status === "running") {
          await stopActiveRun(p);
        }
      }
      return { ok: true };
    }

    default:
      return { ok: false, error: `Unknown type ${msg.type}` };
  }
}

// ===================== Platform Start Handlers =====================

/**
 * Stop content + MAIN-world engine. Content may be dead; always try engineCmd STOP.
 */
async function stopActiveRun(platform) {
  const state = await getState(platform);
  if (state.status !== "running") return;
  const tabId = state.tabId;
  if (tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "STOP_EXTRACT",
        runId: state.runId,
      });
    } catch {
      /* content may be gone */
    }
    // Force MAIN-world stop even if content script is unresponsive
    try {
      await engineCmd(tabId, platform, "STOP", {});
    } catch {
      /* tab closed / no host access */
    }
  }
  await setState(platform, {
    status: state.names?.length ? "stopped" : "idle",
    stopReason: "stopped",
    message: reasonToMessage("stopped", state.names?.length || 0, platform),
    runId: null,
  });
}

async function startFacebook(tab, msg) {
  const includeReplies = msg.includeReplies !== false;
  const runId = newRunId();

  // Stop prior run (same or other tab) so state ownership stays consistent
  const prev = await getState("facebook");
  if (prev.status === "running") {
    await stopActiveRun("facebook");
    await new Promise((r) => setTimeout(r, 80));
  }

  await setState("facebook", {
    status: "running",
    names: [],
    count: 0,
    message: "Memulai ekstrak…",
    tabId: tab.id,
    stopReason: null,
    includeReplies,
    runId,
  });

  // Ensure content script is present, then hand off START_EXTRACT
  const contentOk = await ensureContent(tab.id, "facebook");
  if (!contentOk) {
    const state = await setState("facebook", {
      status: "error",
      stopReason: "error",
      message:
        "Gagal memuat content script. Refresh postingan Facebook lalu coba lagi.",
      runId: null,
    });
    return { ok: false, state, error: "ensureContent failed" };
  }
  await new Promise((r) => setTimeout(r, 150));

  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: "START_EXTRACT",
      includeReplies,
      runId,
    });
  } catch (err) {
    const state = await setState("facebook", {
      status: "error",
      stopReason: "error",
      message:
        "Gagal menghubungi halaman. Refresh postingan Facebook lalu coba lagi.",
      runId: null,
    });
    return { ok: false, state, error: String(err?.message || err) };
  }
  return { ok: true, runId, state: await getState("facebook") };
}

async function startTikTok(tab, msg) {
  const awemeId = extractAwemeId(tab.url);
  if (!awemeId) {
    const state = await setState("tiktok", {
      status: "error",
      stopReason: "no_video",
      message: reasonToMessage("no_video", 0, "tiktok"),
      tabId: tab.id,
    });
    return { ok: false, state, error: "Not a video page" };
  }

  const { url: template } = await getReplayTemplate(awemeId);
  const runId = newRunId();

  const prev = await getState("tiktok");
  if (prev.status === "running") {
    await stopActiveRun("tiktok");
    await new Promise((r) => setTimeout(r, 80));
  }

  await setState("tiktok", {
    status: "running",
    names: [],
    count: 0,
    message: template
      ? "Memulai ekstrak…"
      : "Memulai… (API belum ter-capture, coba buka komentar)",
    tabId: tab.id,
    stopReason: null,
    videoHint: awemeId,
    includeReplies: msg.includeReplies === true,
    runId,
    hasTemplate: !!template,
  });

  const contentOk = await ensureContent(tab.id, "tiktok");
  if (!contentOk) {
    const state = await setState("tiktok", {
      status: "error",
      stopReason: "error",
      message:
        "Gagal memuat content script. Refresh video TikTok lalu coba lagi.",
      runId: null,
    });
    return { ok: false, state, error: "ensureContent failed" };
  }
  await new Promise((r) => setTimeout(r, 120));

  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: "START_EXTRACT",
      includeReplies: msg.includeReplies === true,
      awemeId,
      templateUrl: template || null,
      runId,
    });
  } catch (err) {
    const state = await setState("tiktok", {
      status: "error",
      stopReason: "error",
      message:
        "Gagal menghubungi halaman. Refresh video TikTok lalu coba lagi.",
      runId: null,
    });
    return { ok: false, state, error: String(err?.message || err) };
  }
  return { ok: true, runId, state: await getState("tiktok") };
}
