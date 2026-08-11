/**
 * Options page — default "sertakan balasan" per platform + tema.
 * Menyimpan ke chrome.storage.local dengan key yang sama (PREFS_KEY = "rsx_prefs")
 * yang dipakai popup, background (shortcut/context menu), dan content scripts.
 */
import { PREFS_KEY } from "./shared.js";

const $ = (id) => document.getElementById(id);

const optFb = $("optFb");
const optTt = $("optTt");
const optIg = $("optIg");
const btnRestore = $("btnRestore");
const toast = $("toast");

const DEFAULT_PREFS = {
  includeReplies: { facebook: true, tiktok: false, instagram: false },
  theme: "system",
};

let toastTimer = null;
function showToast(text) {
  toast.textContent = text;
  toast.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 1800);
}

/** Apply the chosen theme to THIS page (live preview) + resolve "system". */
function applyTheme(theme) {
  const t =
    theme === "light" || theme === "dark"
      ? theme
      : window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  document.body.dataset.theme = t;
}

function currentTheme() {
  const checked = document.querySelector('input[name="theme"]:checked');
  const t = checked?.value;
  return t === "light" || t === "dark" || t === "system" ? t : "system";
}

/**
 * Highlight the selected theme segment. Uses a class (not :has()) so the
 * control works on every supported Chrome version.
 */
function syncSegs() {
  document.querySelectorAll(".seg").forEach((seg) => {
    const input = seg.querySelector("input");
    seg.classList.toggle("selected", !!input?.checked);
  });
}

async function save() {
  const next = {
    includeReplies: {
      facebook: optFb.checked,
      tiktok: optTt.checked,
      instagram: optIg.checked,
    },
    theme: currentTheme(),
  };
  await chrome.storage.local.set({ [PREFS_KEY]: next });
  showToast("Tersimpan");
}

async function load() {
  const data = await chrome.storage.local.get(PREFS_KEY);
  const prefs = { ...DEFAULT_PREFS, ...(data[PREFS_KEY] || {}) };
  const inc = prefs.includeReplies || {};
  optFb.checked = typeof inc.facebook === "boolean" ? inc.facebook : true;
  optTt.checked = typeof inc.tiktok === "boolean" ? inc.tiktok : false;
  optIg.checked = typeof inc.instagram === "boolean" ? inc.instagram : false;
  const theme = prefs.theme === "light" || prefs.theme === "dark" ? prefs.theme : "system";
  const radio = document.querySelector(`input[name="theme"][value="${theme}"]`);
  if (radio) radio.checked = true;
  syncSegs();
  applyTheme(theme);
}

// Auto-save on every change
optFb.addEventListener("change", save);
optTt.addEventListener("change", save);
optIg.addEventListener("change", save);
document.querySelectorAll('input[name="theme"]').forEach((radio) => {
  radio.addEventListener("change", async () => {
    syncSegs();
    await save();
    applyTheme(currentTheme());
  });
});

btnRestore.addEventListener("click", async () => {
  optFb.checked = DEFAULT_PREFS.includeReplies.facebook;
  optTt.checked = DEFAULT_PREFS.includeReplies.tiktok;
  optIg.checked = DEFAULT_PREFS.includeReplies.instagram;
  const radio = document.querySelector(
    `input[name="theme"][value="${DEFAULT_PREFS.theme}"]`
  );
  if (radio) radio.checked = true;
  syncSegs();
  await chrome.storage.local.set({ [PREFS_KEY]: DEFAULT_PREFS });
  applyTheme(DEFAULT_PREFS.theme);
  showToast("Default dipulihkan");
});

// Live preview when the OS theme changes and user chose "system"
window
  .matchMedia("(prefers-color-scheme: dark)")
  .addEventListener("change", async () => {
    const data = await chrome.storage.local.get(PREFS_KEY);
    applyTheme(data[PREFS_KEY]?.theme || "system");
  });

load();
