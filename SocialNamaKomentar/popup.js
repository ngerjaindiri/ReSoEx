/**
 * Popup script — Nama Komentar (FB + TikTok unified)
 * Detects platform from active tab, renders adaptive UI.
 */
import { namesToClipboardText, detectPlatform } from "./shared.js";

const $ = (id) => document.getElementById(id);

const statusEl = $("status");
const hintEl = $("hint");
const apiBadgeEl = $("apiBadge");
const countEl = $("count");
const previewEl = $("preview");
const btnProcess = $("btnProcess");
const btnStop = $("btnStop");
const btnCopy = $("btnCopy");
const btnReset = $("btnReset");
const includeRepliesEl = $("includeReplies");
const platformBadge = $("platformBadge");

const headerTitle = $("headerTitle");
const headerSub = $("headerSub");
const stepsFb = $("stepsFb");
const stepsTt = $("stepsTt");
const noSupport = $("noSupport");

let currentPlatform = null;

function setPlatformUI(platform) {
  currentPlatform = platform;
  document.body.dataset.platform = platform || "";

  if (platform === "facebook") {
    platformBadge.textContent = "📘 Facebook";
    headerTitle.textContent = "ReSo Ekstention";
    headerSub.textContent = "FB — Nama komentator → copy ke Excel";
    stepsFb.hidden = false;
    stepsTt.hidden = true;
    noSupport.hidden = true;
    apiBadgeEl.hidden = true;
    includeRepliesEl.checked = true;
  } else if (platform === "tiktok") {
    platformBadge.textContent = "🎵 TikTok";
    headerTitle.textContent = "ReSo Ekstention";
    headerSub.textContent = "TikTok — Nickname komentator → copy Excel";
    stepsFb.hidden = true;
    stepsTt.hidden = false;
    noSupport.hidden = true;
    apiBadgeEl.hidden = false;
    includeRepliesEl.checked = false;
  } else {
    platformBadge.textContent = "⚠️ Platform tidak didukung";
    headerTitle.textContent = "ReSo Ekstention";
    headerSub.textContent = "Buka tab Facebook / TikTok untuk mulai";
    stepsFb.hidden = true;
    stepsTt.hidden = true;
    noSupport.hidden = false;
    apiBadgeEl.hidden = true;
    btnProcess.disabled = true;
  }
}

function render(state, platform) {
  if (!state) return;
  if (platform) setPlatformUI(platform);

  statusEl.textContent = state.message || "";

  // Hint
  if (platform === "tiktok") {
    hintEl.textContent = state.videoHint
      ? `Video: ${state.videoHint}`
      : "Target: tab TikTok aktif";
    // API badge
    if (apiBadgeEl) {
      apiBadgeEl.hidden = false;
      apiBadgeEl.textContent = state.hasTemplate
        ? "API komentar: siap"
        : "API komentar: belum — buka panel komentar";
      apiBadgeEl.classList.toggle("ok", !!state.hasTemplate);
    }
  } else {
    hintEl.textContent = state.postHint
      ? `Target: ${state.postHint}`
      : "Target: post di tab aktif";
    if (apiBadgeEl) apiBadgeEl.hidden = true;
  }

  // Count
  const n = state.count ?? (state.names || []).length;
  countEl.textContent = `${n} nama`;

  // Include replies
  if (typeof state.includeReplies === "boolean") {
    includeRepliesEl.checked = state.includeReplies;
  }

  // Preview
  const names = state.names || [];
  if (names.length) {
    previewEl.hidden = false;
    const show = names.slice(0, 40);
    previewEl.textContent =
      show.join("\n") +
      (names.length > 40 ? `\n… +${names.length - 40} lagi` : "");
  } else {
    previewEl.hidden = true;
    previewEl.textContent = "";
  }

  // Button states
  const running = state.status === "running";
  if (currentPlatform) {
    btnProcess.disabled = running;
  }
  btnProcess.textContent = running ? "Memproses…" : "Proses";
  btnStop.hidden = !running;
  btnCopy.disabled = names.length === 0;
  btnCopy.textContent = names.length
    ? `Copy nama (${names.length})`
    : "Copy nama";

  // Status color
  document.body.dataset.status = state.status || "idle";
}

async function getState() {
  const res = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  return res;
}

async function refresh() {
  try {
    const res = await getState();
    render(res?.state, res?.platform);
  } catch (e) {
    statusEl.textContent = String(e?.message || e);
  }
}

// ---- Detect platform on popup open ----
async function init() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const platform = detectPlatform(tab?.url);
    setPlatformUI(platform);
  } catch {
    setPlatformUI(null);
  }
  await refresh();
}

// ---- Event Listeners ----

btnProcess.addEventListener("click", async () => {
  btnProcess.disabled = true;
  const res = await chrome.runtime.sendMessage({
    type: "START_FROM_POPUP",
    includeReplies: includeRepliesEl.checked,
  });
  if (res?.state) render(res.state, currentPlatform);
  if (res?.error) statusEl.textContent = res.state?.message || res.error;
  await refresh();
});

btnStop.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "STOP_FROM_POPUP" });
  await refresh();
});

btnCopy.addEventListener("click", async () => {
  const res = await getState();
  const state = res?.state;
  const platform = res?.platform;
  const text = namesToClipboardText(state?.names || [], platform);
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    statusEl.textContent = `Tersalin ${state.names.length} nama. Paste di Excel (Ctrl+V).`;
  } catch {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab?.id) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "COPY_FROM_PAGE" });
        statusEl.textContent = "Disalin lewat halaman. Paste di Excel.";
        return;
      } catch {
        /* fallthrough */
      }
    }
    statusEl.textContent = "Gagal menyalin ke clipboard.";
  }
});

btnReset.addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({ type: "RESET" });
  render(res?.state, currentPlatform);
});

// Listen for state changes from both platforms
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.fnk_state && currentPlatform === "facebook") {
    render(changes.fnk_state.newValue, "facebook");
  }
  if (changes.tnk_state && currentPlatform === "tiktok") {
    render(changes.tnk_state.newValue, "tiktok");
  }
});

// Init
init();

// Backup poll while popup is open
const poll = setInterval(refresh, 1200);
window.addEventListener("unload", () => clearInterval(poll));
