/** Shared pure helpers — Nama Komentar (FB + TikTok + Instagram unified) */

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

export function isInstagramUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return (
      u.hostname === "www.instagram.com" ||
      u.hostname === "instagram.com" ||
      u.hostname.endsWith(".instagram.com")
    );
  } catch {
    return false;
  }
}

/**
 * Detect which platform a URL belongs to.
 * @returns {"facebook"|"tiktok"|"instagram"|null}
 */
export function detectPlatform(url) {
  if (isFacebookUrl(url)) return "facebook";
  if (isTikTokUrl(url)) return "tiktok";
  if (isInstagramUrl(url)) return "instagram";
  return null;
}

// ===================== Facebook Helpers =====================

// BEGIN-RESO-FBURLS
/**
 * SINGLE SOURCE OF TRUTH untuk deteksi permalink Facebook — dipakai badge
 * panel (isFacebookPostPage), synthetic template engine (extractFbFeedbackIds),
 * dan pre-check. Disalin byte-identik ke inject-fb.js & content-fb.js; dijamin   * fixture test FBURLS. Mengembalikan kandidat story/feedback id dari URL;
   * engine mem-probe tiap kandidat (urutan = prioritas) dan memakai yang benar
   * menghasilkan page_info — robust terhadap bentuk URL yang id-nya ambigu
   * (mis. album `set=a.X.Y.Z`, postingan multi-foto `set=pcb.<story>`,
   * dan `photos/a.<uid>.<fbid>`).
   */
