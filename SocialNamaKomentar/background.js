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

  // TikTok: enrich with template flag
  if (platform === "tiktok") {
    const tpl = await chrome.storage.local.get(URL_TEMPLATE_KEY);
    next.hasTemplate = !!tpl[URL_TEMPLATE_KEY];
  }

  await chrome.storage.session.set({ [key]: next });
  return next;
}

async function getTemplate() {
  const data = await chrome.storage.local.get([URL_TEMPLATE_KEY, URL_META_KEY]);
  return {
    url: data[URL_TEMPLATE_KEY] || null,
    meta: data[URL_META_KEY] || null,
  };
}

// ===================== Injection Helpers =====================

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

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!isCommentListUrl(details.url)) return;
    const awemeId =
      extractAwemeId(details.url) ||
      (() => {
        try {
          return new URL(details.url).searchParams.get("aweme_id");
        } catch {
          return null;
        }
      })();

    chrome.storage.local
      .set({
        [URL_TEMPLATE_KEY]: details.url,
        [URL_META_KEY]: {
          capturedAt: Date.now(),
          awemeId,
          tabId: details.tabId,
        },
      })
      .then(async () => {
        const st = await getState("tiktok");
        if (st.status === "running") {
          await setState("tiktok", { hasTemplate: true });
        } else {
          await setState("tiktok", {
            hasTemplate: true,
            message:
              "Template API komentar siap. Klik Proses untuk ambil nama.",
          });
        }
      })
      .catch(() => {});
  },
  { urls: ["*://*.tiktok.com/*"] }
);

// ===================== Tab Injection on Navigation =====================

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.session.set({
    [STORAGE_KEY_FB]: { ...defaultStateFor("facebook") },
    [STORAGE_KEY_TT]: { ...defaultStateFor("tiktok") },
  });
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

  // Determine platform from message, sender tab, or active tab
  let platform = msg.platform || null;
  if (!platform && sender.tab?.url) {
    platform = detectPlatform(sender.tab.url);
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
      const state = await getState(platform || "facebook");
      if (platform === "tiktok") {
        const { url } = await getTemplate();
        state.hasTemplate = !!url;
      }
      return { ok: true, state, platform };
    }

    case "GET_TEMPLATE": {
      const t = await getTemplate();
      return { ok: true, ...t };
    }

    case "SET_STATE": {
      if (!platform) {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        platform = detectPlatform(tab?.url);
      }
      return {
        ok: true,
        state: await setState(platform || "facebook", msg.patch || {}),
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
      const p = platform || "facebook";
      const prev = await getState(p);
      if (prev.tabId) {
        try {
          await chrome.tabs.sendMessage(prev.tabId, {
            type: "STOP_EXTRACT",
            runId: prev.runId,
          });
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
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) return { ok: false, error: "No tab" };
      if (!platform) {
        try {
          const tab = await chrome.tabs.get(tabId);
          platform = detectPlatform(tab?.url);
        } catch {
          platform = "facebook";
        }
      }
      return { ok: await injectMain(tabId, platform || "facebook") };
    }

    // ---- Progress / Done / Error ----

    case "NAMES_PROGRESS": {
      const p = platform || "facebook";
      const prev = await getState(p);
      if (isStaleRun(prev.runId, msg.runId)) {
        return { ok: true, state: prev, stale: true };
      }
      const incoming = msg.names || [];
      const names =
        incoming.length >= (prev.names?.length || 0)
          ? mergeNames([], incoming, p)
          : mergeNames(prev.names, incoming, p);
      const patchObj = {
        status: "running",
        names,
        message: msg.message || `Mengumpulkan… ${names.length} nama`,
        tabId: sender.tab?.id ?? prev.tabId,
        runId: prev.runId,
      };
      // Platform-specific hint
      if (p === "tiktok") {
        patchObj.videoHint = msg.videoHint ?? prev.videoHint;
      } else {
        patchObj.postHint = msg.postHint ?? prev.postHint;
      }
      return { ok: true, state: await setState(p, patchObj) };
    }

    case "NAMES_DONE": {
      const p = platform || "facebook";
      const prev = await getState(p);
      if (isStaleRun(prev.runId, msg.runId)) {
        return { ok: true, state: prev, stale: true };
      }
      const names = mergeNames([], msg.names || prev.names || [], p);
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
          msg.extra || ""
        ),
        tabId: sender.tab?.id ?? prev.tabId,
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
      const p = platform || "facebook";
      const prev = await getState(p);
      if (isStaleRun(prev.runId, msg.runId)) {
        return { ok: true, state: prev, stale: true };
      }
      return {
        ok: true,
        state: await setState(p, {
          status: "error",
          stopReason: "error",
          message: msg.message || "Terjadi error saat ekstrak.",
          tabId: sender.tab?.id ?? null,
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
        const fallbackPlatform = p || "facebook";
        const state = await setState(fallbackPlatform, {
          status: "error",
          message:
            "Buka tab Facebook atau TikTok terlebih dahulu.",
        });
        return { ok: false, state, error: "Not on supported platform" };
      }

      if (p === "facebook") {
        return await startFacebook(tab, msg);
      } else {
        return await startTikTok(tab, msg);
      }
    }

    case "STOP_FROM_POPUP": {
      // Try both platforms — only one will have active run
      for (const p of ["facebook", "tiktok"]) {
        const state = await getState(p);
        if (state.tabId && state.status === "running") {
          try {
            await chrome.tabs.sendMessage(state.tabId, {
              type: "STOP_EXTRACT",
              runId: state.runId,
            });
          } catch {
            if (state.status === "running") {
              await setState(p, {
                status: state.names?.length ? "stopped" : "error",
                stopReason: "stopped",
                message: reasonToMessage(
                  "stopped",
                  state.names?.length || 0,
                  p
                ),
              });
            }
          }
        }
      }
      return { ok: true };
    }

    default:
      return { ok: false, error: `Unknown type ${msg.type}` };
  }
}

// ===================== Platform Start Handlers =====================

async function startFacebook(tab, msg) {
  const includeReplies = msg.includeReplies !== false;
  const runId = newRunId();

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

  await injectMain(tab.id, "facebook");
  await ensureContent(tab.id, "facebook");
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
    });
    return { ok: false, state, error: String(err?.message || err) };
  }
  return { ok: true, runId };
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

  const { url: template } = await getTemplate();
  const runId = newRunId();

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

  await injectMain(tab.id, "tiktok");
  await ensureContent(tab.id, "tiktok");
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
    });
    return { ok: false, state, error: String(err?.message || err) };
  }
  return { ok: true, runId };
}
