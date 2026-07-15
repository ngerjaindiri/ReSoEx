/** Shared helpers — TikTok Nama Komentar (popup + background + tests) */

export function normalizeName(raw) {
  if (typeof raw !== "string") return "";
  let name = raw
    .replace(/\u200b|\u200c|\u200d|\ufeff/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) return "";
  if (name.startsWith("@") && !name.includes(" ")) name = name.slice(1);
  if (name.length < 1 || name.length > 100) return "";
  if (/^\d+$/.test(name)) return "";
  if (/https?:\/\//i.test(name)) return "";

  const blocked = [
    /^tiktok$/i,
    /^follow$/i,
    /^following$/i,
    /^followers$/i,
    /^like$/i,
    /^reply$/i,
    /^share$/i,
    /^comment$/i,
    /^log\s*in/i,
    /^sign\s*up/i,
    /^ikuti$/i,
    /^suka$/i,
    /^balas$/i,
    /^bagikan$/i,
    /^komentar$/i,
  ];
  if (blocked.some((re) => re.test(name))) return "";
  return name;
}

export function mergeNames(existing, incoming) {
  const map = new Map();
  for (const n of [...(existing || []), ...(incoming || [])]) {
    const k = normalizeName(n);
    if (k && !map.has(k.toLowerCase())) map.set(k.toLowerCase(), k);
  }
  return [...map.values()];
}

export function namesToClipboardText(names) {
  return mergeNames([], names).join("\n");
}

export function extractAwemeId(url) {
  if (!url) return null;
  const patterns = [
    /tiktok\.com\/@[^/]+\/(?:video|photo)\/(\d+)/i,
    /tiktok\.com\/(?:embed|v)\/(\d+)/i,
    /[?&]aweme_id=(\d+)/i,
    /[?&]item_id=(\d+)/i,
    /\/video\/(\d+)/i,
    /\/photo\/(\d+)/i,
  ];
  for (const re of patterns) {
    const m = String(url).match(re);
    if (m) return m[1];
  }
  return null;
}

export function isTikTokUrl(url) {
  try {
    const u = new URL(url);
    return (
      u.hostname === "www.tiktok.com" ||
      u.hostname === "tiktok.com" ||
      u.hostname.endsWith(".tiktok.com")
    );
  } catch {
    return false;
  }
}

export const STORAGE_KEY = "tnk_state";
export const URL_TEMPLATE_KEY = "tnk_comment_url";
export const URL_META_KEY = "tnk_comment_meta";

export function newRunId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export function isStaleRun(stateRunId, msgRunId) {
  if (!msgRunId || !stateRunId) return false;
  return stateRunId !== msgRunId;
}

export const DEFAULT_STATE = {
  status: "idle",
  names: [],
  count: 0,
  message: "Buka video TikTok, buka panel komentar, lalu klik Proses.",
  tabId: null,
  updatedAt: 0,
  stopReason: null,
  videoHint: "",
  includeReplies: false,
  hasTemplate: false,
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

export function reasonToMessage(reason, count, extra = "") {
  const suffix = extra ? ` ${extra}` : "";
  if (reason === "stopped") {
    return count
      ? `Dihentikan — ${count} nama.${suffix} Klik Copy.`
      : `Dihentikan — belum ada nama.${suffix}`;
  }
  if (reason === "timeout") {
    return count
      ? `Waktu habis — ${count} nama (mungkin belum semua).${suffix} Klik Copy.`
      : `Waktu habis — belum ada nama.${suffix}`;
  }
  if (reason === "no_template") {
    return "Belum ada template API komentar. Buka video, klik ikon komentar dulu, tunggu komentar muncul, lalu Proses lagi.";
  }
  if (reason === "no_video") {
    return "Buka halaman video TikTok dulu (URL berisi /video/...), bukan For You feed saja.";
  }
  if (reason === "complete" || reason === "idle") {
    return count
      ? `Selesai — ${count} nama.${suffix} Klik Copy.`
      : `Tidak ada nama.${suffix} Pastikan komentar terbuka & coba lagi.`;
  }
  if (reason === "error") {
    return extra || "Terjadi error saat ekstrak.";
  }
  return count ? `${count} nama` : "Siap.";
}
