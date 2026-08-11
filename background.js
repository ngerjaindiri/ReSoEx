/**
 * Background service worker — Nama Komentar (FB + TikTok unified)
 * Routes messages based on detected platform.
 */
import {
  STORAGE_KEY_FB,
  STORAGE_KEY_TT,
  STORAGE_KEY_IG,
  URL_TEMPLATE_KEY,
  URL_META_KEY,
  IG_TEMPLATE_KEY,
  IG_META_KEY,
  SAVED_KEY,
  PREFS_KEY,
  defaultStateFor,
  applyStatePatch,
  mergeNames,
  mergeAcrossPlatforms,
  reasonToMessage,
  isFacebookUrl,
  isTikTokUrl,
  isInstagramUrl,
  detectPlatform,
  extractAwemeId,
  extractInstagramShortcode,
  newRunId,
  isStaleRun,
  storageKeyFor,
  sanitizeTikTokTemplateUrl,
  isTikTokTemplateValid,
  sanitizeInstagramTemplateUrl,
  isInstagramTemplateValid,
  sanitizeEngineOptions,
} from "./shared.js";

const PLATFORMS = ["facebook", "tiktok", "instagram"];

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

  // Instagram: enrich with template flag (session + TTL)
  if (platform === "instagram") {
    const { url, meta } = await getIgTemplate();
    next.hasTemplate = isInstagramTemplateValid(url, meta);
  }

  await chrome.storage.session.set({ [key]: next });
  updateBadge().catch(() => {});
  return next;
}

// ===================== Toolbar Badge =====================

/** Show the collected count for the active platform on the toolbar icon. */
async function updateBadge() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const p = detectPlatform(tab?.url);
    if (!p) {
      await chrome.action.setBadgeText({ text: "" });
      return;
    }
    const state = await getState(p);
    const n = state.names?.length || 0;
    const running = state.status === "running";
    let text = "";
    let color = "#6366f1";
    if (running) {
      text = n ? (n > 999 ? "999+" : String(n)) : "…";
    } else if (n) {
      text = n > 999 ? "999+" : String(n);
      color = state.status === "done" ? "#42b72a" : "#f7b928";
    }
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
  } catch {
    /* badge is cosmetic — never block state flow */
  }
}

// ===================== Persisted Results & Prefs (local) =====================

/** Save the final names of a finished run so results survive browser restarts. */
async function persistResult(platform, state) {
  if (!Array.isArray(state.names) || !state.names.length) return;
  const data = await chrome.storage.local.get(SAVED_KEY);
  const saved = {
    ...(data[SAVED_KEY] || {}),
    [platform]: {
      names: state.names,
      count: state.names.length,
      savedAt: Date.now(),
    },
  };
  await chrome.storage.local.set({ [SAVED_KEY]: saved });
}

async function clearSaved(platform) {
  const data = await chrome.storage.local.get(SAVED_KEY);
  const saved = { ...(data[SAVED_KEY] || {}) };
  if (saved[platform]) {
    delete saved[platform];
    await chrome.storage.local.set({ [SAVED_KEY]: saved });
  }
}

async function saveIncludeRepliesPref(platform, includeReplies) {
  const data = await chrome.storage.local.get(PREFS_KEY);
  const prefs = data[PREFS_KEY] || {};
  const next = {
    ...prefs,
    includeReplies: {
      ...(prefs.includeReplies || {}),
      [platform]: includeReplies,
    },
  };
  await chrome.storage.local.set({ [PREFS_KEY]: next });
}

/**
 * If the session has no run yet, surface a previously saved result (or the
 * saved includeReplies preference) so nothing is lost after a browser restart.
 */
async function restoreSavedIfIdle(state, platform) {
  if (state.status !== "idle" || state.names.length) return state;
  const data = await chrome.storage.local.get([SAVED_KEY, PREFS_KEY]);
  const saved = data[SAVED_KEY]?.[platform];
  if (saved && Array.isArray(saved.names) && saved.names.length) {
    const word = platform === "instagram" ? "username" : "nama";
    return {
      ...state,
      status: "done",
      names: saved.names,
      count: saved.names.length,
      message: `Hasil tersimpan (${new Date(saved.savedAt).toLocaleString("id-ID")}) — ${saved.names.length} ${word}. Klik Copy / Reset untuk hapus.`,
    };
  }
  const pref = data[PREFS_KEY]?.includeReplies?.[platform];
  if (typeof pref === "boolean") state.includeReplies = pref;
  return state;
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
    } catch (e) {
      console.debug("[ReSo] remove expired template:", e?.message);
    }
    return { url: null, meta: null };
  }

  if (!isTikTokTemplateValid(url, meta, requiredAwemeId)) {
    return { url: null, meta };
  }

  return { url, meta };
}

