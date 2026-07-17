/** Shared pure helpers — Nama Komentar (FB + TikTok unified) */

// ===================== Platform Detection =====================

export function isFacebookUrl(url) {
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

export function isTikTokUrl(url) {
  if (!url) return false;
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

/**
 * Detect which platform a URL belongs to.
 * @returns {"facebook"|"tiktok"|null}
 */
export function detectPlatform(url) {
  if (isFacebookUrl(url)) return "facebook";
  if (isTikTokUrl(url)) return "tiktok";
  return null;
}

// ===================== TikTok Helpers =====================

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

// ===================== Name Normalization =====================

/**
 * Normalize a raw name string, filtering out UI labels, timestamps, URLs, etc.
 * Combined blocked words from both FB and TikTok extensions.
 * @param {string} raw
 * @param {"facebook"|"tiktok"|null} platform
 * @returns {string} normalized name or empty string
 */
export function normalizeName(raw, platform) {
  if (typeof raw !== "string") return "";
  let name = raw
    .replace(/\u200b|\u200c|\u200d|\ufeff/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // TikTok: strip leading @ for handles
  if (platform === "tiktok") {
    if (name.startsWith("@") && !name.includes(" ")) name = name.slice(1);
  }

  // FB: strip timestamp suffixes
  if (platform === "facebook" || !platform) {
    name = name
      // 1) Indonesian non-numeric: "sehari yang lalu", "sekitar satu jam yang lalu"
      .replace(
        /\s+(sekitar\s+)?(satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan|sepuluh|beberapa)\s+(jam|menit|detik|hari|minggu|tahun|bulan)\s+(yang\s+lalu|lalu).*$/i,
        ""
      )
      .replace(
        /\s+(sehari|semenit|sejam|setahun|seminggu|sebulan)\s+(yang\s+lalu|lalu).*$/i,
        ""
      )
      .replace(
        /\s+\d+\s+(jam|menit|detik|hari|minggu|tahun|bulan)\s+(yang\s+lalu|lalu).*$/i,
        ""
      )
      // 2) English: "about 3 hours ago", "a minute ago", "just now"
      .replace(
        /\s+(about\s+)?(a|an|\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago.*$/i,
        ""
      )
      .replace(/\s+just\s+now.*$/i, "")
      // 3) Generic numeric: "3d", "5h", "2 jam" (run LAST so specific patterns match first)
      .replace(
        /\s+\d+\s*(d|h|m|w|y|jam|menit|hari|minggu|tahun|bulan|hr|min|detik|sec|second|minute|hour|day|week|month|year)s?\b.*$/i,
        ""
      )
      .replace(/\s+[·•|].*$/, "")
      .replace(/\s+Edited$/i, "")
      .trim();
    if (/\bis with\b/i.test(name)) name = name.split(/\bis with\b/i)[0].trim();
  }

  if (!name) return "";
  if (platform !== "tiktok" && name.startsWith("@")) return "";
  if (platform === "tiktok") {
    if (name.length < 1 || name.length > 100) return "";
  } else {
    if (name.length < 2 || name.length > 100) return "";
  }
  if (/^\d+$/.test(name)) return "";
  // URLs with protocol
  if (/https?:\/\//i.test(name) || /@\w+\.\w+/.test(name)) return "";
  // Short URLs without protocol
  if (/^(wa\.me|bit\.ly|t\.co|goo\.gl|tinyurl\.com|s\.id|link\.)\b/i.test(name)) return "";
  if (/\b(wa\.me|bit\.ly|t\.co)\b/i.test(name)) return "";
  // Generic domain/path pattern
  if (/^[a-z0-9][-a-z0-9]*\.[a-z]{2,6}\//i.test(name)) return "";

  // Combined blocked words from FB + TikTok (UI navigation only, not content words)
  const blocked = [
    /^view\b/i, /^see\b/i, /^like\b/i, /^likes$/i, /^reply\b/i, /^share\b/i,
    /^comment\b/i, /^write\b/i, /^log\s*in/i, /^sign\s*up/i, /^facebook$/i,
    /^meta$/i, /^suka$/i, /^balas$/i, /^bagikan$/i, /^komentar$/i, /^tulis/i,
    /^lihat/i, /^tampilkan/i, /^semua$/i, /^most relevant$/i, /^all comments$/i,
    /^newest$/i, /^terbaru$/i, /^paling relevan$/i, /^edited$/i, /^sponsor/i,
    /^follow$/i, /^following$/i, /^followers$/i, /^ikuti$/i, /^send\b/i,
    /^kirim$/i, /^hide\b/i, /^open\b/i, /^photo$/i, /^video$/i, /^reels?$/i,
    /^add a comment/i, /^tulis komentar/i, /^write a comment/i,
    /^see more$/i, /^lihat selengkapnya$/i,
    /^tiktok$/i,
  ];
  if (blocked.some((re) => re.test(name))) return "";
  return name;
}

// ===================== Name Merge & Clipboard =====================

export function mergeNames(existing, incoming, platform) {
  const map = new Map();
  for (const n of existing || []) {
    const k = normalizeName(n, platform);
    if (k && !map.has(k.toLowerCase())) map.set(k.toLowerCase(), k);
  }
  for (const n of incoming || []) {
    const k = normalizeName(n, platform);
    if (k && !map.has(k.toLowerCase())) map.set(k.toLowerCase(), k);
  }
  return [...map.values()];
}

export function namesToClipboardText(names, platform) {
  return (names || [])
    .map((n) => normalizeName(n, platform))
    .filter(Boolean)
    .join("\n");
}

// ===================== Run ID =====================

export function newRunId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Reject progress/done from a different run, or messages missing runId
 * while a run is already active.
 */
export function isStaleRun(stateRunId, msgRunId) {
  if (!stateRunId) return false;
  if (!msgRunId) return true;
  return stateRunId !== msgRunId;
}

// ===================== Storage Keys =====================

// Facebook
export const STORAGE_KEY_FB = "fnk_state";

// TikTok — template lives in session storage (not permanent local)
export const STORAGE_KEY_TT = "tnk_state";
export const URL_TEMPLATE_KEY = "tnk_comment_url";
export const URL_META_KEY = "tnk_comment_meta";
/** Max age for a captured comment-list URL template */
export const TEMPLATE_TTL_MS = 45 * 60 * 1000;

/**
 * Get the storage key for a platform.
 * @param {"facebook"|"tiktok"} platform
 */
export function storageKeyFor(platform) {
  return platform === "tiktok" ? STORAGE_KEY_TT : STORAGE_KEY_FB;
}

/**
 * Strip short-lived signing params before persisting a TikTok API URL.
 * @param {string} url
 * @returns {string|null}
 */
export function sanitizeTikTokTemplateUrl(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const u = new URL(url);
    for (const key of [
      "msToken",
      "X-Bogus",
      "X-Gnarly",
      "X-Dynosaur",
      "_signature",
      "signature",
    ]) {
      u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Validate a stored TikTok comment API template.
 * @param {string|null|undefined} url
 * @param {{capturedAt?: number, awemeId?: string|null}|null|undefined} meta
 * @param {string|null} [requiredAwemeId] if set, meta.awemeId must match when present
 * @returns {boolean}
 */
export function isTikTokTemplateValid(url, meta, requiredAwemeId = null) {
  if (!url || typeof url !== "string") return false;
  if (!url.toLowerCase().includes("tiktok.com/api/comment/list")) return false;
  if (url.toLowerCase().includes("tiktok.com/api/comment/list/reply")) return false;
  const capturedAt = meta?.capturedAt;
  if (!capturedAt || typeof capturedAt !== "number") return false;
  if (Date.now() - capturedAt > TEMPLATE_TTL_MS) return false;
  if (
    requiredAwemeId &&
    meta?.awemeId &&
    String(meta.awemeId) !== String(requiredAwemeId)
  ) {
    return false;
  }
  return true;
}

// ===================== Default State =====================

export const DEFAULT_STATE_FB = {
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

export const DEFAULT_STATE_TT = {
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

export function defaultStateFor(platform) {
  return platform === "tiktok"
    ? { ...DEFAULT_STATE_TT }
    : { ...DEFAULT_STATE_FB };
}

// ===================== State Patch =====================

export function applyStatePatch(prev, patch, platform) {
  const def = defaultStateFor(platform);
  const next = { ...def, ...prev, ...patch, updatedAt: Date.now() };
  if (Array.isArray(next.names)) {
    next.names = mergeNames([], next.names, platform);
    next.count = next.names.length;
  }
  return next;
}

// ===================== Reason → Message =====================

export function reasonToMessage(reason, count, platform, extra) {
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
  if (reason === "idle") {
    return count
      ? `Selesai (tidak ada komentar baru) — ${count} nama.${suffix} Klik Copy.`
      : "Tidak ada nama. Pastikan komentar terlihat, lalu coba lagi.";
  }
  if (reason === "complete") {
    return count
      ? `Selesai — ${count} nama.${suffix} Klik Copy.`
      : "Tidak ada nama. Pastikan komentar terlihat, lalu coba lagi.";
  }
  if (reason === "error") {
    return extra || "Terjadi error saat ekstrak.";
  }

  // TikTok-specific reasons
  if (reason === "no_template") {
    return "Belum ada template API komentar. Buka video, klik ikon komentar dulu, tunggu komentar muncul, lalu Proses lagi.";
  }
  if (reason === "no_video") {
    return "Buka halaman video TikTok dulu (URL berisi /video/...), bukan For You feed saja.";
  }

  return count ? `${count} nama` : "Siap.";
}
