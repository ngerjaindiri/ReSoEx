import { namesToClipboardText } from "./shared.js";

const $ = (id) => document.getElementById(id);

const statusEl = $("status");
const hintEl = $("hint");
const badgeEl = $("badge");
const countEl = $("count");
const previewEl = $("preview");
const btnProcess = $("btnProcess");
const btnStop = $("btnStop");
const btnCopy = $("btnCopy");
const btnReset = $("btnReset");
const includeRepliesEl = $("includeReplies");

function render(state) {
  if (!state) return;
  statusEl.textContent = state.message || "";
  hintEl.textContent = state.videoHint
    ? `Video: ${state.videoHint}`
    : "Target: tab TikTok aktif";
  badgeEl.textContent = state.hasTemplate
    ? "API komentar: siap"
    : "API komentar: belum — buka panel komentar";
  badgeEl.classList.toggle("ok", !!state.hasTemplate);

  const n = state.count ?? (state.names || []).length;
  countEl.textContent = `${n} nama`;
  if (typeof state.includeReplies === "boolean") {
    includeRepliesEl.checked = state.includeReplies;
  }

  const names = state.names || [];
  if (names.length) {
    previewEl.hidden = false;
    const show = names.slice(0, 40);
    previewEl.textContent =
      show.join("\n") + (names.length > 40 ? `\n… +${names.length - 40} lagi` : "");
  } else {
    previewEl.hidden = true;
    previewEl.textContent = "";
  }

  const running = state.status === "running";
  btnProcess.disabled = running;
  btnProcess.textContent = running ? "Memproses…" : "Proses";
  btnStop.hidden = !running;
  btnCopy.disabled = names.length === 0;
  btnCopy.textContent = names.length ? `Copy nama (${names.length})` : "Copy nama";
  document.body.dataset.status = state.status || "idle";
}

async function getState() {
  const res = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  return res?.state;
}

async function refresh() {
  try {
    render(await getState());
  } catch (e) {
    statusEl.textContent = String(e?.message || e);
  }
}

btnProcess.addEventListener("click", async () => {
  btnProcess.disabled = true;
  const res = await chrome.runtime.sendMessage({
    type: "START_FROM_POPUP",
    includeReplies: includeRepliesEl.checked,
  });
  if (res?.state) render(res.state);
  if (res?.error && res?.state?.message) statusEl.textContent = res.state.message;
  await refresh();
});

btnStop.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "STOP_FROM_POPUP" });
  await refresh();
});

btnCopy.addEventListener("click", async () => {
  const state = await getState();
  const text = namesToClipboardText(state?.names || []);
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    statusEl.textContent = `Tersalin ${state.names.length} nama. Paste di Excel (Ctrl+V).`;
  } catch {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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
  render(res?.state);
});

chrome.storage.session.onChanged.addListener((changes, area) => {
  if (area !== "session") return;
  if (changes.tnk_state) render(changes.tnk_state.newValue);
});

refresh();
const poll = setInterval(refresh, 1200);
window.addEventListener("unload", () => clearInterval(poll));
