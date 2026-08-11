/**
 * Popup script — Nama Komentar (FB + TikTok unified)
 * Detects platform from active tab, renders adaptive UI.
 */
import {
  namesToClipboardText,
  detectPlatform,
  mergeAcrossPlatforms,
  filterNames,
  sortNamesAz,
  csvContent,
  downloadTextFile,
  isFacebookPostPage,
  wordFor,
  SAVED_KEY,
  PREFS_KEY,
  STORAGE_KEY_FB,
  STORAGE_KEY_TT,
  STORAGE_KEY_IG,
} from "./shared.js";

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
const btnCsv = $("btnCsv");
const btnMerge = $("btnMerge");
const btnBackup = $("btnBackup");
const btnRestore = $("btnRestore");
const fileRestore = $("fileRestore");
const btnSort = $("btnSort");
const searchInput = $("searchInput");
const includeRepliesEl = $("includeReplies");
const platformBadge = $("platformBadge");
const btnOptions = $("btnOptions");

const headerTitle = $("headerTitle");
const headerSub = $("headerSub");
const stepsFb = $("stepsFb");
const stepsTt = $("stepsTt");
const stepsIg = $("stepsIg");
const noSupport = $("noSupport");

let currentPlatform = null;
/** URL tab aktif saat popup dibuka — dipakai badge API FB (halaman post?). */
let currentTabUrl = "";
/** When true, do not overwrite checkbox from state (user is editing). */
let repliesDirty = false;
/** Name filter (live search box) + sort — affect preview / Copy / CSV only. */
let query = "";
let sortAz = false;

function visibleNames(names) {
  let out = filterNames(names, query);
  if (sortAz) out = sortNamesAz(out);
  return out;
}

function setPlatformUI(platform) {
  const platformChanged = platform !== currentPlatform;
  currentPlatform = platform;
  document.body.dataset.platform = platform || "";

  if (platform === "facebook") {
    platformBadge.textContent = "📘 Facebook";
    headerTitle.textContent = "ReSo Ekstention";
    headerSub.textContent = "FB — Nama komentator → copy ke Excel";
    searchInput.placeholder = "Cari nama…";
    searchInput.setAttribute("aria-label", "Cari nama");
    stepsFb.hidden = false;
    stepsTt.hidden = true;
    stepsIg.hidden = true;
    noSupport.hidden = true;
    apiBadgeEl.hidden = true;
    // Only reset replies when switching platforms
    if (platformChanged) {
      includeRepliesEl.checked = true;
      repliesDirty = false;
    }
    if (currentPlatform) btnProcess.disabled = false;
  } else if (platform === "tiktok") {
    platformBadge.textContent = "🎵 TikTok";
    headerTitle.textContent = "ReSo Ekstention";
    headerSub.textContent = "TikTok — Nickname komentator → copy ke Excel";
    searchInput.placeholder = "Cari nama…";
    searchInput.setAttribute("aria-label", "Cari nama");
    stepsFb.hidden = true;
    stepsTt.hidden = false;
    stepsIg.hidden = true;
    noSupport.hidden = true;
    apiBadgeEl.hidden = false;
    if (platformChanged) {
      includeRepliesEl.checked = false;
      repliesDirty = false;
    }
    if (currentPlatform) btnProcess.disabled = false;
  } else if (platform === "instagram") {
    platformBadge.textContent = "📸 Instagram";
    headerTitle.textContent = "ReSo Ekstention";
    headerSub.textContent = "IG — Username komentator → copy ke Excel";
    searchInput.placeholder = "Cari username…";
    searchInput.setAttribute("aria-label", "Cari username");
    stepsFb.hidden = true;
    stepsTt.hidden = true;
    stepsIg.hidden = false;
    noSupport.hidden = true;
    apiBadgeEl.hidden = false;
    if (platformChanged) {
      includeRepliesEl.checked = false;
      repliesDirty = false;
    }
    if (currentPlatform) btnProcess.disabled = false;
  } else {
    platformBadge.textContent = "⚠️ Platform tidak didukung";
    headerTitle.textContent = "ReSo Ekstention";
    headerSub.textContent = "Buka tab Facebook / TikTok / Instagram untuk mulai";
    stepsFb.hidden = true;
    stepsTt.hidden = true;
    stepsIg.hidden = true;
    noSupport.hidden = false;
    apiBadgeEl.hidden = true;
    btnProcess.disabled = true;
  }
}

