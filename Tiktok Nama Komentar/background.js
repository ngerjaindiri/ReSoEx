import {
  STORAGE_KEY,
  URL_TEMPLATE_KEY,
  URL_META_KEY,
  DEFAULT_STATE,
  applyStatePatch,
  mergeNames,
  reasonToMessage,
  isTikTokUrl,
  extractAwemeId,
  newRunId,
  isStaleRun,
} from "./shared.js";

async function getState() {
  const data = await chrome.storage.session.get(STORAGE_KEY);
  return { ...DEFAULT_STATE, ...(data[STORAGE_KEY] || {}) };
}

async function setState(patch) {
  const prev = await getState();
  const next = applyStatePatch(prev, patch);
  const tpl = await chrome.storage.local.get(URL_TEMPLATE_KEY);
  next.hasTemplate = !!tpl[URL_TEMPLATE_KEY];
  await chrome.storage.session.set({ [STORAGE_KEY]: next });
  return next;
}

async function getTemplate() {
  const data = await chrome.storage.local.get([URL_TEMPLATE_KEY, URL_META_KEY]);
  return {
    url: data[URL_TEMPLATE_KEY] || null,
    meta: data[URL_META_KEY] || null,
  };
}

function isCommentListUrl(url) {
  if (!url) return false;
  const u = url.toLowerCase();
  if (!u.includes("tiktok.com/api/comment/list")) return false;
  if (u.includes("tiktok.com/api/comment/list/reply")) return false;
  return true;
}

// Capture live comment API template — never clobber an active run message
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
        const st = await getState();
        if (st.status === "running") {
          // Only flip badge flag; keep progress message intact
          await setState({ hasTemplate: true });
        } else {
          await setState({
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

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.session.set({ [STORAGE_KEY]: { ...DEFAULT_STATE } });
});

async function injectMain(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: "MAIN",
      files: ["inject.js"],
    });
    return true;
  } catch (err) {
    console.warn("injectMain", err);
    return false;
  }
}

async function ensureContent(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return true;
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ["content.css"],
      });
      return true;
    } catch (err) {
      console.warn("ensureContent", err);
      return false;
    }
  }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!isTikTokUrl(tab?.url || "")) return;
  await injectMain(tabId);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});

function statusFromReason(reason, count) {
  if (reason === "stopped") return "stopped";
  if (reason === "timeout") return "partial";
  if (reason === "error" || reason === "no_template" || reason === "no_video")
    return "error";
  if (reason === "complete" || reason === "idle")
    return count > 0 ? "done" : "error";
  return count > 0 ? "done" : "error";
}

async function handle(msg, sender) {
  if (!msg?.type) return { ok: false, error: "Invalid message" };

  switch (msg.type) {
    case "GET_STATE": {
      const state = await getState();
      const { url } = await getTemplate();
      state.hasTemplate = !!url;
      return { ok: true, state };
    }

    case "GET_TEMPLATE": {
      const t = await getTemplate();
      return { ok: true, ...t };
    }

    case "SET_STATE":
      return { ok: true, state: await setState(msg.patch || {}) };

    case "RESET": {
      const prev = await getState();
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
      const state = await setState({
        status: "idle",
        names: [],
        count: 0,
        message: "Buka video TikTok, buka panel komentar, lalu klik Proses.",
        tabId: null,
        stopReason: null,
        videoHint: "",
        runId: null,
      });
      return { ok: true, state };
    }

    case "INJECT_MAIN": {
      const tabId = msg.tabId || sender.tab?.id;
      if (!tabId) return { ok: false, error: "No tab" };
      return { ok: await injectMain(tabId) };
    }

    case "NAMES_PROGRESS": {
      const prev = await getState();
      if (isStaleRun(prev.runId, msg.runId)) {
        return { ok: true, state: prev, stale: true };
      }
      const incoming = msg.names || [];
      const names =
        incoming.length >= (prev.names?.length || 0)
          ? mergeNames([], incoming)
          : mergeNames(prev.names, incoming);
      return {
        ok: true,
        state: await setState({
          status: "running",
          names,
          message: msg.message || `Mengumpulkan… ${names.length} nama`,
          tabId: sender.tab?.id ?? prev.tabId,
          videoHint: msg.videoHint ?? prev.videoHint,
          runId: prev.runId,
        }),
      };
    }

    case "NAMES_DONE": {
      const prev = await getState();
      if (isStaleRun(prev.runId, msg.runId)) {
        return { ok: true, state: prev, stale: true };
      }
      const names = mergeNames([], msg.names || prev.names || []);
      const stopReason = msg.stopReason || "complete";
      const status = statusFromReason(stopReason, names.length);
      return {
        ok: true,
        state: await setState({
          status,
          names,
          stopReason,
          message: reasonToMessage(stopReason, names.length, msg.extra || ""),
          tabId: sender.tab?.id ?? prev.tabId,
          videoHint: msg.videoHint ?? prev.videoHint,
          runId: prev.runId,
        }),
      };
    }

    case "NAMES_ERROR": {
      const prev = await getState();
      if (isStaleRun(prev.runId, msg.runId)) {
        return { ok: true, state: prev, stale: true };
      }
      return {
        ok: true,
        state: await setState({
          status: "error",
          stopReason: "error",
          message: msg.message || "Terjadi error saat ekstrak.",
          tabId: sender.tab?.id ?? null,
        }),
      };
    }

    case "START_FROM_POPUP": {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab?.id || !isTikTokUrl(tab.url || "")) {
        const state = await setState({
          status: "error",
          stopReason: "no_video",
          message: reasonToMessage("no_video", 0),
        });
        return { ok: false, state, error: "Not on TikTok" };
      }

      const awemeId = extractAwemeId(tab.url);
      if (!awemeId) {
        const state = await setState({
          status: "error",
          stopReason: "no_video",
          message: reasonToMessage("no_video", 0),
          tabId: tab.id,
        });
        return { ok: false, state, error: "Not a video page" };
      }

      const { url: template } = await getTemplate();
      const runId = newRunId();

      await setState({
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

      await injectMain(tab.id);
      await ensureContent(tab.id);
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
        const state = await setState({
          status: "error",
          stopReason: "error",
          message:
            "Gagal menghubungi halaman. Refresh video TikTok lalu coba lagi.",
        });
        return { ok: false, state, error: String(err?.message || err) };
      }
      return { ok: true, runId };
    }

    case "STOP_FROM_POPUP": {
      const state = await getState();
      if (state.tabId) {
        try {
          await chrome.tabs.sendMessage(state.tabId, {
            type: "STOP_EXTRACT",
            runId: state.runId,
          });
        } catch {
          if (state.status === "running") {
            await setState({
              status: state.names?.length ? "stopped" : "error",
              stopReason: "stopped",
              message: reasonToMessage("stopped", state.names?.length || 0),
            });
          }
        }
      }
      return { ok: true };
    }

    default:
      return { ok: false, error: `Unknown ${msg.type}` };
  }
}
