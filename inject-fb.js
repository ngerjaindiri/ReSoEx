/**
 * MAIN-world engine — FB Nama Komentar v1.5
 * Mesin GraphQL pagination aktif (setara store-grade), output hanya nama.
 *
 * Primary: capture Facebook /api/graphql comment requests → replay with cursor
 * Secondary: always-on response buffer + multi-strategy DOM
 */
(function () {
  const SOURCE = "fb-nama-komentar-inject";
  const VERSION = 8;

  if (window.__FNK_ENGINE__) {
    // Engine already live; ENGINE_CMD uses non-enumerable __RESO_FNK__
    return;
  }
  window.__FNK_ENGINE__ = true;

  /** @type {Map<string, string>} */
  const nameMap = new Map();
  /** @type {string[]} */
  const gqlBuffer = [];
  const GQL_BUFFER_MAX = 50;

  /**
   * Captured GraphQL request templates for comment pagination.
   * @type {Map<string, {url:string, params:Record<string,string>, variables:any, friendlyName:string, capturedAt:number}>}
   */
  const gqlTemplates = new Map();
  /** Last top-level comment list template key */
  let lastTopLevelKey = null;
  /** Last reply template key */
  let lastReplyKey = null;

  let running = false;
  let stopFlag = false;
  let lastNewAt = Date.now();
  let includeReplies = true;
  let currentRunId = null;
  /**
   * Feedback id postingan yang sedang di-paginate (di-set saat probe memilih
   * template). Dipakai memfilter nama dari respons GraphQL halaman (hook
   * fetch/XHR) agar komentar postingan LAIN tidak bocor ke hasil.
   */
  let activeFeedbackId = null;
  /** Total GraphQL requests this run (budget guard — protect the user's account) */
  let requestBudget = 0;
  const REQUEST_BUDGET = 350;
  /** @type {Element | null} */
  let postRoot = null;
  let engineMode = "idle"; // graphql | hybrid | dom

  // Muat template pagination tersimpan (doc_id) dari sesi sebelumnya — jadi
  // postingan baru bisa langsung paginate GraphQL tanpa buka komentar dulu.
  try {
    for (const t of loadStoredTemplates()) {
      if (!t || !t.friendlyName || !t.doc_id) continue;
      const variables = { ...(t.variables || {}) };
      // Mulai dari halaman 1: bersihkan state pagination lama
      delete variables.after;
      delete variables.before;
      delete variables.cursor;
      delete variables.commentsAfterCursor;
      delete variables.repliesAfterCursor;
      variables.isPaginating = false;
      variables.isInitialFetch = true;
      gqlTemplates.set(`__stored__${t.friendlyName}`, {
        url: t.url || "https://www.facebook.com/api/graphql/",
        params: { doc_id: t.doc_id },
        variables,
        friendlyName: t.friendlyName,
        capturedAt: 0,
      });
    }
  } catch {
    /* ignore */
  }

  /** Data-plane only (PROGRESS/DONE/ERROR). Control plane is ENGINE_CMD via executeScript. */
  function post(type, payload = {}) {
    window.postMessage(
      { source: SOURCE, type, runId: currentRunId, ...payload },
      "*"
    );
  }

  // ---------------- names ----------------
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

  // BEGIN-RESO-FBURLS
  /**
   * SINGLE SOURCE OF TRUTH untuk deteksi permalink Facebook — dipakai badge
   * panel (isFacebookPostPage), synthetic template engine (extractFbFeedbackIds),
   * dan pre-check. Disalin byte-identik ke inject-fb.js & content-fb.js; dijamin
   * fixture test FBURLS. Mengembalikan kandidat story/feedback id dari URL;
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
    if (watch) add(watch[1]);

    // 3) Param umum (story_fbid/fbid/v, termasuk nilai pfbid alfanumerik)
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

  function addName(raw) {
    const name = normalizeCommentName(raw);
    if (!name) return false;
    const key = name.toLowerCase();
    if (nameMap.has(key)) return false;
    nameMap.set(key, name);
    lastNewAt = Date.now();
    return true;
  }

  function snapshot() {
    return [...nameMap.values()];
  }

  // ---------------- GraphQL name extract ----------------
  function extractNamesFromText(text) {
    if (!text || typeof text !== "string") return 0;
    const before = nameMap.size;
    for (const name of extractGraphqlNames(text)) addName(name);
    try {
      const cleaned = text.replace(/^for\s*\(\s*;\s*;\s*\)\s*;/, "").trim();
      for (const chunk of splitJsonChunks(cleaned)) {
        try {
          walkJson(JSON.parse(chunk), 0);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
    return nameMap.size - before;
  }

  function isCommentLike(obj) {
    if (!obj || typeof obj !== "object") return false;
    if (obj.__typename === "Comment" || obj.__typename === "XFBComment") return true;
    if (obj.comment_parent || obj.reply_parent_comment || obj.comment_direct_parent)
      return true;
    if (
      obj.author &&
      (obj.body || obj.created_time != null || obj.legacy_fbid != null || obj.depth != null)
    )
      return true;
    return false;
  }

  function isReplyComment(obj) {
    if (!obj || typeof obj !== "object") return false;
    if (obj.comment_parent || obj.reply_parent_comment || obj.comment_direct_parent)
      return true;
    if (typeof obj.depth === "number" && obj.depth > 0) return true;
    return false;
  }

  function walkJson(value, depth) {
    if (depth > 50 || value == null) return;
    if (typeof value === "string") {
      if (value.length > 80 && /author|Comment/.test(value)) extractNamesFromText(value);
      return;
    }
    if (typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walkJson(item, depth + 1);
      return;
    }
    // Skip non-comment objects that have "name" but are sticker/attachment/media metadata
    const typeName = value.__typename || "";
    if (
      /^(Sticker|StickerPack|GIF|AnimatedImage|Photo|Video|Attachment|ExternalUrl|Page)$/i.test(typeName)
    ) {
      return; // Don't descend into media/attachment nodes
    }
    if (isCommentLike(value) && value.author?.name) {
      if (includeReplies || !isReplyComment(value)) addName(value.author.name);
    }
    if (value.node && isCommentLike(value.node) && value.node.author?.name) {
      if (includeReplies || !isReplyComment(value.node))
        addName(value.node.author.name);
    }
    for (const k of Object.keys(value)) {
      // Skip media/attachment keys that may contain name-like fields
      if (k === "profile_picture" || k === "image" || k === "sprite") continue;
      if (k === "sticker" || k === "sticker_pack" || k === "attached_sticker") continue;
      if (k === "gif_image" || k === "animated_image") continue;
      walkJson(value[k], depth + 1);
    }
  }

  function splitJsonChunks(text) {
    const out = [];
    const trimmed = text.trim();
    if (!trimmed) return out;
    try {
      JSON.parse(trimmed);
      return [trimmed];
    } catch {
      /* multi */
    }
    let depth = 0;
    let start = -1;
    let inStr = false;
    let esc = false;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') {
        inStr = true;
        continue;
      }
      if (ch === "{" || ch === "[") {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0 && start >= 0) {
          out.push(trimmed.slice(start, i + 1));
          start = -1;
        }
      }
    }
    if (!out.length) out.push(trimmed);
    return out;
  }

  // ---------------- page_info / cursor from GraphQL response ----------------
  function findPageInfo(obj, depth = 0) {
    if (depth > 40 || !obj || typeof obj !== "object") return null;
    if (!Array.isArray(obj)) {
      if (
        ("has_next_page" in obj || "hasNextPage" in obj) &&
        ("end_cursor" in obj || "endCursor" in obj)
      ) {
        return {
          hasNext:
            obj.has_next_page === true ||
            obj.hasNextPage === true ||
            obj.has_next_page === 1,
          endCursor: obj.end_cursor ?? obj.endCursor ?? null,
        };
      }
      for (const k of Object.keys(obj)) {
        const r = findPageInfo(obj[k], depth + 1);
        if (r) return r;
      }
    } else {
      for (const item of obj) {
        const r = findPageInfo(item, depth + 1);
        if (r) return r;
      }
    }
    return null;
  }

  function findFeedbackIds(obj, out = new Set(), depth = 0) {
    if (depth > 40 || !obj || typeof obj !== "object") return out;
    if (Array.isArray(obj)) {
      for (const i of obj) findFeedbackIds(i, out, depth + 1);
      return out;
    }
    if (typeof obj.id === "string" && /^feedback[:_]/i.test(obj.id)) out.add(obj.id);
    if (typeof obj.feedback_id === "string") out.add(obj.feedback_id);
    if (obj.__typename === "Feedback" && typeof obj.id === "string") out.add(obj.id);
    // common Relay id shape
    if (
      typeof obj.id === "string" &&
      obj.id.length > 10 &&
      typeof obj.__typename === "string" &&
      /feedback/i.test(obj.__typename)
    )
      out.add(obj.id);
    for (const k of Object.keys(obj)) findFeedbackIds(obj[k], out, depth + 1);
    return out;
  }

  // ---------------- capture GraphQL requests (store-grade) ----------------
  const COMMENT_FRIENDLY =
    /comment|ufi|feedback|reply|replies|depth\d*comments|CommentsList|CometUFI|CommentList/i;

  function isGraphqlUrl(url) {
    if (!url) return false;
    const u = String(url).toLowerCase();
    return u.includes("graphql") || u.includes("/api/graphql");
  }

  function parseBodyToParams(body) {
    const params = {};
    if (body == null) return params;
    if (typeof body === "string") {
      if (body.startsWith("{")) {
        try {
          const j = JSON.parse(body);
          Object.keys(j).forEach((k) => {
            params[k] = typeof j[k] === "string" ? j[k] : JSON.stringify(j[k]);
          });
          return params;
        } catch {
          /* form */
        }
      }
      try {
        const usp = new URLSearchParams(body);
        usp.forEach((v, k) => {
          params[k] = v;
        });
      } catch {
        /* ignore */
      }
      return params;
    }
    if (typeof body === "object" && typeof body.entries === "function") {
      // FormData / URLSearchParams
      try {
        for (const [k, v] of body.entries()) params[k] = String(v);
      } catch {
        /* ignore */
      }
    }
    return params;
  }

  function captureGraphqlRequest(url, body) {
    if (!isGraphqlUrl(url)) return;
    const params = parseBodyToParams(body);
    const friendly =
      params.fb_api_req_friendly_name ||
      params.friendly_name ||
      params.__req ||
      "";
    if (!friendly || !COMMENT_FRIENDLY.test(String(friendly))) {
      // still buffer response; only templates for comment-ish names
      if (!params.doc_id && !params.variables) return;
      if (!COMMENT_FRIENDLY.test(JSON.stringify(params).slice(0, 500))) return;
    }
    let variables = null;
    if (params.variables) {
      try {
        variables =
          typeof params.variables === "string"
            ? JSON.parse(params.variables)
            : params.variables;
      } catch {
        variables = null;
      }
    }
    const key = String(friendly || params.doc_id || "comment");
    const entry = {
      url: String(url).split("?")[0] || "https://www.facebook.com/api/graphql/",
      params: { ...params },
      variables,
      friendlyName: key,
      capturedAt: Date.now(),
    };
    gqlTemplates.set(key, entry);
    persistGqlTemplate(entry);

    // Classify top-level vs reply
    const lower = key.toLowerCase();
    if (/reply|depth1|depth_1|replies/i.test(lower)) {
      lastReplyKey = key;
    } else {
      lastTopLevelKey = key;
    }
  }

  function pushGqlBuffer(text) {
    if (!text || text.length < 60) return;
    if (!/"name"\s*:/.test(text) && !/author|Comment/.test(text)) return;
    gqlBuffer.push(text);
    if (gqlBuffer.length > GQL_BUFFER_MAX) gqlBuffer.shift();
  }

  /**
   * Feedback id dari body request GraphQL (variabel `feedbackID`/`feedback_id`
   * saja — jangan `id`, karena itu bisa id komentar untuk query balasan).
   * Kosong = request tak bisa diklasifikasikan (balasan, bentuk tak dikenal).
   */
  function feedbackIdsFromReqBody(body) {
    if (body == null) return [];
    let vars = null;
    try {
      const params = parseBodyToParams(body);
      vars =
        typeof params.variables === "string"
          ? JSON.parse(params.variables)
          : params.variables;
    } catch {
      vars = null;
    }
    if (!vars || typeof vars !== "object") return [];
    const out = new Set();
    for (const k of ["feedbackID", "feedback_id"]) {
      const v = vars[k];
      if (typeof v === "string" && v) out.add(v);
    }
    return [...out];
  }

  /** Base64 Relay form dari id feedback ("feedback:<id>"). */
  function fbIdB64(id) {
    if (typeof id !== "string" || !id) return id;
    try {
      return btoa(`feedback:${id}`);
    } catch {
      return id;
    }
  }

  /** Cocokkan dua representasi id feedback (mentah vs base64 Relay). */
  function fbIdsMatch(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    try {
      return a === fbIdB64(b) || b === fbIdB64(a);
    } catch {
      return false;
    }
  }

  /** Normalisasi id feedback dari variabel template (base64 Relay → mentah). */
  function normalizeFeedbackId(v) {
    if (typeof v !== "string" || !v) return v;
    if (v.length > 25 && /^[A-Za-z0-9+/=]+$/.test(v)) {
      try {
        const m = atob(v).match(/^feedback[:_](\d+)$/);
        if (m) return m[1];
      } catch {
        /* bukan base64 */
      }
    }
    return v;
  }

  /**
   * Apakah respons GraphQL dari request `reqIds` boleh diekstrak namanya?
   * Rule: id URL (permalink) + id postingan yang sedang di-paginate. Request
   * tanpa feedback id (balasan, bentuk tak dikenal) tetap diproses.
   */
  function isTargetCommentResponse(reqIds) {
    if (!reqIds || !reqIds.length) return true;
    // Id URL bisa mentah, request FB asli membawa base64 Relay
    // ("feedback:<id>" encoded) — cocokkan kedua bentuk.
    const allowed = [...new Set(feedbackIdsFromUrl())];
    if (activeFeedbackId) allowed.push(activeFeedbackId);
    return reqIds.some((id) => allowed.some((a) => fbIdsMatch(a, id)));
  }

  // ---------------- persistensi template pagination (doc_id) ----------------
  const TPL_STORAGE_KEY = "fnk_fb_gql_tpl_v1";

  /** Template pagination tersimpan (doc_id terbaru) — dipakai ulang untuk
   *  template sintetik di postingan lain tanpa perlu buka komentar dulu. */
  function loadStoredTemplates() {
    try {
      const raw = localStorage.getItem(TPL_STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  /** Simpan template pagination (ber-doc_id) terbaik ke localStorage. */
  function persistGqlTemplate(entry) {
    try {
      if (!entry || !entry.params || !entry.params.doc_id) return;
      if (!isPaginationLike(entry)) return;
      const list = loadStoredTemplates();
      const clean = {
        friendlyName: entry.friendlyName,
        url: entry.url,
        doc_id: entry.params.doc_id,
        variables: entry.variables,
        capturedAt: entry.capturedAt,
      };
      const idx = list.findIndex((t) => t.friendlyName === clean.friendlyName);
      if (idx === 0 && list[0] && list[0].doc_id === clean.doc_id) return;
      if (idx >= 0) list.splice(idx, 1);
      list.unshift(clean);
      localStorage.setItem(TPL_STORAGE_KEY, JSON.stringify(list.slice(0, 3)));
    } catch {
      /* ignore */
    }
  }

  /** Template pagination terbaik dari sesi sebelumnya (doc_id paling baru). */
  function bestStoredPaginationTemplate() {
    const list = loadStoredTemplates();
    for (const t of list) {
      if (t && t.doc_id && isPaginationLike(t)) return t;
    }
    return null;
  }

  function drainGqlBuffer() {
    let n = 0;
    const items = gqlBuffer.splice(0);
    for (const t of items) n += extractNamesFromText(t);
    return n;
  }

  // Always-on hooks
  if (!window.__FNK_NET__) {
    window.__FNK_NET__ = true;
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      const req = args[0];
      const url = typeof req === "string" ? req : req?.url || "";
      let body = args[1]?.body;
      if (body == null && req && typeof req === "object" && req.clone) {
        try {
          // Request object — can't always read body twice; skip
        } catch {
          /* ignore */
        }
      }
      try {
        if (isGraphqlUrl(url) && body != null) captureGraphqlRequest(url, body);
      } catch {
        /* ignore */
      }
      const res = await origFetch.apply(this, args);
      const reqIds = feedbackIdsFromReqBody(args[1]?.body);
      try {
        if (isGraphqlUrl(url)) {
          res
            .clone()
            .text()
            .then((t) => {
              // Anti kontaminasi lintas post: hanya proses respons yang request-
              // nya membawa feedback id postingan target (atau tak terklasifikasi).
              if (!isTargetCommentResponse(reqIds)) return;
              pushGqlBuffer(t);
              if (running) extractNamesFromText(t);
            })
            .catch(() => {});
        }
      } catch {
        /* ignore */
      }
      return res;
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__fnk_url = url;
      this.__fnk_method = method;
      return origOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      try {
        const body = args[0];
        this.__fnk_body = body;
        if (isGraphqlUrl(this.__fnk_url) && body != null) {
          captureGraphqlRequest(this.__fnk_url, body);
        }
      } catch {
        /* ignore */
      }
      this.addEventListener("load", function () {
        try {
          if (!isGraphqlUrl(this.__fnk_url)) return;
          if (typeof this.responseText === "string") {
            if (
              !isTargetCommentResponse(
                feedbackIdsFromReqBody(this.__fnk_body)
              )
            )
              return;
            pushGqlBuffer(this.responseText);
            if (running) extractNamesFromText(this.responseText);
          }
        } catch {
          /* ignore */
        }
      });
      return origSend.apply(this, args);
    };
  }

  // ---------------- tokens / replay (active GraphQL pagination) ----------------

  // Cached anti-forgery tokens — RINGAN (tanpa menserialisasi seluruh DOM
  // Facebook yang megabyte): require() dulu, scan <script> terbatas, input
  // form, dan innerHTML hanya sebagai fallback terakhir (di-cache 5 menit).
  const TOKEN_CACHE_TTL = 5 * 60 * 1000;
  const tokenCache = { dtsg: null, lsd: null, at: 0 };

  /**
   * Cari token di dalam <script> tag saja (bukan documentElement.innerHTML):
   * baca tiap tag, lewati yang raksasa (>400 KB, mis. payload feed/video),
   * dan cek pola regex yang diberikan. Jauh lebih ringan daripada serialisasi
   * seluruh DOM — DTSGInitialData/LSD selalu ada di script JSON/inline kecil.
   */
  function findTokenInScripts(patterns) {
    try {
      const scripts = document.querySelectorAll("script");
      const limit = Math.min(scripts.length, 60);
      for (let i = 0; i < limit; i++) {
        const t = scripts[i].textContent || "";
        if (!t || t.length > 400_000) continue;
        if (!/DTSG|dtsg|LSD|lsd|fb_dtsg/i.test(t)) continue;
        for (const re of patterns) {
          const m = t.match(re);
          if (m && m[1]) return m[1];
        }
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function getDtsg() {
    const now = Date.now();
    if (tokenCache.dtsg && now - tokenCache.at < TOKEN_CACHE_TTL) {
      return tokenCache.dtsg;
    }
    let token = null;
    // 1) Modul sudah dimuat di memory — paling cepat, tanpa scan DOM.
    try {
      if (typeof require === "function") {
        const d =
          require("DTSGInitialData") ||
          require("DTSG") ||
          require("DTSGInitData");
        if (d?.token) token = d.token;
      }
    } catch {
      /* ignore */
    }
    // 2) Scan <script> tag (terbatas & ringan).
    if (!token) {
      token = findTokenInScripts([
        /"DTSGInitialData",\[\],\{"token":"([^"]+)"/,
        /"token":"([A-Za-z0-9_:-]{8,})"[,}][^"]{0,40}DTSG/,
        /"dtsg":\{"token":"([^"]+)"/,
      ]);
    }
    // 3) Form token (halaman klasik).
    if (!token) {
      try {
        const inp = document.querySelector('input[name="fb_dtsg"]');
        if (inp?.value) token = inp.value;
      } catch {
        /* ignore */
      }
    }
    // 4) Fallback terakhir — mahal; di-cache 5 mnt jadi maksimal sekali per TTL.
    if (!token) {
      try {
        const html = document.documentElement?.innerHTML || "";
        let m = html.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/);
        if (m) token = m[1];
        if (!token) {
          m = html.match(/"token":"([A-Za-z0-9_:-]{8,})"[,}][^"]{0,40}DTSG/);
          if (m) token = m[1];
        }
        if (!token) {
          m = html.match(/name="fb_dtsg"\s+value="([^"]+)"/);
          if (m) token = m[1];
        }
        if (!token) {
          m = html.match(/"dtsg":\{"token":"([^"]+)"/);
          if (m) token = m[1];
        }
      } catch {
        /* ignore */
      }
    }
    if (token) {
      tokenCache.dtsg = token;
      tokenCache.at = now;
    }
    return token;
  }

  function getLsd() {
    const now = Date.now();
    if (tokenCache.lsd && now - tokenCache.at < TOKEN_CACHE_TTL) {
      return tokenCache.lsd;
    }
    let token = null;
    // 1) Modul dari memory dulu.
    try {
      if (typeof require === "function") {
        const d = require("LSD") || require("LSDInitData");
        if (d?.token) token = d.token;
      }
    } catch {
      /* ignore */
    }
    // 2) Scan <script> tag (ringan).
    if (!token) {
      token = findTokenInScripts([/"LSD",\[\],\{"token":"([^"]+)"/]);
    }
    // 3) Form token.
    if (!token) {
      try {
        const inp = document.querySelector('input[name="lsd"]');
        if (inp?.value) token = inp.value;
      } catch {
        /* ignore */
      }
    }
    // 4) Fallback terakhir (innerHTML) — di-cache 5 mnt.
    if (!token) {
      try {
        const html = document.documentElement?.innerHTML || "";
        const m = html.match(/"LSD",\[\],\{"token":"([^"]+)"/);
        if (m) token = m[1];
      } catch {
        /* ignore */
      }
    }
    if (token) {
      tokenCache.lsd = token;
      tokenCache.at = now;
    }
    return token;
  }

  function getUserId() {
    try {
      const c = document.cookie.match(/(?:^|;\s*)c_user=(\d+)/);
      if (c) return c[1];
      if (typeof require === "function") {
        const u = require("CurrentUserInitialData");
        if (u?.USER_ID) return String(u.USER_ID);
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function setCursorOnVariables(variables, cursor) {
    if (!variables || typeof variables !== "object") return variables;
    const v = JSON.parse(JSON.stringify(variables));
    const cursorKeys = [
      "commentsAfterCursor",
      "after",
      "cursor",
      "before",
      "comments_after_cursor",
      "repliesAfterCursor",
      "replies_after_cursor",
      "endCursor",
      "end_cursor",
    ];
    let set = false;
    const walk = (obj, depth) => {
      if (depth > 8 || !obj || typeof obj !== "object") return;
      for (const k of Object.keys(obj)) {
        if (cursorKeys.includes(k)) {
          obj[k] = cursor;
          set = true;
        } else if (obj[k] && typeof obj[k] === "object") {
          walk(obj[k], depth + 1);
        }
      }
    };
    walk(v, 0);
    // common top-level patterns
    if (!set) {
      if ("commentsAfterCursor" in v) v.commentsAfterCursor = cursor;
      else if ("after" in v) v.after = cursor;
      else v.commentsAfterCursor = cursor;
    }
    return v;
  }

  async function graphqlReplay(template, cursor) {
    requestBudget += 1;
    const params = { ...template.params };
    let variables = template.variables
      ? setCursorOnVariables(template.variables, cursor)
      : { after: cursor };

    // Refresh anti-forgery tokens
    const dtsg = getDtsg();
    if (dtsg) params.fb_dtsg = dtsg;
    const lsd = getLsd();
    if (lsd) params.lsd = lsd;
    const uid = getUserId();
    if (uid) {
      if ("__user" in params) params.__user = uid;
      if ("av" in params) params.av = uid;
    }

    params.variables =
      typeof variables === "string" ? variables : JSON.stringify(variables);
    if (!params.fb_api_req_friendly_name && template.friendlyName) {
      params.fb_api_req_friendly_name = template.friendlyName;
    }
    if (!params.fb_api_caller_class) {
      params.fb_api_caller_class = "RelayModern";
    }
    if (!params.server_timestamps) params.server_timestamps = "true";

    const body = new URLSearchParams();
    Object.keys(params).forEach((k) => {
      if (params[k] != null) body.set(k, String(params[k]));
    });

    const url = template.url || "https://www.facebook.com/api/graphql/";
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-FB-Friendly-Name":
            params.fb_api_req_friendly_name || template.friendlyName || "Comments",
          Accept: "*/*",
        },
        body: body.toString(),
      });
    } catch (err) {
      const e = new Error("Jaringan terganggu — coba lagi.");
      e.kind = "network";
      throw e;
    }
    // Sesi kadaluarsa: FB redirect ke halaman login
    if (res.redirected && /login/i.test(res.url)) {
      const e = new Error("Sesi Facebook tidak aktif — login lalu Proses lagi.");
      e.kind = "no_login";
      throw e;
    }
    const text = await res.text();
    // HTTP 200 tapi isi HTML login (token kadaluarsa) — bukan data komentar
    if (/<html[\s>]/i.test(text) && /login|masuk/i.test(text)) {
      const e = new Error("Sesi Facebook tidak aktif — login lalu Proses lagi.");
      e.kind = "no_login";
      throw e;
    }
    if (!res.ok) {
      if (res.status === 429) {
        const ra = Number(res.headers.get("retry-after"));
        const e = new Error(
          "Rate limit Facebook (HTTP 429) — jeda sejenak lalu coba lagi."
        );
        e.kind = "rate_limit";
        e.retryAfter = Number.isFinite(ra) && ra > 0 ? ra : null;
        throw e;
      }
      const e = new Error(`GraphQL HTTP ${res.status}`);
      e.kind = "http";
      throw e;
    }
    pushGqlBuffer(text);
    extractNamesFromText(text);

    let json = null;
    try {
      const cleaned = text.replace(/^for\s*\(\s*;\s*;\s*\)\s*;/, "").trim();
      const chunks = splitJsonChunks(cleaned);
      json = JSON.parse(chunks[0]);
    } catch {
      /* ignore */
    }

    // Feedback id salah / post tidak publik / GraphQL error → berhenti dini
    // (probe kandidat berikutnya, bukan diam-diam jatuh ke "idle").
    if (json && Array.isArray(json.errors) && json.errors.length) {
      const first = json.errors[0] || {};
      const msg = typeof first.message === "string" ? first.message : "";
      const e = new Error(
        `GraphQL: ${msg.slice(0, 120) || "feedback tidak ditemukan"}`
      );
      e.kind = "graphql_error";
      throw e;
    }

    const page = json ? findPageInfo(json) : null;
    // also harvest reply expansion ids for later
    const replyIds = [];
    if (includeReplies && json) {
      const walk = (o, d = 0) => {
        if (d > 35 || !o || typeof o !== "object") return;
        if (Array.isArray(o)) {
          o.forEach((x) => walk(x, d + 1));
          return;
        }
        if (
          isCommentLike(o) &&
          o.feedback?.id &&
          (o.feedback?.replies_fields?.total_count > 0 ||
            o.feedback?.replies_connection)
        ) {
          replyIds.push(o.feedback.id);
        }
        if (o.node) walk(o.node, d + 1);
        for (const k of Object.keys(o)) {
          if (k !== "node") walk(o[k], d + 1);
        }
      };
      walk(json);
    }

    return {
      ok: res.ok,
      status: res.status,
      page,
      replyIds: [...new Set(replyIds)].slice(0, 40),
      textSlice: text.slice(0, 200),
    };
  }

  /**
   * graphqlReplay dengan ketahanan: backoff adaptif 429 (hormati Retry-After,
   * eskalasi 8s → 16s, maks 2 retry, hanya jika sisa waktu cukup), retry cepat
   * untuk blip jaringan, heartbeat PROGRESS selama menunggu. Error no_login
   * diteruskan agar run berhenti aman.
   */
  async function graphqlReplayWithBackoff(template, cursor, deadline) {
    let attempt = 0;
    for (;;) {
      try {
        return await graphqlReplay(template, cursor);
      } catch (err) {
        const kind = err && err.kind;
        if (kind === "no_login") throw err;
        if (kind === "rate_limit") {
          const ra = err.retryAfter;
          const waitMs =
            ra && ra > 0
              ? Math.min(ra, 20) * 1000
              : attempt === 0
                ? 8000
                : 16000;
          if (attempt >= 2 || Date.now() + waitMs > deadline) throw err;
          attempt++;
          post("PROGRESS", {
            names: snapshot(),
            message: `Rate limit (429) — jeda ${Math.round(waitMs / 1000)} dtk…`,
            postHint: "rate_limit",
          });
          if (!(await sleepWhile(waitMs))) throw err;
          continue;
        }
        if (kind === "network" && attempt === 0) {
          attempt++;
          if (Date.now() + 1500 > deadline) throw err;
          await sleepWhile(1200);
          continue;
        }
        throw err;
      }
    }
  }

  /** Capture-shaped → likely a real comments pagination query (not composer/teaser). */
  function isPaginationLike(t) {
    if (!t) return false;
    let v = t.variables;
    if (typeof v === "string") {
      try {
        v = JSON.parse(v);
      } catch {
        v = null;
      }
    }
    const flat = JSON.stringify(v || {});
    return /cursor|page_info|has_next_page|commentsAfterCursor|feedbackID|feedback_id|comments\b/i.test(
      flat
    );
  }

  /** Apakah variabel template membawa salah satu feedback id dari URL? */
  function matchesFeedback(t, ids) {
    if (!t || !ids || !ids.length) return false;
    let v = t.variables;
    if (typeof v === "string") {
      try {
        v = JSON.parse(v);
      } catch {
        v = null;
      }
    }
    const flat = JSON.stringify(v || {});
    return ids.some((id) => {
      if (flat.includes(`"feedbackID":"${id}"`)) return true;
      if (flat.includes(`"feedback_id":"${id}"`)) return true;
      if (flat.includes(`"id":"${id}"`)) return true;
      // Variabel template asli FB membawa id dalam bentuk base64 Relay
      const b64 = fbIdB64(id);
      if (b64 !== id) {
        if (flat.includes(`"feedbackID":"${b64}"`)) return true;
        if (flat.includes(`"feedback_id":"${b64}"`)) return true;
        if (flat.includes(`"id":"${b64}"`)) return true;
      }
      return false;
    });
  }

  /** Ordered candidates: URL-matched → shaped → last top-level → newest. */
  function orderedCandidates() {
    const nonReply = [...gqlTemplates.values()]
      .filter((t) => t.friendlyName && !/reply|depth1|replies/i.test(t.friendlyName))
      .sort((a, b) => b.capturedAt - a.capturedAt);
    if (!nonReply.length) return [];
    const ids = feedbackIdsFromUrl();
    const out = [];
    const push = (t) => {
      if (t && !out.includes(t)) out.push(t);
    };
    // 1) Template yang id feedback-nya cocok dengan URL (anti salah post —
    //    setara mediaId filter IG v1.0.15)
    if (ids.length) {
      for (const t of nonReply) {
        if (isPaginationLike(t) && matchesFeedback(t, ids)) push(t);
      }
    }
    // 2) Template pagination-like terbaru
    for (const t of nonReply) if (isPaginationLike(t)) push(t);
    // 3) Top-level terakhir yang ter-capture
    if (lastTopLevelKey && gqlTemplates.has(lastTopLevelKey)) {
      push(gqlTemplates.get(lastTopLevelKey));
    }
    // 4) Sisanya (fallback)
    for (const t of nonReply) push(t);
    return out;
  }

  /** Id feedback pertama dari URL permalink (via blok FBURLS). */
  function feedbackIdFromUrl() {
    return extractFbFeedbackId(String(location.href));
  }

  /** Semua kandidat id feedback dari URL, urut prioritas (via blok FBURLS). */
  function feedbackIdsFromUrl() {
    return extractFbFeedbackIds(String(location.href));
  }

  /**
   * Build the comments pagination query directly from candidate feedback ids
   * in the URL (like standalone scrapers do), so the user does not have to
   * open/scroll the comment list first. Urutan kandidat = prioritas probe;
   * probe memvalidasi id mana yang benar menghasilkan page_info.
   */
  /**
   * doc_id untuk CometUFICommentsProviderPaginationQuery. Prioritas: template
   * tersimpan (localStorage) → daftar fallback dari scraper publik (terbaru
   * dulu). Probe memvalidasi tiap kandidat, jadi doc_id basi hanya membuat
   * kandidat itu dilewati — tidak memutus run.
   */
  const PAGINATION_DOC_IDS = [
    "25399415259725176", // 2026 — crawler FB aktif
    "5676025945801633", // 2025 — FacebookMasterTool
    "4712008195539492", // 2024 — Crawl_Facebook_Data_Toolbox
  ];

  function buildSyntheticPaginationTemplates() {
    const ids = feedbackIdsFromUrl();
    if (!ids.length) return [];
    const stored = bestStoredPaginationTemplate();
    const docIds = [];
    if (stored && stored.doc_id) docIds.push(stored.doc_id);
    for (const d of PAGINATION_DOC_IDS) {
      if (!docIds.includes(d)) docIds.push(d);
    }
    const base = {
      url: "https://www.facebook.com/api/graphql/",
      friendlyName: "CometUFICommentsProviderPaginationQuery",
      capturedAt: Date.now(),
    };
    // Urutan kandidat: doc_id tersimpan × tiap id URL (probe memvalidasi id
    // mana yang benar), lalu doc_id fallback × id pertama.
    const cands = [];
    for (const id of ids.slice(0, 3)) {
      cands.push({ docId: docIds[0], id });
    }
    for (const docId of docIds.slice(1)) {
      cands.push({ docId, id: ids[0] });
    }
    return cands.slice(0, 3).map(({ docId, id }) => {
      // Feedback id Relay wajib base64 "feedback:<id>" — id mentah ditolak
      // (dikonfirmasi 3 scraper independen 2024–2026).
      const feedbackID = fbIdB64(id);
      return {
        ...base,
        params: { doc_id: docId },
        variables: {
          after: null,
          before: null,
          count: 20,
          first: 20,
          feedbackID,
          id: feedbackID,
          focusCommentID: null,
          includeNestedComments: true,
          isInitialFetch: true,
          isPaginating: true,
          last: null,
          scale: 1,
          useDefaultActor: false,
          feedLocation: "NEWSFEED",
          feedbackSource: 1,
          // Paksa mode "Semua Komentar" (kronologis, tanpa filter "paling
          // relevan") — tanpa ini FB default ke RANKED_THREADED yang hanya
          // mengembalikan sebagian komentar dan pagination berhenti dini.
          commentsIntentToken: "RANKED_UNFILTERED_CHRONOLOGICAL_REPLIES_INTENT_V1",
          topLevelViewOption: "RANKED_UNFILTERED",
          sortKey: "RANKED_UNFILTERED",
          __relay_internal__pv__IsWorkUserrelayprovider: false,
        },
      };
    });
  }

  /**
   * Paksa mode "Semua Komentar" pada template replay: clone variabel dengan
   * `sortKey: "RANKED_UNFILTERED"` (kronologis, unfiltered). Mengembalikan
   * template asli bila sudah ber-mode itu atau variabel tak bisa dikloning
   * (probe memvalidasi varian ini dulu, lalu jatuh ke varian asli).
   */
  function forceAllComments(t) {
    if (!t || !t.variables || typeof t.variables !== "object") return t;
    if (t.variables.sortKey === "RANKED_UNFILTERED") return t;
    try {
      const variables = JSON.parse(JSON.stringify(t.variables));
      variables.sortKey = "RANKED_UNFILTERED";
      return { ...t, variables };
    } catch {
      return t;
    }
  }

  async function paginateGraphql(maxMs) {
    const candidates = orderedCandidates();
    if (!candidates.length) return { mode: "none", reason: "no_template" };
    const deadline = Date.now() + maxMs;

    // Verify which candidate actually paginates (probe page 1 once).
    // Tiap kandidat di-probe dengan varian "Semua Komentar" (sortKey
    // RANKED_UNFILTERED) dulu — jadi hasil tidak bergantung pada pilihan
    // sortir yang tampil di halaman — lalu jatuh ke varian asli (mode user)
    // bila FB menolak varian paksa.
    let template = null;
    let lastProbeErr = null;
    for (const cand of candidates.slice(0, 3)) {
      if (stopFlag) return { mode: "graphql", reason: "stopped" };
      const variants = [forceAllComments(cand), cand].filter(
        (v, i, arr) => v && arr.indexOf(v) === i
      );
      for (const variant of variants) {
        if (stopFlag) return { mode: "graphql", reason: "stopped" };
        try {
          const probe = await graphqlReplayWithBackoff(variant, null, deadline);
          if (probe.page && probe.page.hasNext !== undefined) {
            template = variant;
            break;
          }
        } catch (err) {
          lastProbeErr = err;
          // Rate limit saat probe = jangan lanjut hammer; berhenti aman
          if (err && err.kind === "rate_limit") {
            return {
              mode: "graphql",
              reason: "rate_limit",
              error: String(err.message || err),
            };
          }
          if (err && err.kind === "no_login") {
            return {
              mode: "graphql",
              reason: "no_login",
              error: String(err.message || err),
            };
          }
          /* coba varian berikutnya */
        }
      }
      if (template) break;
    }
    if (!template) {
      // Probe gagal semua — jangan paksa pagination yang pasti error
      if (lastProbeErr) {
        return {
          mode: "graphql",
          reason: nameMap.size ? "timeout" : "error",
          error: String(lastProbeErr.message || lastProbeErr),
        };
      }
      template = candidates[0];
    }

    // Kunci target: nama dari respons GraphQL halaman hanya diproses untuk
    // feedback id ini (anti kontaminasi postingan lain di feed). Normalisasi
    // bentuk base64 Relay → mentah agar cocok dengan id URL.
    if (template.variables) {
      const v = template.variables;
      activeFeedbackId =
        normalizeFeedbackId(String(v.feedbackID || v.feedback_id || "")) || null;
    }

    engineMode = "graphql";
    post("PROGRESS", {
      names: snapshot(),
      message: `Mode GraphQL (pagination aktif)… ${template.friendlyName}`,
      postHint: template.friendlyName,
    });

    const start = Date.now();
    let cursor = null;
    // seed cursor from existing variables if any
    if (template.variables) {
      const v = template.variables;
      cursor =
        v.commentsAfterCursor ??
        v.after ??
        v.cursor ??
        v.repliesAfterCursor ??
        null;
    }
    // first page: null cursor to (re)fetch from start for completeness
    cursor = null;

    let pages = 0;
    let idle = 0;
    let reason = "complete";
    const replyQueue = [];

    let emptyPages = 0;
    while (running && !stopFlag && Date.now() - start < maxMs) {
      if (requestBudget >= REQUEST_BUDGET) {
        reason = "timeout";
        break;
      }
      const before = nameMap.size;
      let result;
      try {
        result = await graphqlReplayWithBackoff(template, cursor, deadline);
      } catch (err) {
        const kind = err && err.kind;
        if (kind === "rate_limit")
          return {
            mode: "graphql",
            reason: "rate_limit",
            error: String(err.message || err),
          };
        if (kind === "no_login")
          return {
            mode: "graphql",
            reason: "no_login",
            error: String(err.message || err),
          };
        if (kind === "stopped") return { mode: "graphql", reason: "stopped" };
        return {
          mode: "graphql",
          reason: nameMap.size ? "timeout" : "error",
          error: String(err?.message || err),
        };
      }

      pages++;
      // Budget guard: never paginate forever on huge threads
      if (pages > 120) {
        reason = "timeout";
        break;
      }
      if (result.replyIds?.length) replyQueue.push(...result.replyIds);

      post("PROGRESS", {
        names: snapshot(),
        message: `GraphQL halaman ${pages}… ${nameMap.size} nama`,
        postHint: template.friendlyName,
      });

      if (nameMap.size === before) idle++;
      else idle = 0;

      // Halaman kosong / JSON gagal diparse — retry cursor sama 2× sebelum menyerah
      if (!result.page) {
        emptyPages++;
        if (emptyPages <= 2 && Date.now() - start < maxMs - 3000) {
          await sleepWhile(700 + Math.random() * 500);
          continue;
        }
        reason = "idle";
        break;
      }
      emptyPages = 0;

      const hasNext = result.page.hasNext;
      const endCursor = result.page.endCursor;

      if (hasNext === false) {
        reason = "complete";
        break;
      }
      if (hasNext === true && !endCursor) {
        // FB bilang masih ada, tapi tanpa cursor — tidak bisa lanjut
        reason = "idle";
        break;
      }
      if (idle >= 4) {
        reason = "idle";
        break;
      }
      if (endCursor === cursor) {
        reason = "complete";
        break;
      }
      cursor = endCursor;
      if (!(await sleepWhile(500 + Math.random() * 700))) {
        reason = "stopped";
        break;
      }
    }

    if (stopFlag) reason = "stopped";
    else if (Date.now() - start >= maxMs) reason = "timeout";

    // Optional replies via reply template
    if (
      includeReplies &&
      !stopFlag &&
      lastReplyKey &&
      gqlTemplates.has(lastReplyKey) &&
      replyQueue.length
    ) {
      const replyTpl = gqlTemplates.get(lastReplyKey);
      post("PROGRESS", {
        names: snapshot(),
        message: `Mengambil balasan… antrean ${replyQueue.length}`,
        postHint: "replies",
      });
      const unique = [...new Set(replyQueue)].slice(0, 25);
      const REPLY_BUDGET = 40;
      let replyRequests = 0;
      let replyFailStreak = 0;
      for (const fbId of unique) {
        if (stopFlag || Date.now() - start >= maxMs) break;
        if (replyRequests >= REPLY_BUDGET) break;
        try {
          // inject feedback id into variables if present
          const vars = replyTpl.variables
            ? JSON.parse(JSON.stringify(replyTpl.variables))
            : {};
          // Reply queries may name the feedback field differently per template
          // shape — set whichever key the captured variables actually use.
          if ("id" in vars) vars.id = fbId;
          else if ("feedbackID" in vars) vars.feedbackID = fbId;
          else if ("feedback_id" in vars) vars.feedback_id = fbId;
          else vars.id = fbId;
          const tpl = {
            ...replyTpl,
            variables: vars,
            params: { ...replyTpl.params },
          };
          let rCursor = null;
          for (let p = 0; p < 8 && !stopFlag; p++) {
            if (
              replyRequests >= REPLY_BUDGET ||
              requestBudget >= REQUEST_BUDGET ||
              Date.now() - start >= maxMs
            )
              break;
            const r = await graphqlReplayWithBackoff(
              { ...tpl, variables: setCursorOnVariables(vars, rCursor) },
              rCursor,
              deadline
            );
            replyRequests++;
            if (!r.page?.hasNext || !r.page?.endCursor) break;
            rCursor = r.page.endCursor;
            if (!(await sleepWhile(400 + Math.random() * 400))) break;
          }
          replyFailStreak = 0;
        } catch (err) {
          const kind = err && err.kind;
          // 429 / sesi kadaluarsa di balasan = hentikan seluruh run (jangan hammer)
          if (kind === "no_login")
            return {
              mode: "graphql",
              reason: "no_login",
              error: String(err.message || err),
            };
          if (kind === "rate_limit")
            return {
              mode: "graphql",
              reason: "rate_limit",
              error: String(err.message || err),
            };
          if (kind === "stopped") return { mode: "graphql", reason: "stopped" };
          replyFailStreak++;
          if (replyFailStreak >= 2) break;
        }
        post("PROGRESS", {
          names: snapshot(),
          message: `Balasan… ${nameMap.size} nama`,
          postHint: "replies",
        });
      }
    }

    return { mode: "graphql", reason, pages };
  }

  // ---------------- DOM fallback (kept as secondary) ----------------
  function qsa(sel, root) {
    try {
      return [...(root || document).querySelectorAll(sel)];
    } catch {
      return [];
    }
  }

  function isVisible(el) {
    if (!el?.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
  }

  function isProfileHref(href) {
    if (!href || href === "#" || href.includes("javascript:")) return false;
    if (!/facebook\.com|^\//i.test(href)) return false;
    if (
      /\/(posts|photos|videos|reel|watch|stories|story\.php|permalink\.php|events|marketplace|gaming|ads|help|settings|privacy|policies|login|groups|pages)/i.test(
        href
      )
    )
      return false;
    if (href.includes("comment_id")) return false;
    return (
      /profile\.php\?id=\d+/i.test(href) ||
      /facebook\.com\/[A-Za-z0-9.\u00C0-\u024F_-]{2,}/i.test(href) ||
      /^\/[A-Za-z0-9.\u00C0-\u024F_-]{2,}(\/|\?|$)/i.test(href)
    );
  }

  function findPostRoot() {
    const marked = document.querySelector("[data-fnk-post-root='1']");
    if (marked) return marked;
    const candidates = [
      ...document.querySelectorAll(
        'div[role="article"], div[data-pagelet*="FeedUnit"], div[data-pagelet*="Permalink"], div[data-pagelet*="CometSinglePost"]'
      ),
    ];
    let best = null;
    let bestScore = -1;
    const vh = window.innerHeight || 800;
    for (const el of candidates) {
      const r = el.getBoundingClientRect();
      const mid = (r.top + r.bottom) / 2;
      let score = 1000 - Math.abs(mid - vh / 2);
      const t = (el.innerText || "").slice(0, 300);
      if (/comment|komentar|most relevant|paling relevan/i.test(t)) score += 400;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return (
      best ||
      document.querySelector('[role="main"]') ||
      document.body ||
      document.documentElement
    );
  }

  function scrapeDomNames(root) {
    const scope = root || postRoot || document;
    const before = nameMap.size;

    const labelPatterns = [
      /^(?:Comment|Reply|Komentar|Balasan)(?:\s+by|\s+oleh|\s+dari|\s+from)?\s+(.+)$/i,
      /^(.+?)\s+(?:commented|berkomentar|replied|membalas)\b/i,
    ];
    qsa("[aria-label]", scope).forEach((el) => {
      const label = el.getAttribute("aria-label") || "";
      if (label.length < 3 || label.length > 160) return;
      for (const re of labelPatterns) {
        const m = label.match(re);
        if (m) {
          addName(m[1].split(/\s{2,}|\s+[·•]\s+/)[0]);
          return;
        }
      }
    });

    qsa('[role="article"]', scope).forEach((art) => {
      const ariaRaw = art.getAttribute("aria-label") || "";
      if (/^(post by|posting by|post oleh|status by|shared by)\b/i.test(ariaRaw.trim()))
        return;
      const aria = ariaRaw.toLowerCase();
      const looksComment =
        /comment|komentar|reply|balas/.test(aria) ||
        (art.querySelector('[role="button"]') &&
          /like|suka|reply|balas/i.test(art.innerText || ""));
      if (!looksComment && !aria) {
        const btns = [...art.querySelectorAll('[role="button"]')]
          .map((b) => (b.innerText || "").toLowerCase())
          .join(" ");
        if (!/(like|suka)/.test(btns) || !/(reply|balas)/.test(btns)) return;
      }
      for (const a of art.querySelectorAll('a[role="link"], a[href]')) {
        const href = a.href || "";
        if (!isProfileHref(href)) continue;
        const text = (a.innerText || "").replace(/\s+/g, " ").trim();
        if (text && text.length < 80) {
          addName(text);
          break;
        }
      }
    });

    qsa('[role="button"]', scope).forEach((btn) => {
      if (!isVisible(btn)) return;
      const t = `${btn.innerText || ""} ${btn.getAttribute("aria-label") || ""}`
        .trim()
        .toLowerCase();
      if (!/^(reply|balas)\b/i.test(t)) return;
      let row = btn.parentElement;
      for (let i = 0; i < 8 && row; i++) {
        if (row.getAttribute?.("role") === "article") break;
        if (row.querySelector("a[href]")) break;
        row = row.parentElement;
      }
      if (!row) return;
      if (/^(post by|post oleh)\b/i.test((row.getAttribute?.("aria-label") || "").trim()))
        return;
      for (const a of row.querySelectorAll("a[href]")) {
        if (!isProfileHref(a.href || "")) continue;
        const text = (a.innerText || "").replace(/\s+/g, " ").trim();
        if (text) {
          addName(text);
          break;
        }
      }
    });

    return nameMap.size - before;
  }

  function findExpandButtons(root) {
    const soft =
      /view more comments|see more comments|lihat komentar|previous comments|komentar sebelumnya|view more replies|lihat balasan|more comments|more replies|lihat selengkapnya|show more|tampilkan/i;
    const out = [];
    qsa('[role="button"], div[tabindex="0"]', root || document).forEach((el) => {
      if (!isVisible(el)) return;
      const t = `${el.innerText || ""} ${el.getAttribute("aria-label") || ""}`
        .replace(/\s+/g, " ")
        .trim();
      if (t && t.length < 120 && soft.test(t)) out.push(el);
    });
    return out;
  }

  async function tryOpenComments(scope) {
    // Already open? (post article + nested comment articles)
    if (scope && scope.querySelectorAll('[role="article"]').length > 1) return true;
    const COMMENT_COUNT = /^\d[\d.,\s]*(?:k|rb)?\s*(?:komentar|comments?)\b/i;
    const VIEW_COMMENTS =
      /view.*(?:comment|komentar)|lihat.*komentar|lihat\s+semua\s+komentar/i;
    const els = qsa(
      '[role="button"], a[role="link"], [role="tab"], [aria-label], span[dir="auto"]',
      scope || document
    );
    for (const el of els) {
      if (!isVisible(el)) continue;
      const t = `${el.innerText || ""} ${el.getAttribute("aria-label") || ""}`
        .replace(/\s+/g, " ")
        .trim();
      if (!t || t.length > 120) continue;
      if (!COMMENT_COUNT.test(t) && !VIEW_COMMENTS.test(t)) continue;
      try {
        el.scrollIntoView({ block: "center" });
        el.click();
        await sleepWhile(700);
        if (gqlTemplates.size > 0) return true;
      } catch {
        /* ignore */
      }
    }
    return false;
  }

  /** Scrollable comment container (so we scroll the list, not the whole page). */
  function findScrollContainer(root) {
    if (!root) return null;
    const els = [root, ...root.querySelectorAll("*")];
    for (let i = 0; i < els.length && i < 3000; i++) {
      const el = els[i];
      if (el.scrollHeight > el.clientHeight + 80) {
        const st = getComputedStyle(el);
        if (st.overflowY === "auto" || st.overflowY === "scroll") return el;
      }
    }
    return null;
  }

  async function expandDomLoop(maxMs) {
    const start = Date.now();
    const savedScrollY = window.scrollY;
    const scroller = findScrollContainer(postRoot);
    let idle = 0;
    let rounds = 0;
    while (running && !stopFlag && Date.now() - start < maxMs) {
      rounds++;
      const before = nameMap.size;
      scrapeDomNames(postRoot);
      drainGqlBuffer();
      const btns = findExpandButtons(postRoot);
      for (const b of btns.slice(0, 4)) {
        try {
          b.click();
        } catch {
          /* ignore */
        }
        await sleepWhile(300);
      }
      try {
        // Scroll HANYA kontainer komentar dalam post — JANGAN pernah menggeser
        // halaman (window.scrollBy): di feed/profil itu pindah ke postingan
        // lain dan komentarnya ikut ter-rekap (kontaminasi lintas post).
        if (scroller) scroller.scrollTop += 400;
      } catch {
        /* ignore */
      }
      post("PROGRESS", {
        names: snapshot(),
        message: `Fallback DOM… ${nameMap.size} nama (putaran ${rounds})`,
        postHint: "dom",
      });
      if (nameMap.size === before) idle++;
      else idle = 0;
      if (nameMap.size === 0 && idle >= 18) break;
      if (nameMap.size > 0 && idle >= 10) break;
      if (!(await sleepWhile(500))) break;
    }
    // Restore scroll position after DOM expansion
    try { window.scrollTo(0, savedScrollY); } catch { /* ignore */ }
    return nameMap.size ? "complete" : "idle";
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Sleep interruptible — resolve false kalau Stop ditekan (cek tiap 200 ms). */
  async function sleepWhile(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (stopFlag) return false;
      await sleep(Math.min(200, Math.max(20, end - Date.now())));
    }
    return true;
  }

  // ---------------- main run ----------------
  async function runExtract(options = {}) {
    const myRunId = options.runId || String(Date.now());

    if (running) {
      stopFlag = true;
      const t0 = Date.now();
      while (running && Date.now() - t0 < 4000) await sleep(80);
      running = false;
      stopFlag = false;
    }

    running = true;
    stopFlag = false;
    nameMap.clear();
    currentRunId = myRunId;
    includeReplies = options.includeReplies !== false;
    engineMode = "hybrid";
    options._startedAt = Date.now();
    postRoot = findPostRoot();
    if (postRoot) {
      try {
        postRoot.setAttribute("data-fnk-active", "1");
      } catch {
        /* ignore */
      }
    }
    lastNewAt = Date.now();
    activeFeedbackId = null;
    // Simpan posisi scroll agar di akhir run halaman kembali ke postingan
    // yang sama (bukan melayang ke postingan di atas/bawahnya).
    const savedScrollY = window.scrollY;

    post("PROGRESS", {
      names: [],
      message: "Memulai mesin GraphQL (pagination aktif)… buka komentar bila perlu",
      postHint: `templates:${gqlTemplates.size} buffer:${gqlBuffer.length}`,
    });

    try {
      // 1) Ensure comments are loading so we capture GraphQL templates
      await tryOpenComments(postRoot);
      await sleepWhile(800);
      drainGqlBuffer();
      scrapeDomNames(postRoot);

      // 1b) Synthetic template langsung dari feedback id di URL (permalink).
      //     Selalu ditambahkan saat URL memberi id — bukan hanya saat tidak ada
      //     capture: di halaman permalink yang tepat, synthetic (id dari URL)
      //     memenangkan urutan candidate via filter feedbackId di
      //     orderedCandidates (anti salah post, setara mediaId filter IG).
      //     Sekaligus membuat halaman album/watch/slug-posts langsung bisa
      //     paginate GraphQL tanpa perlu komentar ter-capture dulu.
      if (!stopFlag && feedbackIdsFromUrl().length) {
        const syns = buildSyntheticPaginationTemplates();
        syns.forEach((syn, i) => {
          gqlTemplates.set(
            syns.length > 1 ? `__synthetic__${i}` : "__synthetic__",
            syn
          );
        });
        if (syns.length) {
          lastTopLevelKey =
            syns.length > 1 ? "__synthetic__0" : "__synthetic__";
        }
      }

      // 2) If no template yet, scroll/expand a bit to trigger FB requests
      if (gqlTemplates.size === 0) {
        post("PROGRESS", {
          names: snapshot(),
          message: "Menunggu request GraphQL komentar dari Facebook…",
          postHint: "capture",
        });
        for (let i = 0; i < 12 && !stopFlag && gqlTemplates.size === 0; i++) {
          for (const b of findExpandButtons(postRoot).slice(0, 3)) {
            try {
              b.click();
            } catch {
              /* ignore */
            }
          }
          scrapeDomNames(postRoot);
          drainGqlBuffer();
          await sleepWhile(700);
          post("PROGRESS", {
            names: snapshot(),
            message: `Menunggu GraphQL… template=${gqlTemplates.size}, nama=${nameMap.size}`,
            postHint: "capture",
          });
        }
      }

      const maxMs = options.maxMs || 150_000;
      const startedAt = options._startedAt || Date.now();
      let finalReason = "idle";

      // Reserve time for DOM harvest so GraphQL cannot consume the entire budget
      const reserveDomMs = 12_000;
      const gqlBudget = Math.max(20_000, maxMs - reserveDomMs);

      // 3) Primary: GraphQL pagination (synthetic dari URL + template capture)
      if (gqlTemplates.size > 0 && !stopFlag) {
        const g = await paginateGraphql(gqlBudget);
        finalReason = g.reason || "complete";
        engineMode = g.mode === "graphql" ? "graphql" : engineMode;
        if (g.error) {
          post("PROGRESS", {
            names: snapshot(),
            message: `GraphQL error: ${g.error} — fallback DOM`,
            postHint: "error",
          });
        }
      }

      // 4) Secondary: always brief DOM harvest; longer if GraphQL yielded little
      if (!stopFlag) {
        const remaining = Math.max(0, maxMs - (Date.now() - startedAt));
        const needDeep = nameMap.size < 8;
        const domBudget = needDeep
          ? Math.min(60_000, remaining)
          : Math.min(12_000, remaining);
        if (domBudget >= 1500) {
          engineMode =
            gqlTemplates.size > 0 && nameMap.size > 0
              ? "hybrid"
              : nameMap.size
                ? "hybrid"
                : "dom";
          post("PROGRESS", {
            names: snapshot(),
            message: `Melengkapi lewat DOM… (${nameMap.size} nama)`,
            postHint: "dom",
          });
          const domReason = await expandDomLoop(domBudget);
          if (nameMap.size > 0) finalReason = domReason;
        }
      }

      // 5) Final harvest — scope ke postRoot (anti kontaminasi postingan lain)
      drainGqlBuffer();
      scrapeDomNames(postRoot);

      if (stopFlag) finalReason = "stopped";
      if (nameMap.size > 0 && finalReason === "idle") finalReason = "complete";
      if (nameMap.size === 0 && finalReason === "complete") finalReason = "idle";

      if (currentRunId === myRunId) {
        const names = snapshot();
        let tip = "";
        if (finalReason === "rate_limit") {
          tip =
            " Rate limit (429) — berhenti agar akun aman. Tunggu beberapa saat, lalu Proses lagi.";
        } else if (finalReason === "no_login") {
          tip = " Sesi Facebook tidak aktif — login di facebook.com lalu Proses lagi.";
        } else if (!names.length) {
          tip =
            " Tip: buka permalink post, buka list komentar sampai terlihat, tunggu 2–3 dtk, lalu Proses lagi (biar GraphQL ter-capture).";
        }
        post("DONE", {
          names,
          stopReason: finalReason,
          postHint: `${engineMode}${tip}`,
        });
      }
    } catch (err) {
      if (currentRunId === myRunId) {
        post("ERROR", {
          message: String(err?.message || err),
          stopReason: "error",
        });
      }
    } finally {
      if (currentRunId === myRunId) {
        running = false;
        stopFlag = false;
        try {
          postRoot?.removeAttribute?.("data-fnk-active");
        } catch {
          /* ignore */
        }
        // Kembalikan posisi scroll ke titik sebelum run dimulai.
        try {
          window.scrollTo(0, savedScrollY);
        } catch {
          /* ignore */
        }
      }
    }
  }

  function stopExtract() {
    stopFlag = true;
  }

  // Control plane: non-enumerable API for background executeScript only.
  // Page scripts can still discover it (MAIN world limit) — not via postMessage.
  try {
    Object.defineProperty(window, "__RESO_FNK__", {
      configurable: true,
      enumerable: false,
      writable: false,
      value: Object.freeze({
        version: VERSION,
        start: (opts) => {
          runExtract(opts || {});
        },
        stop: () => {
          stopExtract();
        },
        ping: () => ({ ok: true, version: VERSION, running }),
      }),
    });
  } catch {
    window.__RESO_FNK__ = {
      version: VERSION,
      start: runExtract,
      stop: stopExtract,
      ping: () => ({ ok: true, version: VERSION, running }),
    };
  }

  post("READY", { version: VERSION });
})();