/**
 * Instagram comments API template — session storage, TTL, optional media filter.
 */
async function getIgTemplate(requiredMediaId = null) {
  const data = await chrome.storage.session.get([
    IG_TEMPLATE_KEY,
    IG_META_KEY,
  ]);
  const url = data[IG_TEMPLATE_KEY] || null;
  const meta = data[IG_META_KEY] || null;

  if (url && !isInstagramTemplateValid(url, meta, null)) {
    try {
      await chrome.storage.session.remove([IG_TEMPLATE_KEY, IG_META_KEY]);
    } catch (e) {
      console.debug("[ReSo] remove expired IG template:", e?.message);
    }
    return { url: null, meta: null };
  }
  if (!isInstagramTemplateValid(url, meta, requiredMediaId)) {
    return { url: null, meta };
  }
  return { url, meta };
}

async function getIgReplayTemplate() {
  const { url, meta } = await getIgTemplate();
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
      } catch (e) {
        console.debug("[ReSo] remove invalid template:", e?.message);
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
  const file =
    platform === "tiktok"
      ? "inject-tiktok.js"
      : platform === "instagram"
        ? "inject-ig.js"
        : "inject-fb.js";
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
        const key =
          plat === "tiktok"
            ? "__RESO_TNK__"
            : plat === "instagram"
              ? "__RESO_ING__"
              : "__RESO_FNK__";
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
      platform === "tiktok"
        ? "content-tiktok.js"
        : platform === "instagram"
          ? "content-ig.js"
          : "content-fb.js";
    const cssFile =
      platform === "tiktok"
        ? "content-tiktok.css"
        : platform === "instagram"
          ? "content-ig.css"
          : "content-fb.css";
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
  if (reason === "rate_limit") return count > 0 ? "partial" : "error";
  if (reason === "blocked") return count > 0 ? "partial" : "error";
  if (reason === "checkpoint") return count > 0 ? "partial" : "error";
  if (
    reason === "error" ||
    reason === "no_template" ||
    reason === "no_video" ||
    reason === "no_login" ||
    reason === "no_media"
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

// ===================== Instagram webRequest Capture =====================

function isIgCommentsUrl(url) {
  if (!url) return false;
  const u = url.toLowerCase();
  if (!u.includes("instagram.com/api/v1/media/")) return false;
  if (!u.includes("/comments/")) return false;
  if (u.includes("/inline_child_comments")) return false;
  return true;
}

// Observational only — capture URL shape, no headers needed
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!isIgCommentsUrl(details.url)) return;
    const clean = sanitizeInstagramTemplateUrl(details.url);
    if (!clean) return;
    const mediaId =
      details.url.match(/instagram\.com\/api\/v1\/media\/(\d+)\//)?.[1] ||
      null;
    (async () => {
      try {
        // Jangan timpa template media lain saat run aktif (pola guard TikTok):
        // bila run sedang memproses media X dengan template valid, capture dari
        // media lain (user scroll ke post/reel beda) dilewati — stabilitas
        // pagination & target run berikutnya tetap terjaga.
        const st = await getState("instagram");
        const prev = await chrome.storage.session.get([
          IG_TEMPLATE_KEY,
          IG_META_KEY,
        ]);
        const prevMeta = prev[IG_META_KEY] || null;
        const prevUrl = prev[IG_TEMPLATE_KEY] || null;
        const prevValid = isInstagramTemplateValid(prevUrl, prevMeta, null);
        const runMediaId =
          (st.postHint || "").match(/media\s+(\d+)/)?.[1] || null;
        if (
          st.status === "running" &&
          prevValid &&
          runMediaId &&
          prevMeta?.mediaId &&
          String(prevMeta.mediaId) === String(runMediaId) &&
          mediaId &&
          String(mediaId) !== String(runMediaId)
        ) {
          return;
        }

        await chrome.storage.session.set({
          [IG_TEMPLATE_KEY]: clean,
          [IG_META_KEY]: {
            capturedAt: Date.now(),
            mediaId,
            tabId: details.tabId,
          },
        });
        if (st.status === "running") {
          await setState("instagram", { hasTemplate: true });
        } else {
          await setState("instagram", {
            hasTemplate: true,
            message:
              "Template API komentar siap. Klik Proses untuk ambil username.",
          });
        }
      } catch (e) {
        console.warn("[ReSo] IG webRequest template capture failed:", e?.message);
      }
    })();
  },
  { urls: ["*://*.instagram.com/*"] }
);

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
      } catch (e) {
        console.warn("[ReSo] webRequest template capture failed:", e?.message);
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
    [STORAGE_KEY_IG]: { ...defaultStateFor("instagram") },
  });
  // Drop legacy local template keys from pre-Sprint-A builds
  try {
    await chrome.storage.local.remove([URL_TEMPLATE_KEY, URL_META_KEY]);
  } catch (e) {
    console.debug("[ReSo] onInstalled cleanup:", e?.message);
  }
  ensureContextMenus();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const url = tab?.url;
  if (!url) return;
  if (changeInfo.status === "complete") updateBadge().catch(() => {});

  if (isFacebookUrl(url)) {
    // Inject early on loading so GraphQL buffer captures comments from the start
    if (changeInfo.status === "loading") {
      await injectMain(tabId, "facebook");
    }
  } else if (isTikTokUrl(url) || isInstagramUrl(url)) {
    if (changeInfo.status === "complete") {
      await injectMain(tabId, isTikTokUrl(url) ? "tiktok" : "instagram");
    }
  }
});