function extractFbFeedbackIds(url) {
  const out = [];
  const add = (id) => {
    if (typeof id !== "string" || !/^[A-Za-z0-9]{8,}$/.test(id)) return;
    if (!out.includes(id)) out.push(id);
  };
  if (!url || typeof url !== "string") return out;
  const href = url;

  // 1) Bentuk path yang membawa story/feedback id
  const direct = [
    /\/posts\/[^/?#]+\/([^/?#]+)/, // posts/<slug>/<id> (gaya baru)
    /\/posts\/([^/?#]+)/, // posts/<id> (klasik & grup)
    /\/permalink\.php\?story_fbid=([^&#]+)/,
    /\/story\.php\?story_fbid=([^&#]+)/,
    /\/photos\/a\.\d+\.(\d+)/, // photos/a.<uid>.<fbid> (album foto)
    /\/photos\/(\d+)/, // foto tunggal (id foto — probe memvalidasi)
    /\/videos\/(\d+)/,
    /\/reel\/(\d+)/,
    /\/video\.php\?v=(\d+)/,
  ];
  for (const re of direct) {
    const m = href.match(re);
    if (m) add(m[1]);
  }

  // 2) Watch (query v=) — bentuk paling umum untuk permalink video
  const watch = href.match(/\/watch(?:[^?#]*\?|\?)[^#]*\bv=(\d+)/i);
  if (watch) add(watch[1]);    // 3) Param umum (story_fbid/fbid/v, termasuk nilai pfbid alfanumerik)
    //    + set: pcb.<story> = postingan multi-foto (id-nya feedback/story id,
    //      prioritas tinggi karena `fbid` di URL tersebut id foto, bukan story)
    //      dan a.<album>.<user>.<story> (komponen terakhir = story id)
    try {
      const u = new URL(href);
      for (const key of ["story_fbid"]) {
        const val = u.searchParams.get(key);
        if (val) add(val);
      }
      const set = u.searchParams.get("set") || "";
      const parts = String(set).split(".");
      if (parts[0] === "pcb" && parts.length >= 2) add(parts[parts.length - 1]);
      for (const key of ["fbid", "v"]) {
        const val = u.searchParams.get(key);
        if (val) add(val);
      }
      if (parts[0] === "a" && parts.length >= 4) add(parts[3]);
    } catch {
      /* ignore */
    }
  return out;
}

/** Kandidat pertama (prioritas tertinggi). */
function extractFbFeedbackId(url) {
  const ids = extractFbFeedbackIds(url);
  return ids.length ? ids[0] : null;
}

/** Apakah URL adalah halaman post permalink FB yang didukung engine? */
function isFacebookPostPage(url) {
  return extractFbFeedbackIds(url).length > 0;
}
// END-RESO-FBURLS

export { extractFbFeedbackIds, extractFbFeedbackId, isFacebookPostPage };

// ===================== Instagram Helpers =====================

/** Extract the shortcode from an Instagram post/reel URL (for UI hints only). */
export function extractInstagramShortcode(url) {
  if (!url) return null;
  const m = String(url).match(
    /instagram\.com\/(?:share\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i
  );
  return m ? m[1] : null;
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
// The three blocks below (normalizeCommentName / normalizeNickname /
// normalizeInstagramUsername) are the SINGLE SOURCE OF TRUTH for name
// normalization. The MAIN-world engines (inject-fb.js, inject-tiktok.js,
// inject-ig.js) and content scripts (content-fb.js, content-tiktok.js,
// content-ig.js) carry byte-identical copies inside the marker blocks the
// fixture test (tests/normalization-fixture.test.mjs) reads and compares.

// BEGIN-RESO-NORMALIZE
function normalizeCommentName(raw) {
  if (typeof raw !== "string") return "";
  let name = raw
    .replace(/\u200b|\u200c|\u200d|\ufeff/g, "")
    .replace(/\s+/g, " ")
    .trim();
  name = name.replace(/\s+[·•|].*$/, "").trim();
  name = name.replace(
    /\s+(sekitar\s+)?(satu|dua|tiga|empat|lima|enam|tujuh|delapan|sembilan|sepuluh|beberapa)\s+(jam|menit|detik|hari|minggu|tahun|bulan)\s+(yang\s+lalu|lalu).*$/i,
    ""
  );
  name = name.replace(
    /\s+(sehari|semenit|sejam|setahun|seminggu|sebulan)\s+(yang\s+lalu|lalu).*$/i,
    ""
  );
  name = name.replace(
    /\s+\d+\s+(jam|menit|detik|hari|minggu|tahun|bulan)\s+(yang\s+lalu|lalu).*$/i,
    ""
  );
  name = name.replace(
    /\s+(about\s+)?(a|an|\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago.*$/i,
    ""
  );
  name = name.replace(/\s+just\s+now.*$/i, "");
  name = name.replace(
    /\s+\d+\s*(d|h|m|w|y|jam|menit|hari|minggu|tahun|bulan|hr|min|detik|sec|second|minute|hour|day|week|month|year)s?\b.*$/i,
    ""
  );
  name = name.replace(/\s+Edited$/i, "").trim();
  if (/\bis with\b/i.test(name)) name = name.split(/\bis with\b/i)[0].trim();
  if (!name) return "";
  if (name.length < 2 || name.length > 100) return "";
  if (name.startsWith("@")) return "";
  if (/^\d+$/.test(name)) return "";
  if (/https?:\/\//i.test(name) || /@\w+\.\w+/.test(name)) return "";
  if (/^(wa\.me|bit\.ly|t\.co|goo\.gl|tinyurl\.com|s\.id|link\.)\b/i.test(name)) return "";
  if (/\b(wa\.me|bit\.ly|t\.co)\b/i.test(name)) return "";
  if (/^[a-z0-9][-a-z0-9]*\.[a-z]{2,6}\//i.test(name)) return "";
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
  try {
    if (!/[\p{L}\p{N}]/u.test(name)) return "";
  } catch {
    if (!/[a-zA-Z0-9\u00C0-\u024F]/.test(name)) return "";
  }
  return name;
}
// END-RESO-NORMALIZE

// BEGIN-RESO-NORMALIZE
function normalizeNickname(raw) {
  if (typeof raw !== "string") return "";
  let name = raw
    .replace(/\u200b|\u200c|\u200d|\ufeff/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) return "";
  if (name.startsWith("@") && !name.includes(" ")) name = name.slice(1);
  if (name.length < 1 || name.length > 100) return "";
  if (/^\d+$/.test(name)) return "";
  if (/https?:\/\//i.test(name) || /@\w+\.\w+/.test(name)) return "";
  if (/^(wa\.me|bit\.ly|t\.co|goo\.gl|tinyurl\.com|s\.id|link\.)\b/i.test(name)) return "";
  if (/\b(wa\.me|bit\.ly|t\.co)\b/i.test(name)) return "";
  if (/^[a-z0-9][-a-z0-9]*\.[a-z]{2,6}\//i.test(name)) return "";
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
// END-RESO-NORMALIZE

// BEGIN-RESO-NORMALIZE
function normalizeInstagramUsername(raw) {
  if (typeof raw !== "string") return "";
  let u = raw.replace(/\u200b|\u200c|\u200d|\ufeff/g, "").trim();
  if (/\s/.test(u)) return "";
  if (u.startsWith("@")) u = u.slice(1);
  u = u.trim();
  if (!u) return "";
  if (!/^[a-zA-Z0-9._]{1,30}$/.test(u)) return "";
  if (/\.\./.test(u) || u.startsWith(".") || u.endsWith(".")) return "";
  u = u.toLowerCase();
  const blocked = [
    /^instagram$/i, /^post$/i, /^posts$/i, /^reel$/i, /^reels$/i,
    /^story$/i, /^stories$/i, /^explore$/i, /^direct$/i, /^inbox$/i,
    /^activity$/i, /^following$/i, /^followers$/i, /^follow$/i,
    /^saved$/i, /^settings$/i, /^help$/i, /^about$/i, /^terms$/i,
    /^privacy$/i, /^login$/i, /^signup$/i, /^report$/i, /^more$/i,
    /^comment$/i, /^reply$/i, /^share$/i, /^save$/i, /^like$/i,
    /^sent$/i, /^translate/i, /^view/i, /^username$/i, /^new$/i,
    /^edit/i, /^delete/i, /^cancel$/i, /^close$/i, /^copy/i,
    /^threads$/i, /^threadsapp$/i,
  ];
  if (blocked.some((re) => re.test(u))) return "";
  return u;
}
// END-RESO-NORMALIZE

export { normalizeInstagramUsername };

// BEGIN-RESO-DONEMSG
/**
 * SINGLE SOURCE OF TRUTH untuk pesan akhir run (DONE). Dipakai oleh
 * background/popup (via reasonToMessage) dan ketiga panel (content-*.js)
 * lewat salinan byte-identik di dalam marker yang sama — dijamin oleh
 * fixture test DONEMSG agar tidak pernah drift.
 * @param {string} reason stopReason dari engine (complete/idle/stopped/...)
 * @param {number} count jumlah hasil terkumpul
 * @param {"facebook"|"tiktok"|"instagram"} platform
 * @param {{extra?: string, tip?: string}} [options] extra = diagnosis tambahan
 *   (mis. 429 saat timeout), tip = panduan saat tidak ada hasil
 * @returns {string}
 */
function doneMessage(reason, count, platform, options) {
  const word = platform === "instagram" ? "username" : "nama";
  const extra =
    options && typeof options.extra === "string" && options.extra
      ? ` ${options.extra}`
      : "";
  const tip =
    options && typeof options.tip === "string" && options.tip
      ? ` ${options.tip}`
      : "";
  const c = Number.isFinite(count) ? count : 0;

  if (reason === "stopped") {
    return c
      ? `Dihentikan — ${c} ${word}.${extra} Klik Copy.`
      : `Dihentikan — belum ada ${word}.${extra}`;
  }
  if (reason === "timeout") {
    return c
      ? `Waktu habis — ${c} ${word} (mungkin belum semua).${extra} Klik Copy.`
      : `Waktu habis — belum ada ${word}.${extra}`;
  }
  if (reason === "idle" || reason === "complete") {
    if (c) return `Selesai — ${c} ${word}.${extra} Klik Copy.`;
    if (tip) return `Tidak ada ${word}.${tip}`;
    if (platform === "facebook")
      return "Tidak ada nama. Buka permalink post, buka list komentar sampai terlihat, tunggu 2–3 dtk, lalu Proses lagi.";
    if (platform === "tiktok")
      return "Tidak ada nama. Pastikan komentar terbuka di video, lalu Proses lagi.";
    return "Tidak ada username. Pastikan komentar terbuka & sudah login, lalu Proses lagi.";
  }
  if (reason === "error") {
    return extra.trim() || "Terjadi error saat ekstrak.";
  }
  if (reason === "rate_limit") {
    const who =
      platform === "facebook"
        ? "Facebook"
        : platform === "tiktok"
          ? "TikTok"
          : "Instagram";
    return c
      ? `Rate limit ${who} (429) — ${c} ${word} terkumpul. Tunggu beberapa saat, lalu Proses lagi.`
      : `Rate limit ${who} (429) — tunggu beberapa saat, lalu coba lagi.`;
  }
  if (reason === "blocked") {
    return c
      ? `Instagram memblokir permintaan (403) — kemungkinan anti-bot. ${c} username terkumpul. Tunggu beberapa saat, lalu Proses lagi.`
      : "Instagram memblokir permintaan (403) — kemungkinan anti-bot atau App-ID ditolak. Berhenti agar akun aman; coba lagi beberapa saat kemudian.";
  }
  if (reason === "checkpoint") {
    return c
      ? `Instagram minta verifikasi (checkpoint). ${c} username terkumpul — buka instagram.com, selesaikan verifikasi, lalu Proses lagi.`
      : "Instagram minta verifikasi (checkpoint). Buka instagram.com, selesaikan verifikasi, lalu Proses lagi.";
  }
  if (reason === "no_template") {
    if (platform === "instagram") {
      return "Belum ada template API komentar. Buka post/reel, klik ikon komentar dulu, tunggu list muncul, lalu Proses lagi (wajib login).";
    }
    if (platform === "facebook") {
      return "Belum ada template GraphQL komentar. Buka permalink post, buka list komentar sampai terlihat, tunggu 2–3 detik, lalu Proses lagi.";
    }
    return "Belum ada template API komentar. Buka video, klik ikon komentar dulu, tunggu komentar muncul, lalu Proses lagi.";
  }
  if (reason === "no_video") {
    return "Buka halaman video TikTok dulu (URL berisi /video/...), bukan For You feed saja.";
  }
  if (reason === "no_login") {
    if (platform === "facebook")
      return "Sesi Facebook tidak aktif — login di facebook.com lalu Proses lagi.";
    if (platform === "tiktok")
      return "Sesi TikTok tidak aktif — login di tiktok.com lalu Proses lagi.";
    return "Butuh login Instagram. Buka instagram.com, login, lalu buka post & Proses lagi.";
  }
  if (reason === "no_media") {
    return "Buka halaman post/reel Instagram dulu (URL /p/... atau /reel/...).";
  }
  return c ? `${c} ${word}` : "Siap.";
}
// END-RESO-DONEMSG

// BEGIN-RESO-PARSERS
/**
 * SINGLE SOURCE OF TRUTH untuk parsing payload komentar — dipakai engine
 * MAIN-world (inject-fb.js / inject-tiktok.js / inject-ig.js) lewat salinan
 * byte-identik di dalam marker yang sama — dijamin fixture test PARSERS.
 * Semua fungsi murni: hanya memetakan payload JSON/teks ke daftar nama
 * (tanpa normalisasi/dedupe — pemanggil yang menormalkan).
 */

/** TikTok: nickname dari payload comment/list (jalur array + fallback walk). */
function parseTikTokComments(data, includeReplies) {
  const out = [];
  const arrays = [];
  if (Array.isArray(data?.comments)) arrays.push(data.comments);
  if (Array.isArray(data?.data?.comments)) arrays.push(data.data.comments);
  if (Array.isArray(data?.comments?.list)) arrays.push(data.comments.list);

  const takeUser = (user) => {
    if (!user || typeof user !== "object") return;
    const nick = user.nickname || user.nickName;
    if (typeof nick === "string") out.push(nick);
  };

  if (arrays.length) {
    for (const comments of arrays) {
      for (const c of comments) {
        if (!c || typeof c !== "object") continue;
        takeUser(c.user);
        if (typeof c.nickname === "string") out.push(c.nickname);
        // Hanya balasan tertanam saat user memilih ikut sertakan
        if (includeReplies) {
          const replies = c.reply_comment || c.reply_comments || c.comments;
          if (Array.isArray(replies)) {
            for (const r of replies) takeUser(r?.user);
          }
        }
      }
    }
    return out;
  }

  // Fallback: hanya node berbentuk komentar (hindari pohon balasan dalam saat nonaktif)
  const walk = (v, depth = 0) => {
    if (depth > 28 || v == null) return;
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
      return;
    }
    if (typeof v !== "object") return;
    const looksComment =
      v.user &&
      (v.cid != null ||
        v.comment_id != null ||
        v.text != null ||
        v.create_time != null ||
        v.digg_count != null);
    if (looksComment) takeUser(v.user);
    for (const k of Object.keys(v)) {
      if (
        !includeReplies &&
        (k === "reply_comment" || k === "reply_comments")
      ) {
        continue;
      }
      walk(v[k], depth + 1);
    }
  };
  walk(data, 0);
  return out;
}

/** Instagram: username dari payload comments (top-level). */
function parseIgComments(data) {
  const out = [];
  const comments = Array.isArray(data?.comments) ? data.comments : [];
  for (const c of comments) {
    if (!c || typeof c !== "object") continue;
    const u = c?.user?.username || "";
    if (u) out.push(u);
  }
  return out;
}

/** Facebook: nama dari teks GraphQL (pola regex — cermin extractNamesFromText). */
function extractGraphqlNames(text) {
  const out = [];
  if (!text || typeof text !== "string") return out;
  const patterns = [
    /"__typename"\s*:\s*"Comment"[\s\S]{0,1500}?"author"\s*:\s*\{[\s\S]{0,600}?"name"\s*:\s*"((?:\\.|[^"\\]){2,100})"/g,
    /"author"\s*:\s*\{[\s\S]{0,400}?"__typename"\s*:\s*"User"[\s\S]{0,300}?"name"\s*:\s*"((?:\\.|[^"\\]){2,100})"/g,
    /"author"\s*:\s*\{[\s\S]{0,300}?"name"\s*:\s*"((?:\\.|[^"\\]){2,100})"[\s\S]{0,300}?"__typename"\s*:\s*"User"/g,
    /"created_time"\s*:\s*\d+[\s\S]{0,500}?"author"\s*:\s*\{[\s\S]{0,400}?"name"\s*:\s*"((?:\\.|[^"\\]){2,100})"/g,
    /"author"\s*:\s*\{[\s\S]{0,400}?"name"\s*:\s*"((?:\\.|[^"\\]){2,100})"[\s\S]{0,500}?"created_time"\s*:\s*\d+/g,
    /"body"\s*:\s*\{[^}]{0,200}"text"\s*:\s*"[^"]{0,500}"[\s\S]{0,400}?"author"\s*:\s*\{[\s\S]{0,400}?"name"\s*:\s*"((?:\\.|[^"\\]){2,100})"/g,
  ];
  const seen = new Set();
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      let name;
      try {
        name = JSON.parse(`"${m[1]}"`);
      } catch {
        name = m[1];
      }
      if (typeof name === "string" && name && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        out.push(name);
      }
    }
  }
  return out;
}
// END-RESO-PARSERS

export { parseTikTokComments, parseIgComments, extractGraphqlNames };

/** Kata untuk hasil per platform — Instagram = username, lainnya = nama. */
export function wordFor(platform) {
  return platform === "instagram" ? "username" : "nama";
}

export { doneMessage };

/**
 * Normalize a raw name string, filtering out UI labels, timestamps, URLs, etc.
 * @param {string} raw
 * @param {"facebook"|"tiktok"|"instagram"|null} platform
 * @returns {string} normalized name or empty string
 */
export function normalizeName(raw, platform) {
  if (platform === "instagram") return normalizeInstagramUsername(raw);
  if (platform === "tiktok") return normalizeNickname(raw);
  return normalizeCommentName(raw);
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

// BEGIN-RESO-PANELTOOLS
/**
 * SINGLE SOURCE OF TRUTH untuk perkakas UI daftar nama — dipakai popup
 * (via export) dan ketiga panel (content-*.js) lewat salinan byte-identik
 * di dalam marker yang sama — dijamin fixture test PANELTOOLS.
 */

/** Saring nama (case-insensitive substring). */
function filterNames(names, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return names || [];
  return (names || []).filter((n) => String(n).toLowerCase().includes(q));
}

/** Urutkan A–Z (locale id); false = urutan asli. */
function sortNamesAz(names) {
  return [...(names || [])].sort((a, b) =>
    String(a).localeCompare(String(b), "id")
  );
}

/** Isi file CSV: BOM UTF-8 + header platform-aware + 1 nama/baris. */
function csvContent(names, isIg) {
  const header = isIg ? "Username" : "Nama";
  return "\uFEFF" + header + "\n" + (names || []).join("\n");
}

/** Unduh file teks via blob (berfungsi di popup & content script). */
function downloadTextFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * Gabung nama dari beberapa platform — tiap nama dinormalisasi dengan
 * aturan platform-nya SENDIRI (FB/TT/IG berbeda), lalu di-dedupe
 * case-insensitive. Menghindari data loss saat normalisasi lintas platform
 * (mis. @handle & emoji TikTok, atau nama FB yang mengandung spasi yang
 * ditolak aturan username Instagram).
 * @param {{platform: "facebook"|"tiktok"|"instagram", names: string[]}[]} groups
 * @returns {string[]}
 */
function mergeAcrossPlatforms(groups) {
  const map = new Map();
  for (const g of groups || []) {
    const platform =
      g?.platform === "tiktok" || g?.platform === "instagram"
        ? g.platform
        : "facebook";
    for (const n of g?.names || []) {
      const k = normalizeName(n, platform);
      if (k && !map.has(k.toLowerCase())) map.set(k.toLowerCase(), k);
    }
  }
  return [...map.values()];
}
// END-RESO-PANELTOOLS

export {
  mergeAcrossPlatforms,
  filterNames,
  sortNamesAz,
  csvContent,
  downloadTextFile,
};

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

// Instagram — same replay pattern as TikTok, shorter TTL (more fragile)
export const STORAGE_KEY_IG = "ing_state";
export const IG_TEMPLATE_KEY = "ing_comment_url";
export const IG_META_KEY = "ing_comment_meta";
/** Max age for a captured Instagram comments API template */
export const IG_TEMPLATE_TTL_MS = 30 * 60 * 1000;

// Persisted across browser restarts (chrome.storage.local)
export const SAVED_KEY = "rsx_saved"; // { facebook?: {names,count,savedAt}, tiktok?: {...} }
export const PREFS_KEY = "rsx_prefs"; // { includeReplies: { facebook?: boolean, tiktok?: boolean } }

/**
 * Get the storage key for a platform.
 * @param {"facebook"|"tiktok"|"instagram"} platform
 */
export function storageKeyFor(platform) {
  if (platform === "tiktok") return STORAGE_KEY_TT;
  if (platform === "instagram") return STORAGE_KEY_IG;
  return STORAGE_KEY_FB;
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

export const DEFAULT_STATE_IG = {
  status: "idle",
  names: [],
  count: 0,
  message:
    "Buka 1 post/reel Instagram, pastikan sudah login, lalu klik Proses.",
  tabId: null,
  updatedAt: 0,
  stopReason: null,
  postHint: "",
  includeReplies: false,
  hasTemplate: false,
  runId: null,
};

export function defaultStateFor(platform) {
  if (platform === "tiktok") return { ...DEFAULT_STATE_TT };
  if (platform === "instagram") return { ...DEFAULT_STATE_IG };
  return { ...DEFAULT_STATE_FB };
}

/**
 * Strip volatile pagination / app-noise params before persisting an
 * Instagram comments API template URL.
 * @param {string} url
 * @returns {string|null}
 */
export function sanitizeInstagramTemplateUrl(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const u = new URL(url);
    if (!u.href.includes("instagram.com/api/v1/media/")) return null;
    if (!u.href.includes("/comments/")) return null;
    if (u.href.includes("/inline_child_comments")) return null;
    for (const key of [
      "max_id",
      "min_id",
      "index",
      "a1",
      "__user",
      "__a",
      "__req",
      "__dyn",
      "__csr",
      "__tt",
      "__bfa",
      "__aut",
      "__spin_r",
      "__spin_b",
      "__spin_t",
    ]) {
      u.searchParams.delete(key);
    }
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Validate a stored Instagram comments API template.
 * @param {string|null|undefined} url
 * @param {{capturedAt?: number, mediaId?: string|null}|null|undefined} meta
 * @param {string|null} [requiredMediaId] when set, meta.mediaId must match when present
 * @returns {boolean}
 */
export function isInstagramTemplateValid(url, meta, requiredMediaId = null) {
  if (!url || typeof url !== "string") return false;
  if (!url.includes("instagram.com/api/v1/media/")) return false;
  if (!url.includes("/comments/")) return false;
  if (url.includes("/inline_child_comments")) return false;
  const capturedAt = meta?.capturedAt;
  if (!capturedAt || typeof capturedAt !== "number") return false;
  if (Date.now() - capturedAt > IG_TEMPLATE_TTL_MS) return false;
  if (
    requiredMediaId &&
    meta?.mediaId &&
    String(meta.mediaId) !== String(requiredMediaId)
  ) {
    return false;
  }
  return true;
}

// ===================== Engine Options Sanitizer =====================

/**
 * Sanitize START / SET_TEMPLATE options before crossing into MAIN world.
 * Pure (no chrome.*) so it is unit-testable. The engines are isolated worlds;
 * every value that crosses the boundary is validated here.
 * @param {"START"|"SET_TEMPLATE"|string} cmd
 * @param {object} options
 * @param {"facebook"|"tiktok"|"instagram"} platform
 * @returns {object}
 */
export function sanitizeEngineOptions(cmd, options, platform) {
  const raw = options && typeof options === "object" ? options : {};
  if (cmd === "SET_TEMPLATE") {
    const url =
      typeof raw.templateUrl === "string" ? raw.templateUrl.slice(0, 4000) : null;
    if (platform === "tiktok") {
      return {
        templateUrl:
          url &&
          url.toLowerCase().includes("tiktok.com/api/comment/list") &&
          !url.toLowerCase().includes("/list/reply")
            ? url
            : null,
      };
    }
    if (platform === "instagram") {
      return {
        templateUrl:
          url &&
          url.includes("instagram.com/api/v1/media/") &&
          url.includes("/comments/") &&
          !url.includes("/inline_child_comments")
            ? url
            : null,
      };
    }
    return { templateUrl: null };
  }
  if (cmd !== "START") return {};

  const maxMs = Number(raw.maxMs);
  const out = {
    maxMs: Number.isFinite(maxMs)
      ? Math.min(180_000, Math.max(8_000, maxMs))
      : platform === "tiktok"
        ? 120_000
        : 150_000,
    includeReplies:
      platform === "tiktok" || platform === "instagram"
        ? raw.includeReplies === true
        : raw.includeReplies !== false,
    runId:
      typeof raw.runId === "string" && raw.runId.length <= 80
        ? raw.runId
        : null,
  };
  if (platform === "tiktok") {
    const aweme =
      raw.awemeId != null ? String(raw.awemeId).replace(/\D/g, "").slice(0, 32) : "";
    out.awemeId = aweme || null;
    const url =
      typeof raw.templateUrl === "string" ? raw.templateUrl.slice(0, 4000) : null;
    out.templateUrl =
      url &&
      url.toLowerCase().includes("tiktok.com/api/comment/list") &&
      !url.toLowerCase().includes("/list/reply")
        ? url
        : null;
  }
  if (platform === "instagram") {
    const media =
      raw.mediaId != null ? String(raw.mediaId).replace(/\D/g, "").slice(0, 32) : "";
    out.mediaId = media || null;
    const url =
      typeof raw.templateUrl === "string" ? raw.templateUrl.slice(0, 4000) : null;
    out.templateUrl =
      url &&
      url.includes("instagram.com/api/v1/media/") &&
      url.includes("/comments/") &&
      !url.includes("/inline_child_comments")
        ? url
        : null;
  }
  return out;
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
  return doneMessage(reason, count, platform, extra ? { extra } : {});
}
