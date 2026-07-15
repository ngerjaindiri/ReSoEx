import {
  STORAGE_KEY,
  DEFAULT_STATE,
  applyStatePatch,
  mergeNames,
  reasonToMessage,
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
  await chrome.storage.session.set({ [STORAGE_KEY]: next });
  return next;
}

function isFacebookUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return (
      u.hostname === "www.facebook.com" ||
      u.hostname === "web.facebook.com" ||
      u.hostname === "m.facebook.com" ||
      u.hostname.endsWith(".facebook.com")
    );
  } catch {
    return false;
  }
}

async function injectMain(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: "MAIN",
      injectImmediately: true,
      files: ["inject.js"],
    });
    return true;
  } catch (err) {
    // Retry without injectImmediately (older Chrome)
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        world: "MAIN",
        files: ["inject.js"],
      });
      return true;
    } catch (err2) {
      console.warn("injectMain failed", err2);
      return false;
    }
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
      console.warn("ensureContent failed", err);
      return false;
    }
  }
}

function statusFromReason(stopReason, count) {
  if (stopReason === "stopped") return "stopped";
  if (stopReason === "timeout") return "partial";
  if (stopReason === "error") return "error";
  if (stopReason === "complete" || stopReason === "idle") {
    return count > 0 ? "done" : "error";
  }
  return count > 0 ? "done" : "error";
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.session.set({ [STORAGE_KEY]: { ...DEFAULT_STATE } });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Inject early so GraphQL buffer captures comments before user clicks Proses
  if (changeInfo.status !== "loading" && changeInfo.status !== "complete")
    return;
  if (!isFacebookUrl(tab?.url)) return;
  await injectMain(tabId);
});

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

  switch (msg.type) {
    case "GET_STATE":
      return { ok: true, state: await getState() };

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
        message: "Buka 1 postingan Facebook, lalu klik Proses.",
        tabId: null,
        stopReason: null,
        postHint: "",
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
      // Always prefer full snapshot if provided; merge only when growing
      const names =
        incoming.length >= (prev.names?.length || 0)
          ? mergeNames([], incoming)
          : mergeNames(prev.names, incoming);
      const state = await setState({
        status: "running",
        names,
        message: msg.message || `Mengumpulkan… ${names.length} nama`,
        tabId: sender.tab?.id ?? prev.tabId,
        postHint: msg.postHint ?? prev.postHint,
        runId: prev.runId,
      });
      return { ok: true, state };
    }

    case "NAMES_DONE": {
      const prev = await getState();
      if (isStaleRun(prev.runId, msg.runId)) {
        return { ok: true, state: prev, stale: true };
      }
      const names = mergeNames([], msg.names || prev.names || []);
      const stopReason = msg.stopReason || "complete";
      const status = statusFromReason(stopReason, names.length);
      const state = await setState({
        status,
        names,
        stopReason,
        message: reasonToMessage(stopReason, names.length),
        tabId: sender.tab?.id ?? prev.tabId,
        postHint: msg.postHint ?? prev.postHint,
        runId: prev.runId,
      });
      return { ok: true, state };
    }

    case "NAMES_ERROR": {
      const prev = await getState();
      if (isStaleRun(prev.runId, msg.runId)) {
        return { ok: true, state: prev, stale: true };
      }
      const state = await setState({
        status: "error",
        stopReason: "error",
        message: msg.message || "Terjadi error saat ekstrak.",
        tabId: sender.tab?.id ?? null,
      });
      return { ok: true, state };
    }

    case "START_FROM_POPUP": {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab?.id || !isFacebookUrl(tab.url)) {
        const state = await setState({
          status: "error",
          message: "Buka dulu tab postingan Facebook (1 post / permalink).",
        });
        return { ok: false, state, error: "Not on Facebook" };
      }

      const includeReplies = msg.includeReplies !== false;
      const runId = newRunId();

      await setState({
        status: "running",
        names: [],
        count: 0,
        message: "Memulai ekstrak…",
        tabId: tab.id,
        stopReason: null,
        includeReplies,
        runId,
      });

      await injectMain(tab.id);
      await ensureContent(tab.id);
      await new Promise((r) => setTimeout(r, 150));

      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: "START_EXTRACT",
          includeReplies,
          runId,
        });
      } catch (err) {
        const state = await setState({
          status: "error",
          stopReason: "error",
          message:
            "Gagal menghubungi halaman. Refresh postingan Facebook lalu coba lagi.",
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
          /* tab closed — finalize here */
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
      return { ok: false, error: `Unknown type ${msg.type}` };
  }
}