// If the tab owning a run is closed, finalize the run instead of leaving it hung
chrome.tabs.onRemoved.addListener(async (tabId) => {
  for (const p of PLATFORMS) {
    const state = await getState(p);
    if (state.status !== "running" || state.tabId !== tabId) continue;
    const count = state.names?.length || 0;
    const finalState = await setState(p, {
      status: count ? "stopped" : "idle",
      names: state.names || [],
      stopReason: "stopped",
      message: reasonToMessage("stopped", count, p, "(tab ditutup)"),
      tabId: null,
      runId: null,
    });
    if (count) persistResult(p, finalState).catch(() => {});
  }
});

chrome.tabs.onActivated.addListener(() => {
  updateBadge().catch(() => {});
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
      if (platform === "instagram") {
        // Simetris dengan TikTok: recompute dari session template (TTL + shape)
        // agar badge API popup selalu akurat — bahkan saat service worker baru
        // bangun / state session belum di-set ulang lewat setState.
        const ig = await getIgReplayTemplate();
        state.hasTemplate = !!ig.url;
      }
      return { ok: true, state: await restoreSavedIfIdle(state, platform), platform };
    }

    case "GET_ALL_STATE": {
      // Restore persisted results so the merge button sees all platforms
      // even right after a browser restart (session state is empty then).
      const facebook = await restoreSavedIfIdle(
        await getState("facebook"),
        "facebook"
      );
      const tiktok = await restoreSavedIfIdle(
        await getState("tiktok"),
        "tiktok"
      );
      const instagram = await restoreSavedIfIdle(
        await getState("instagram"),
        "instagram"
      );
      return { ok: true, facebook, tiktok, instagram };
    }

    case "MERGE_ALL": {
      // Merge dijalankan di background karena shared.js (single source of
      // truth) yang punya ketiga normalizer platform — content scripts hanya
      // membawa normalizer platform-nya sendiri, jadi merge lintas platform
      // TIDAK boleh dijalankan di halaman (bukan hanya duplikasi, tapi juga
      // bakal ReferenceError). Panel/popup tinggal pakai hasilnya.
      const facebook = await restoreSavedIfIdle(
        await getState("facebook"),
        "facebook"
      );
      const tiktok = await restoreSavedIfIdle(
        await getState("tiktok"),
        "tiktok"
      );
      const instagram = await restoreSavedIfIdle(
        await getState("instagram"),
        "instagram"
      );
      const merged = mergeAcrossPlatforms([
        { platform: "facebook", names: facebook.names || [] },
        { platform: "tiktok", names: tiktok.names || [] },
        { platform: "instagram", names: instagram.names || [] },
      ]);
      return { ok: true, names: merged };
    }

    case "CHECK_IG_LOGIN": {
      // Pre-flight gate before starting an Instagram run: fail fast with
      // "perlu login" instead of burning a whole run in scroll mode.
      try {
        const c = await chrome.cookies.get({
          url: "https://www.instagram.com/",
          name: "sessionid",
        });
        return { ok: true, loggedIn: !!c };
      } catch (e) {
        return { ok: false, loggedIn: null, error: String(e?.message || e) };
      }
    }

    case "CHECK_TT_LOGIN": {
      // Pre-flight gate for TikTok (pola IG): replay comment/list butuh sesi;
      // tanpa cookie sessionid, run hanya membuang waktu & request.
      try {
        const c = await chrome.cookies.get({
          url: "https://www.tiktok.com/",
          name: "sessionid",
        });
        return { ok: true, loggedIn: !!c };
      } catch (e) {
        return { ok: false, loggedIn: null, error: String(e?.message || e) };
      }
    }

    case "GET_TEMPLATE": {
      if (platform === "instagram") {
        const ig = await getIgReplayTemplate();
        return { ok: true, url: ig.url, meta: ig.meta, sameVideo: true };
      }
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

      if (typeof patch.includeReplies === "boolean") {
        saveIncludeRepliesPref(platform, patch.includeReplies).catch(() => {});
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
        } catch (e) {
          console.debug("[ReSo] RESET stop content:", e?.message);
        }
        try {
          await engineCmd(prev.tabId, p, "STOP", {});
        } catch (e) {
          console.debug("[ReSo] RESET stop engine:", e?.message);
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
          : p === "instagram"
            ? {
                status: "idle",
                names: [],
                count: 0,
                message:
                  "Buka post/reel Instagram, pastikan sudah login, lalu klik Proses.",
                tabId: null,
                stopReason: null,
                postHint: "",
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
      await clearSaved(p);
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
      // Carry the engine's rate-limit diagnosis (e.g. IG 429) to the user
      // instead of collapsing it into a generic "timeout" message.
      const hint = p === "tiktok" ? msg.videoHint : msg.postHint;
      const extra =
        typeof hint === "string" && /rate\s*limit|429/i.test(hint) ? hint : "";
      const patchObj = {
        status,
        names,
        stopReason,
        message: reasonToMessage(
          stopReason,
          names.length,
          p,
          typeof msg.extra === "string" ? msg.extra.slice(0, 200) : extra
        ),
        tabId: sender.tab.id,
        runId: prev.runId,
      };
      if (p === "tiktok") {
        patchObj.videoHint = msg.videoHint ?? prev.videoHint;
      } else {
        patchObj.postHint = msg.postHint ?? prev.postHint;
      }
      const state = await setState(p, patchObj);
      if (["done", "partial", "stopped", "error"].includes(state.status)) {
        persistResult(p, state).catch(() => {});
      }
      return { ok: true, state };
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
          message: "Buka tab Facebook, TikTok, atau Instagram terlebih dahulu.",
        };
      }

      if (p === "facebook") {
        return await startFacebook(tab, msg);
      } else if (p === "tiktok") {
        return await startTikTok(tab, msg);
      } else {
        return await startInstagram(tab, msg);
      }
    }

    case "STOP_FROM_POPUP": {
      for (const p of PLATFORMS) {
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
    } catch (e) {
      console.debug("[ReSo] stopActiveRun content:", e?.message);
    }
    // Force MAIN-world stop even if content script is unresponsive
    try {
      await engineCmd(tabId, platform, "STOP", {});
    } catch (e) {
      console.debug("[ReSo] stopActiveRun engine:", e?.message);
    }
  }
  const finalState = await setState(platform, {
    status: state.names?.length ? "stopped" : "idle",
    stopReason: "stopped",
    message: reasonToMessage("stopped", state.names?.length || 0, platform),
    runId: null,
  });
  if (finalState.names?.length) persistResult(platform, finalState).catch(() => {});
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
  // Pre-check sesi (pola IG): replay API komentar butuh cookie sessionid.
  // Gagal cepat dengan pesan jelas alih-alih run yang sia-sia saat logout.
  try {
    const cookie = await chrome.cookies.get({
      url: "https://www.tiktok.com/",
      name: "sessionid",
    });
    if (!cookie) {
      const state = await setState("tiktok", {
        status: "error",
        stopReason: "no_login",
        message: reasonToMessage("no_login", 0, "tiktok"),
        tabId: tab.id,
        runId: null,
      });
      return { ok: false, state, error: "Not logged in to TikTok" };
    }
  } catch {
    /* cookies API unavailable — let the engine probe instead */
  }

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

async function startInstagram(tab, msg) {
  // Pre-check login so popup/shortcut/context-menu fail fast with a clear
  // message instead of a wasted run (IG gates every API call on sessionid).
  try {
    const cookie = await chrome.cookies.get({
      url: "https://www.instagram.com/",
      name: "sessionid",
    });
    if (!cookie) {
      const state = await setState("instagram", {
        status: "error",
        stopReason: "no_login",
        message: reasonToMessage("no_login", 0, "instagram"),
        tabId: tab.id,
        runId: null,
      });
      return { ok: false, state, error: "Not logged in to Instagram" };
    }
  } catch {
    /* cookies API unavailable — let the engine probe instead */
  }

  // Pre-check halaman: tanpa shortcode (profil/feed), media_id tak bisa
  // ditentukan → gagal cepat (pola no_video TikTok).
  if (!extractInstagramShortcode(tab?.url)) {
    const state = await setState("instagram", {
      status: "error",
      stopReason: "no_media",
      message: reasonToMessage("no_media", 0, "instagram"),
      tabId: tab.id,
      runId: null,
    });
    return { ok: false, state, error: "Not on an Instagram post page" };
  }

  const { url: template } = await getIgReplayTemplate();
  const runId = newRunId();

  const prev = await getState("instagram");
  if (prev.status === "running") {
    await stopActiveRun("instagram");
    await new Promise((r) => setTimeout(r, 80));
  }

  await setState("instagram", {
    status: "running",
    names: [],
    count: 0,
    message: template
      ? "Memulai ekstrak…"
      : "Memulai… (API belum ter-capture — pastikan sudah login & buka komentar)",
    tabId: tab.id,
    stopReason: null,
    postHint: "",
    includeReplies: msg.includeReplies === true,
    runId,
    hasTemplate: !!template,
  });

  const contentOk = await ensureContent(tab.id, "instagram");
  if (!contentOk) {
    const state = await setState("instagram", {
      status: "error",
      stopReason: "error",
      message:
        "Gagal memuat content script. Refresh halaman Instagram lalu coba lagi.",
      runId: null,
    });
    return { ok: false, state, error: "ensureContent failed" };
  }
  await new Promise((r) => setTimeout(r, 120));

  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: "START_EXTRACT",
      includeReplies: msg.includeReplies === true,
      templateUrl: template || null,
      runId,
    });
  } catch (err) {
    const state = await setState("instagram", {
      status: "error",
      stopReason: "error",
      message:
        "Gagal menghubungi halaman. Refresh halaman Instagram lalu coba lagi.",
      runId: null,
    });
    return { ok: false, state, error: String(err?.message || err) };
  }
  return { ok: true, runId, state: await getState("instagram") };
}