function render(state, platform) {
  // platform may be null when tab is not FB/TT/IG
  if (platform !== undefined) setPlatformUI(platform);
  const p = platform || currentPlatform;
  if (!state) {
    statusEl.textContent =
      platform === null || platform === undefined
        ? "Buka tab Facebook, TikTok, atau Instagram untuk mulai."
        : "Memuat…";
    hintEl.textContent = "";
    countEl.textContent = `0 ${wordFor(p)}`;
    previewEl.hidden = true;
    previewEl.textContent = "";
    btnStop.hidden = true;
    btnCopy.disabled = true;
    btnCopy.textContent = `Copy ${wordFor(p)}`;
    if (btnCsv) btnCsv.disabled = true;
    if (btnMerge) btnMerge.disabled = true;
    if (apiBadgeEl) apiBadgeEl.hidden = true;
    document.body.dataset.status = "idle";
    return;
  }

  statusEl.textContent = state.message || "";

  // Hint — sembunyikan detail teknis (template/aweme id/media id) saat run
  // selesai; baris status sudah menjelaskan hasilnya.
  const terminal = ["done", "partial", "stopped", "error"].includes(state.status);
  const isTt = platform === "tiktok" || currentPlatform === "tiktok";
  const isIg = platform === "instagram" || currentPlatform === "instagram";
  if (terminal) {
    hintEl.textContent = "";
  } else if (isTt) {
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
  } else if (isIg) {
    hintEl.textContent = state.postHint
      ? `Target: ${state.postHint}`
      : "Target: post/reel di tab aktif";
    // API badge (same replay pattern as TikTok)
    if (apiBadgeEl) {
      apiBadgeEl.hidden = false;
      apiBadgeEl.textContent = state.hasTemplate
        ? "API komentar: siap"
        : "API komentar: belum — buka komentar & pastikan login";
      apiBadgeEl.classList.toggle("ok", !!state.hasTemplate);
    }
  } else {
    hintEl.textContent = state.postHint
      ? `Target: ${state.postHint}`
      : "Target: post di tab aktif";
    // Badge API (konsisten dengan TikTok/Instagram): siap saat halaman post
    // permalink — engine FB bisa bangun synthetic GraphQL template dari URL.
    if (apiBadgeEl) {
      const fbReady = isFacebookPostPage(currentTabUrl);
      apiBadgeEl.hidden = false;
      apiBadgeEl.textContent = fbReady
        ? "API komentar: siap"
        : "API komentar: belum — buka permalink post";
      apiBadgeEl.classList.toggle("ok", fbReady);
    }
  }

  // Count — saat filter aktif tampilkan "X dari N" agar jelas kenapa
  // tombol Copy bisa nonaktif walau ada hasil.
  const names = state.names || [];
  const vis = visibleNames(names);
  const n = state.count ?? names.length;
  countEl.textContent = query.trim()
    ? `${vis.length} dari ${n} ${wordFor(p)}`
    : `${n} ${wordFor(p)}`;

  // Include replies — only sync from state if user hasn't toggled locally
  if (!repliesDirty && typeof state.includeReplies === "boolean") {
    includeRepliesEl.checked = state.includeReplies;
  }

  // Preview (respects filter & sort)
  const shownTotal = query.trim() ? vis.length : names.length;
  if (vis.length) {
    previewEl.hidden = false;
    const show = vis.slice(0, 40);
    previewEl.textContent =
      show.join("\n") + (vis.length > 40 ? `\n… +${vis.length - 40} lagi` : "");
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
  btnCopy.disabled = vis.length === 0;
  btnCopy.textContent = vis.length
    ? `Copy ${wordFor(p)} (${shownTotal})`
    : `Copy ${wordFor(p)}`;
  if (btnCsv) btnCsv.disabled = vis.length === 0;
  if (btnMerge) btnMerge.disabled = false;

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
    currentTabUrl = tab?.url || "";
    const platform = detectPlatform(currentTabUrl);
    setPlatformUI(platform);
  } catch {
    setPlatformUI(null);
  }
  applyTheme();
  await refresh();
}

/** Apply theme chosen in Options (rsx_prefs.theme) to the popup. */
async function applyTheme() {
  try {
    const data = await chrome.storage.local.get(PREFS_KEY);
    const theme = data[PREFS_KEY]?.theme || "system";
    const resolved =
      theme === "light" || theme === "dark"
        ? theme
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
    document.body.dataset.theme = resolved;
  } catch {
    /* cosmetic */
  }
}

// ---- Event Listeners ----

if (btnOptions) {
  btnOptions.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
}

btnProcess.addEventListener("click", async () => {
  btnProcess.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({
      type: "START_FROM_POPUP",
      includeReplies: includeRepliesEl.checked,
    });
    if (res?.state) render(res.state, currentPlatform);
    if (res?.error) {
      statusEl.textContent =
        res.message || res.state?.message || res.error;
    }
  } catch (e) {
    statusEl.textContent = String(e?.message || e);
  }
  await refresh();
});

btnStop.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "STOP_FROM_POPUP" });
  await refresh();
});

includeRepliesEl.addEventListener("change", () => {
  repliesDirty = true;
  // Persist preference so poll/refresh does not fight the user
  chrome.runtime
    .sendMessage({
      type: "SET_STATE",
      patch: { includeReplies: includeRepliesEl.checked },
    })
    .catch(() => {});
});

