/** Shared pure helpers (background + popup + tests). */

export function normalizeName(raw) {
  if (typeof raw !== "string") return "";
  let name = raw
    .replace(/\u200b|\u200c|\u200d|\ufeff/g, "")
    .replace(/\s+/g, " ")
    .trim();

  name = name.replace(
    /\s+\d+\s*(d|h|m|w|y|jam|menit|hari|minggu|tahun|hr|min|detik|sec|second|minute|hour|day|week|year)s?\b.*$/i,
    ""
  );
  name = name.replace(/\s+[·•|].*$/, "").trim();
  name = name.replace(/\s+Edited$/i, "").trim();

  if (!name) return "";
  if (name.startsWith("@")) return "";
  if (name.length < 2 || name.length > 100) return "";
  if (/^\d+$/.test(name)) return "";
  if (/https?:\/\//i.test(name) || /@\w+\.\w+/.test(name)) return "";

  const blocked = [
    /^view\b/i,
    /^see\b/i,
    /^like\b/i,
    /^reply\b/i,
    /^share\b/i,
    /^comment\b/i,
    /^write\b/i,
    /^log\s*in/i,
    /^sign\s*up/i,
    /^facebook$/i,
    /^meta$/i,
    /^suka$/i,
    /^balas$/i,
    /^bagikan$/i,
    /^komentar$/i,
    /^tulis/i,
    /^lihat/i,
    /^tampilkan/i,
    /^semua$/i,
    /^most relevant$/i,
    /^all comments$/i,
    /^newest$/i,
    /^terbaru$/i,
    /^paling relevan$/i,
    /^edited$/i,
    /^sponsor/i,
    /^follow$/i,
    /^ikuti$/i,
    /^send\b/i,
    /^kirim$/i,
  ];
  if (blocked.some((re) => re.test(name))) return "";
  return name;
}

export function mergeNames(existing, incoming) {
  const map = new Map();
  for (const n of existing || []) {
    const k = normalizeName(n);
    if (k && !map.has(k.toLowerCase())) map.set(k.toLowerCase(), k);
  }
  for (const n of incoming || []) {
    const k = normalizeName(n);
    if (k && !map.has(k.toLowerCase())) map.set(k.toLowerCase(), k);
  }
  return [...map.values()];
}

export function namesToClipboardText(names) {
  return (names || []).map((n) => normalizeName(n)).filter(Boolean).join("\n");
}

export function newRunId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export const STORAGE_KEY = "fnk_state";

/** status: idle | running | done | partial | stopped | error */
export const DEFAULT_STATE = {
  status: "idle",
  names: [],
  count: 0,
  message: "Buka 1 postingan Facebook, lalu klik Proses.",
  tabId: null,
  updatedAt: 0,
  stopReason: null,
  postHint: "",
  includeReplies: true,
  runId: null,
};

export function applyStatePatch(prev, patch) {
  const next = { ...DEFAULT_STATE, ...prev, ...patch, updatedAt: Date.now() };
  if (Array.isArray(next.names)) {
    next.names = mergeNames([], next.names);
    next.count = next.names.length;
  }
  return next;
}

export function reasonToMessage(reason, count) {
  if (reason === "stopped") {
    return count
      ? `Dihentikan — ${count} nama. Klik Copy.`
      : "Dihentikan — belum ada nama.";
  }
  if (reason === "timeout") {
    return count
      ? `Waktu habis — ${count} nama (mungkin belum semua). Klik Copy atau Proses lagi.`
      : "Waktu habis — belum ada nama. Buka komentar, coba lagi.";
  }
  if (reason === "idle") {
    return count
      ? `Selesai (tidak ada komentar baru) — ${count} nama. Klik Copy.`
      : "Tidak ada nama. Pastikan ini halaman 1 post + komentar terlihat.";
  }
  if (reason === "complete") {
    return count
      ? `Selesai — ${count} nama. Klik Copy.`
      : "Tidak ada nama. Pastikan komentar terlihat, lalu coba lagi.";
  }
  if (reason === "error") {
    return "Terjadi error saat ekstrak.";
  }
  return count ? `${count} nama` : "Siap.";
}

export function isStaleRun(stateRunId, msgRunId) {
  if (!msgRunId) return false; // legacy allow
  if (!stateRunId) return false;
  return stateRunId !== msgRunId;
}