// ===================== Context Menus & Keyboard Shortcuts =====================

function ensureContextMenus() {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: "reso-page",
        title: "ReSo — Ambil nama komentator halaman ini",
        contexts: ["page"],
      });
      chrome.contextMenus.create({
        id: "reso-link",
        title: "ReSo — Buka & ambil nama dari tautan ini",
        contexts: ["link"],
      });
    });
  } catch (e) {
    console.debug("[ReSo] contextMenus init:", e?.message);
  }
}
ensureContextMenus();

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    if (info.menuItemId === "reso-link") {
      const url = info.linkUrl;
      const p = detectPlatform(url);
      if (!p) return;
      const newTab = await chrome.tabs.create({ url, active: true });
      await waitTabComplete(newTab.id, 25000);
      if (p === "facebook") {
        await startFacebook(newTab, { includeReplies: true });
      } else if (p === "tiktok") {
        await startTikTok(newTab, { includeReplies: false });
      } else {
        await startInstagram(newTab, { includeReplies: false });
      }
    } else if (info.menuItemId === "reso-page") {
      const p = detectPlatform(tab?.url);
      if (!p || !tab?.id) return;
      const data = await chrome.storage.local.get(PREFS_KEY);
      const includeReplies =
        data[PREFS_KEY]?.includeReplies?.[p] ?? p === "facebook";
      if (p === "facebook") await startFacebook(tab, { includeReplies });
      else if (p === "tiktok") await startTikTok(tab, { includeReplies });
      else await startInstagram(tab, { includeReplies });
    }
  } catch (e) {
    console.debug("[ReSo] context menu:", e?.message);
  }
});

function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const done = () => resolve();
    const timer = setTimeout(done, timeoutMs);
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        clearTimeout(timer);
        done();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

chrome.commands.onCommand.addListener(async (cmd) => {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id) return;
    const p = detectPlatform(tab?.url);
    if (cmd === "run-extract") {
      if (!p) return;
      const data = await chrome.storage.local.get(PREFS_KEY);
      const includeReplies =
        data[PREFS_KEY]?.includeReplies?.[p] ?? p === "facebook";
      if (p === "facebook") await startFacebook(tab, { includeReplies });
      else if (p === "tiktok") await startTikTok(tab, { includeReplies });
      else await startInstagram(tab, { includeReplies });
    } else if (cmd === "copy-names") {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "COPY_FROM_PAGE" });
      } catch (e) {
        console.debug("[ReSo] shortcut copy:", e?.message);
      }
    }
  } catch (e) {
    console.debug("[ReSo] command:", e?.message);
  }
});
