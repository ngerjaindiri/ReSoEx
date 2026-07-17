/**
 * MAIN-world engine — FB Nama Komentar v1.5
 * Mesin GraphQL pagination aktif (setara store-grade), output hanya nama.
 *
 * Primary: capture Facebook /api/graphql comment requests → replay with cursor
 * Secondary: always-on response buffer + multi-strategy DOM
 */
(function () {
  const SOURCE = "fb-nama-komentar-inject";
  const VERSION = 6;

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
  /** @type {Element | null} */
  let postRoot = null;
  let engineMode = "idle"; // graphql | hybrid | dom

  /** Data-plane only (PROGRESS/DONE/ERROR). Control plane is ENGINE_CMD via executeScript. */
  function post(type, payload = {}) {
    window.postMessage(
      { source: SOURCE, type, runId: currentRunId, ...payload },
      "*"
    );
  }

  // ---------------- names ----------------
  function normalizeName(raw) {
    if (typeof raw !== "string") return "";
    let name = raw
      .replace(/\u200b|\u200c|\u200d|\ufeff/g, "")
      .replace(/\s+/g, " ")
      .trim();
    name = name.replace(/\s+[·•|].*$/, "").trim();
    // 1) Indonesian non-numeric: "sehari yang lalu", "sekitar satu jam yang lalu"
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
    // 2) English: "about 3 hours ago", "a minute ago", "just now"
    name = name.replace(
      /\s+(about\s+)?(a|an|\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago.*$/i,
      ""
    );
    name = name.replace(/\s+just\s+now.*$/i, "");
    // 3) Generic numeric: "3d", "5h", "2 jam" (run LAST so specific patterns match first)
    name = name.replace(
      /\s+\d+\s*(d|h|m|w|y|jam|menit|hari|minggu|tahun|bulan|hr|min|detik|sec|second|minute|hour|day|week|month|year)s?\b.*$/i,
      ""
    );
    name = name.replace(/\s+Edited$/i, "").trim();
    if (/\bis with\b/i.test(name)) name = name.split(/\bis with\b/i)[0].trim();
    if (!name || name.length < 2 || name.length > 100) return "";
    if (name.startsWith("@")) return "";
    if (/^\d+$/.test(name)) return "";
    // URLs with protocol
    if (/https?:\/\//i.test(name) || /@\w+\.\w+/.test(name)) return "";
    // Short URLs without protocol (wa.me, bit.ly, t.co, etc.)
    if (/^(wa\.me|bit\.ly|t\.co|goo\.gl|tinyurl\.com|s\.id|link\.)\b/i.test(name)) return "";
    if (/\b(wa\.me|bit\.ly|t\.co)\b/i.test(name)) return "";
    // Generic domain-like pattern: "word.tld/path"
    if (/^[a-z0-9][-a-z0-9]*\.[a-z]{2,6}\//i.test(name)) return "";
    const blocked = [
      /^view\b/i, /^see\b/i, /^like\b/i, /^likes$/i, /^reply\b/i, /^share\b/i,
      /^comment\b/i, /^write\b/i, /^log\s*in/i, /^sign\s*up/i, /^facebook$/i,
      /^meta$/i, /^suka$/i, /^balas$/i, /^bagikan$/i, /^komentar$/i, /^tulis/i,
      /^lihat/i, /^tampilkan/i, /^semua$/i, /^most relevant$/i, /^all comments$/i,
      /^newest$/i, /^terbaru$/i, /^paling relevan$/i, /^edited$/i, /^sponsor/i,
      /^follow$/i, /^ikuti$/i, /^send\b/i, /^kirim$/i, /^hide\b/i, /^open\b/i,
      /^photo$/i, /^video$/i, /^reels?$/i, /^add a comment/i, /^tulis komentar/i,
      /^write a comment/i, /^see more$/i, /^lihat selengkapnya$/i,
    ];
    if (blocked.some((re) => re.test(name))) return "";
    try {
      if (!/[\p{L}\p{N}]/u.test(name)) return "";
    } catch {
      if (!/[a-zA-Z0-9\u00C0-\u024F]/.test(name)) return "";
    }
    return name;
  }

  function addName(raw) {
    const name = normalizeName(raw);
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
    const patterns = [
      /"__typename"\s*:\s*"Comment"[\s\S]{0,1500}?"author"\s*:\s*\{[\s\S]{0,600}?"name"\s*:\s*"((?:\\.|[^"\\]){2,100})"/g,
      /"author"\s*:\s*\{[\s\S]{0,400}?"__typename"\s*:\s*"User"[\s\S]{0,300}?"name"\s*:\s*"((?:\\.|[^"\\]){2,100})"/g,
      /"author"\s*:\s*\{[\s\S]{0,300}?"name"\s*:\s*"((?:\\.|[^"\\]){2,100})"[\s\S]{0,300}?"__typename"\s*:\s*"User"/g,
      /"created_time"\s*:\s*\d+[\s\S]{0,500}?"author"\s*:\s*\{[\s\S]{0,400}?"name"\s*:\s*"((?:\\.|[^"\\]){2,100})"/g,
      /"author"\s*:\s*\{[\s\S]{0,400}?"name"\s*:\s*"((?:\\.|[^"\\]){2,100})"[\s\S]{0,500}?"created_time"\s*:\s*\d+/g,
      /"body"\s*:\s*\{[^}]{0,200}"text"\s*:\s*"[^"]{0,500}"[\s\S]{0,400}?"author"\s*:\s*\{[\s\S]{0,400}?"name"\s*:\s*"((?:\\.|[^"\\]){2,100})"/g,
    ];
    for (const re of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        try {
          addName(JSON.parse(`"${m[1]}"`));
        } catch {
          addName(m[1]);
        }
      }
    }
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
    if (typeof obj.id === "string" && obj.id.length > 10 && /feedback/i.test(JSON.stringify(obj.__typename || "")))
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
      try {
        if (isGraphqlUrl(url)) {
          res
            .clone()
            .text()
            .then((t) => {
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
  function getDtsg() {
    try {
      const html = document.documentElement?.innerHTML || "";
      let m = html.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/);
      if (m) return m[1];
      m = html.match(/"token":"([A-Za-z0-9_:-]{8,})"[,}][^"]{0,40}DTSG/);
      if (m) return m[1];
      m = html.match(/name="fb_dtsg"\s+value="([^"]+)"/);
      if (m) return m[1];
      m = html.match(/"dtsg":\{"token":"([^"]+)"/);
      if (m) return m[1];
    } catch {
      /* ignore */
    }
    try {
      if (typeof require === "function") {
        const d =
          require("DTSGInitialData") ||
          require("DTSG") ||
          require("DTSGInitData");
        if (d?.token) return d.token;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  function getLsd() {
    try {
      const html = document.documentElement?.innerHTML || "";
      const m = html.match(/"LSD",\[\],\{"token":"([^"]+)"/);
      if (m) return m[1];
      const inp = document.querySelector('input[name="lsd"]');
      if (inp?.value) return inp.value;
    } catch {
      /* ignore */
    }
    return null;
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
    const params = { ...template.params };
    let variables = template.variables
      ? setCursorOnVariables(template.variables, cursor)
      : { after: cursor };

    // Refresh anti-forgery tokens
    const dtsg = getDtsg();
    if (dtsg) {
      params.fb_dtsg = dtsg;
      if ("fb_dtsg" in params) params.fb_dtsg = dtsg;
    }
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
    const res = await fetch(url, {
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
    const text = await res.text();
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

  async function paginateGraphql(maxMs) {
    // Prefer newest top-level comment template
    let template =
      (lastTopLevelKey && gqlTemplates.get(lastTopLevelKey)) ||
      [...gqlTemplates.values()].sort((a, b) => b.capturedAt - a.capturedAt)[0];

    if (!template) return { mode: "none", reason: "no_template" };

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

    while (running && !stopFlag && Date.now() - start < maxMs) {
      const before = nameMap.size;
      let result;
      try {
        result = await graphqlReplay(template, cursor);
      } catch (err) {
        return {
          mode: "graphql",
          reason: nameMap.size ? "timeout" : "error",
          error: String(err?.message || err),
        };
      }

      pages++;
      if (result.replyIds?.length) replyQueue.push(...result.replyIds);

      post("PROGRESS", {
        names: snapshot(),
        message: `GraphQL halaman ${pages}… ${nameMap.size} nama`,
        postHint: template.friendlyName,
      });

      if (nameMap.size === before) idle++;
      else idle = 0;

      const hasNext = result.page?.hasNext;
      const endCursor = result.page?.endCursor;

      if (!hasNext || !endCursor) {
        reason = "complete";
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
      await sleep(500 + Math.random() * 700);
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
      for (const fbId of unique) {
        if (stopFlag || Date.now() - start >= maxMs) break;
        try {
          // inject feedback id into variables if present
          const vars = replyTpl.variables
            ? JSON.parse(JSON.stringify(replyTpl.variables))
            : {};
          if ("id" in vars) vars.id = fbId;
          else vars.id = fbId;
          const tpl = {
            ...replyTpl,
            variables: vars,
            params: { ...replyTpl.params },
          };
          let rCursor = null;
          for (let p = 0; p < 8 && !stopFlag; p++) {
            const r = await graphqlReplay(
              { ...tpl, variables: setCursorOnVariables(vars, rCursor) },
              rCursor
            );
            if (!r.page?.hasNext || !r.page?.endCursor) break;
            rCursor = r.page.endCursor;
            await sleep(400 + Math.random() * 400);
          }
        } catch {
          /* ignore one reply thread */
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
    for (const el of qsa('[role="button"], a[role="link"]', scope || document)) {
      const t = `${el.innerText || ""} ${el.getAttribute("aria-label") || ""}`.trim();
      if (
        /^\d[\d.,\s]*\s*(comments?|komentar)/i.test(t) ||
        /view.*(comment|komentar)|lihat.*komentar/i.test(t)
      ) {
        try {
          el.click();
          await sleep(600);
          return true;
        } catch {
          /* ignore */
        }
      }
    }
    return false;
  }

  async function expandDomLoop(maxMs) {
    const start = Date.now();
    const savedScrollY = window.scrollY;
    let idle = 0;
    let rounds = 0;
    while (running && !stopFlag && Date.now() - start < maxMs) {
      rounds++;
      const before = nameMap.size;
      scrapeDomNames(postRoot);
      if (nameMap.size < 3) scrapeDomNames(document);
      drainGqlBuffer();
      const btns = findExpandButtons(postRoot).concat(findExpandButtons(document));
      for (const b of btns.slice(0, 4)) {
        try {
          b.click();
        } catch {
          /* ignore */
        }
        await sleep(300);
      }
      try {
        window.scrollBy(0, 350);
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
      await sleep(500);
    }
    // Restore scroll position after DOM expansion
    try { window.scrollTo(0, savedScrollY); } catch { /* ignore */ }
    return nameMap.size ? "complete" : "idle";
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

    post("PROGRESS", {
      names: [],
      message: "Memulai mesin GraphQL (pagination aktif)… buka komentar bila perlu",
      postHint: `templates:${gqlTemplates.size} buffer:${gqlBuffer.length}`,
    });

    try {
      // 1) Ensure comments are loading so we capture GraphQL templates
      await tryOpenComments(postRoot);
      await sleep(800);
      drainGqlBuffer();
      scrapeDomNames(postRoot);

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
          scrapeDomNames(document);
          drainGqlBuffer();
          await sleep(700);
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

      // 3) Primary: GraphQL pagination (ESuit-like)
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

      // 5) Final harvest
      drainGqlBuffer();
      scrapeDomNames(document);

      if (stopFlag) finalReason = "stopped";
      if (nameMap.size > 0 && finalReason === "idle") finalReason = "complete";
      if (nameMap.size === 0 && finalReason === "complete") finalReason = "idle";

      if (currentRunId === myRunId) {
        const names = snapshot();
        let tip = "";
        if (!names.length) {
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