btnCopy.addEventListener("click", async () => {
  const res = await getState();
  const state = res?.state;
  const platform = res?.platform;
  const text = namesToClipboardText(visibleNames(state?.names || []), platform);
  if (!text) return;
  const copiedCount = text.split("\n").filter(Boolean).length;
  try {
    await navigator.clipboard.writeText(text);
    statusEl.textContent = `Tersalin ${copiedCount} ${wordFor(platform)}. Paste di Excel (Ctrl+V).`;
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
  repliesDirty = false;
  const res = await chrome.runtime.sendMessage({ type: "RESET" });
  render(res?.state, currentPlatform ?? res?.platform);
});

btnCsv.addEventListener("click", async () => {
  const res = await getState();
  const names = visibleNames(res?.state?.names || []);
  if (!names.length) return;
  const date = new Date().toISOString().slice(0, 10);
  const isIg = res?.platform === "instagram";
  const stem = isIg ? "username" : "nama";
  // csvContent: \uFEFF (BOM) agar Excel membaca UTF-8 dengan benar
  downloadTextFile(
    `reso-${stem}-${date}.csv`,
    csvContent(names, isIg),
    "text/csv;charset=utf-8"
  );
  statusEl.textContent = `CSV tersimpan: ${names.length} ${wordFor(res?.platform || currentPlatform)}.`;
});

btnSort.addEventListener("click", () => {
  sortAz = !sortAz;
  btnSort.textContent = sortAz ? "Urutkan asli" : "Urutkan A-Z";
  refresh();
});

searchInput.addEventListener("input", () => {
  query = searchInput.value;
  refresh();
});

btnBackup.addEventListener("click", async () => {
  try {
    const data = await chrome.storage.local.get([SAVED_KEY, PREFS_KEY]);
    const date = new Date().toISOString().slice(0, 10);
    downloadTextFile(
      `reso-backup-${date}.json`,
      JSON.stringify(data, null, 2),
      "application/json"
    );
    statusEl.textContent = "Backup tersimpan (JSON).";
  } catch {
    statusEl.textContent = "Gagal membuat backup.";
  }
});

btnRestore.addEventListener("click", () => fileRestore.click());

fileRestore.addEventListener("change", async () => {
  const file = fileRestore.files?.[0];
  fileRestore.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data !== "object") throw new Error("bad");
    const patch = {};
    if (data[SAVED_KEY] && typeof data[SAVED_KEY] === "object") {
      patch[SAVED_KEY] = data[SAVED_KEY];
    }
    if (data[PREFS_KEY] && typeof data[PREFS_KEY] === "object") {
      patch[PREFS_KEY] = data[PREFS_KEY];
    }
    if (!patch[SAVED_KEY] && !patch[PREFS_KEY]) throw new Error("empty");
    await chrome.storage.local.set(patch);
    statusEl.textContent =
      "Backup dipulihkan. Buka tab FB/TikTok untuk melihat hasilnya.";
    await refresh();
  } catch {
    statusEl.textContent = "File backup tidak valid.";
  }
});

btnMerge.addEventListener("click", async () => {
  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "GET_ALL_STATE" });
  } catch {
    statusEl.textContent = "Gagal mengambil hasil.";
    return;
  }
  const fb = res?.facebook?.names || [];
  const tt = res?.tiktok?.names || [];
  const ig = res?.instagram?.names || [];
  // Normalisasi per platform: aturan FB tidak boleh diterapkan ke nama
  // TikTok/Instagram (mis. @handle & emoji TikTok, atau spasi di nama FB).
  const merged = mergeAcrossPlatforms([
    { platform: "facebook", names: fb },
    { platform: "tiktok", names: tt },
    { platform: "instagram", names: ig },
  ]);
  if (!merged.length) {
    statusEl.textContent = "Belum ada hasil di Facebook, TikTok, maupun Instagram.";
    return;
  }
  try {
    await navigator.clipboard.writeText(merged.join("\n"));
    statusEl.textContent = `Gabung: ${merged.length} nama unik tersalin. Paste di Excel.`;
  } catch {
    statusEl.textContent = `Gabung: ${merged.length} nama unik. Buka hasil lalu Copy per platform.`;
  }
});

// Listen for state changes from both platforms
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes[STORAGE_KEY_FB] && currentPlatform === "facebook") {
    render(changes[STORAGE_KEY_FB].newValue, "facebook");
  }
  if (changes[STORAGE_KEY_TT] && currentPlatform === "tiktok") {
    render(changes[STORAGE_KEY_TT].newValue, "tiktok");
  }
  if (changes[STORAGE_KEY_IG] && currentPlatform === "instagram") {
    render(changes[STORAGE_KEY_IG].newValue, "instagram");
  }
});

// Theme may change while the popup is open (Options in another tab)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[PREFS_KEY]) applyTheme();
});

// Init
init();

// Satu sumber render: storage.session.onChanged sudah memicu pada setiap
// setState dari background — tidak perlu poll cadangan 1,2 dtk.
