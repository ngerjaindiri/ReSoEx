/**
 * MAIN-world engine — Instagram Username Komentar
 * Replay api/v1/media/{id}/comments/ | username only (no @, lowercase) | runId | delay
 */
(function () {
  const SOURCE = "ig-nama-komentar-inject";

  if (window.__ING_ENGINE__) {
    // Engine already live; ENGINE_CMD uses non-enumerable __RESO_ING__
    return;
  }
  window.__ING_ENGINE__ = true;

  const IG_APP_ID = "936619743392459";

  /** Captured / provided comments API URL template (closure only) */
  let engineTemplateUrl = null;

  /** @type {Map<string, string>} */
  const nameMap = new Map();
  let running = false;
  let stopFlag = false;
  let lastNewAt = Date.now();
  let includeReplies = false;
  let activeMediaId = null;
  let currentRunId = null;
  /** Total API requests this run (budget guard — protect the user's IG account) */
  let requestBudget = 0;
  const BUDGET = 150;
  /** Extra cap for reply (inline child comment) requests — replies must never starve top-level pagination. */
  const REPLY_BUDGET = 40;

  /** Data-plane only. Control plane is ENGINE_CMD via executeScript. */
  function post(type, payload = {}) {
    window.postMessage(
      { source: SOURCE, type, runId: currentRunId, ...payload },
      "*"
    );
  }

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

  function addUsername(raw) {
    const u = normalizeInstagramUsername(raw);
    if (!u) return false;
    const key = u;
    if (nameMap.has(key)) return false;
    nameMap.set(key, u);
    lastNewAt = Date.now();
    return true;
  }

  function snapshot() {
    return [...nameMap.values()];
  }

  function extractMediaIdFromUrl(url) {
    const m = String(url || "").match(
      /instagram\.com\/api\/v1\/media\/(\d+)\//
    );
    return m ? m[1] : null;
  }

  /** Best-effort media_id from the page's embedded JSON (script tags). */
  function extractMediaIdFromPage() {
    const scripts = document.querySelectorAll("script");
    for (let i = 0; i < Math.min(scripts.length, 40); i++) {
      const t = scripts[i].textContent || "";
      if (!t.includes("media_id")) continue;
      const m =
        t.match(/"media_id"\s*:\s*"?(\d{5,})/) ||
        t.match(/media_id%22%3A%22(\d{5,})/);
      if (m) return m[1];
    }
    return null;
  }

  function extractShortcodeFromUrl(url) {
    const m = String(url || "").match(
      /instagram\.com\/(?:share\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i
    );
    return m ? m[1] : null;
  }

  // ---- IG API payload ingest ----

  function parsePage(data, isReplyPage = false) {
    const comments = Array.isArray(data?.comments) ? data.comments : [];
    for (const u of parseIgComments(data)) addUsername(u);
    const replyTargets = [];
    for (const c of comments) {
      if (!c || typeof c !== "object") continue;
      const id = c?.comment_id || c?.pk || c?.id;
      const childCount = Number(c?.child_comment_count || 0);
      if (id && childCount > 0) {
        replyTargets.push({ commentId: String(id), total: childCount });
      }
    }
    // Top-level: has_more_comments (primary) or has_more; cursor = next_max_id.
    // Reply pages: has_more_tail_child_comments / next_max_child_cursor.
    const hasMore = isReplyPage
      ? !!(data?.has_more_tail_child_comments || data?.has_more_child_comments)
      : !!(
          data?.has_more_comments === true ||
          data?.has_more_comments === 1 ||
          data?.has_more === true ||
          data?.has_more === 1 ||
          data?.has_more === "1"
        );
    const nextMaxId = isReplyPage
      ? typeof data?.next_max_child_cursor === "string" &&
        data.next_max_child_cursor
        ? data.next_max_child_cursor
        : typeof data?.next_max_child_id === "string" &&
            data.next_max_child_id
          ? data.next_max_child_id
          : null
      : data?.next_max_id != null && String(data.next_max_id) !== ""
        ? String(data.next_max_id)
        : null;
    return {
      hasMore: !!hasMore,
      nextMaxId,
      batchSize: comments.length,
      replyTargets,
    };
  }

  function looksLikeCommentsApi(url) {
    if (!url) return false;
    const u = String(url).toLowerCase();
    return (
      u.includes("instagram.com/api/v1/media/") && u.includes("/comments/")
    );
  }

  function tryParseResponse(url, text) {
    if (!running) return;
    if (!looksLikeCommentsApi(url) && !text?.includes('"comments"')) return;
    try {
      const data = JSON.parse(text);
      if (data && typeof data === "object") parsePage(data);
    } catch {
      /* ignore */
    }
  }

  // ---- network intercept (complements background webRequest capture) ----
  if (!window.__ING_NET__) {
    window.__ING_NET__ = true;
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      const res = await origFetch.apply(this, args);
      try {
        const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
        if (running && looksLikeCommentsApi(url)) {
          res
            .clone()
            .text()
            .then((t) => tryParseResponse(url, t))
            .catch(() => {});
        }
      } catch {
        /* ignore */
      }
      return res;
    };

    const oOpen = XMLHttpRequest.prototype.open;
    const oSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__ing_url = url;
      return oOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener("load", function () {
        try {
          if (!running) return;
          if (!looksLikeCommentsApi(this.__ing_url)) return;
          if (typeof this.responseText === "string") {
            tryParseResponse(this.__ing_url, this.responseText);
          }
        } catch {
          /* ignore */
        }
      });
      return oSend.apply(this, args);
    };
  }

  // ---- URL building & fetching ----

  function stripVolatileParams(u) {
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
    return u;
  }

  function buildUrl(
    templateUrl,
    { nextMaxId, reply, commentId, mediaId, replyEndpoint }
  ) {
    if (!templateUrl) return null;
    let base = templateUrl;
    // Replay harus menyasar post yang SEDANG dibuka, bukan media asal template:
    // template bisa berasal dari post lain (ter-capture sebelumnya, masih dalam
    // TTL) — tulis ulang segmen media_id di path seperti TikTok menulis aweme_id.
    const mid = mediaId || activeMediaId || null;
    if (mid) {
      base = base.replace(
        /\/api\/v1\/media\/\d+\//,
        `/api/v1/media/${mid}/`
      );
    }
    if (reply && commentId) {
      // Versi klien IG berbeda-beda: `inline_child_comments/` (mayoritas) atau
      // `child_comments/` — caller bisa memilih lewat replyEndpoint.
      const endpoint = replyEndpoint || "inline_child_comments";
      base = base.replace(
        "/comments/",
        `/comments/${encodeURIComponent(String(commentId))}/${endpoint}/`
      );
    }
    let u;
    try {
      u = new URL(base);
    } catch {
      return null;
    }
    stripVolatileParams(u);
    u.searchParams.set("can_support_threading", "true");
    if (nextMaxId) u.searchParams.set("max_id", String(nextMaxId));
    return u.toString();
  }

  function csrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/i);
    return m ? decodeURIComponent(m[1]) : "";
  }

  /**
   * Interruptible sleep — aborts early when a stop is requested, so long
   * backoff waits never leave the engine stuck past the user's Stop click.
   */
  async function sleepWhile(ms) {
    const end = Date.now() + ms;
    while (running && !stopFlag && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function parseRetryAfter(res) {
    try {
      const ra = res.headers.get("Retry-After");
      const n = parseInt(ra, 10);
      if (Number.isFinite(n) && n > 0) return Math.min(30_000, n * 1000);
    } catch {
      /* ignore */
    }
    return 0;
  }

  /**
   * Fetch one comments page with resilience built in:
   * - 429 → polite backoff (Retry-After header, else 8s/16s), max 2 retries,
   *   and only while time remains in the run budget — never hammer IG.
   * - Network blips (TypeError) → one fast retry.
   * - Checkpoint / login gates → typed errors so the run stops with a clear
   *   diagnosis instead of silently continuing (or worse, retrying after 429).
   * A PROGRESS heartbeat keeps the panel/popup alive during backoff waits.
   */
  async function fetchJson(url, ctx = {}) {
    const deadline = ctx.deadline || 0;
    const heartbeat = ctx.heartbeat || (() => {});
    const canWait = (ms) => !deadline || Date.now() + ms < deadline;
    let attempt = 0;

    // eslint-disable-next-line no-constant-condition
    for (;;) {
      attempt += 1;
      requestBudget += 1;
      let res;
      let text = "";
      try {
        const headers = {
          Accept: "application/json, text/plain, */*",
          "X-Requested-With": "XMLHttpRequest",
          "X-IG-App-ID": IG_APP_ID,
          // Web IG mengirim claim ini pada request API — menstabilkan 403
          // sesekali yang muncul saat App-ID/claim tidak cocok.
          "X-IG-WWW-Claim": "0",
          Referer: (location.origin || "https://www.instagram.com") + "/",
        };
        const csrf = csrfToken();
        if (csrf) headers["X-CSRFToken"] = csrf;
        res = await fetch(url, { credentials: "include", headers });
        text = await res.text();
      } catch (e) {
        // Network-level failure (offline, throttled tab, etc.)
        if (attempt <= 1 && canWait(1500)) {
          await sleepWhile(1500);
          if (running && !stopFlag) continue;
        }
        throw e;
      }

      if (res.status === 429) {
        const waitMs = Math.min(
          30_000,
          parseRetryAfter(res) || (attempt === 1 ? 8_000 : 16_000)
        );
        if (attempt < 3 && canWait(waitMs)) {
          heartbeat(
            `Rate limit Instagram (429) — menunggu ${Math.max(3, Math.round(waitMs / 1000))} dtk agar akun aman…`
          );
          await sleepWhile(waitMs);
          if (running && !stopFlag) continue;
        }
        const err = new Error("Rate limit Instagram (429)");
        err.rateLimited = true;
        throw err;
      }
      if (res.status === 302 || res.status === 401) {
        const err = new Error(`Login Instagram diperlukan (HTTP ${res.status})`);
        err.loginRequired = true;
        throw err;
      }
      // 403 hampir selalu blok anti-bot / App-ID ditolak, BUKAN sesi login:
      // berhenti aman dengan diagnosis akurat (jangan menyesatkan user).
      if (res.status === 403) {
        const err = new Error(
          "Instagram memblokir permintaan ini (403) — kemungkinan anti-bot atau App-ID ditolak. Berhenti agar akun aman; coba lagi beberapa saat kemudian."
        );
        err.blocked = true;
        throw err;
      }
      // 404 → endpoint/versi klien berbeda (mis. child_comments/ vs
      // inline_child_comments/): ditandai agar caller bisa fallback.
      if (res.status === 404) {
        const err = new Error("Endpoint komentar tidak ditemukan (HTTP 404)");
        err.notFound = true;
        throw err;
      }
      if (!res.ok) {
        throw new Error(`API ${res.status}: ${text.slice(0, 180)}`);
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`Respons bukan JSON: ${text.slice(0, 120)}`);
      }
      if (data && data.status === "fail") {
        const msg =
          typeof data.message === "string"
            ? data.message
            : typeof data.error_type === "string"
              ? data.error_type
              : "Permintaan Instagram ditolak";
        const err = new Error(msg);
        const et = typeof data.error_type === "string" ? data.error_type : "";
        if (
          /checkpoint|challenge_required/i.test(msg) ||
          data.checkpoint ||
          data.challenge
        ) {
          err.checkpointRequired = true;
        } else if (/login_required|login/i.test(msg)) {
          err.loginRequired = true;
        } else if (
          /please wait|few minutes|try again later|too many requests|rate limit/i.test(
            msg
          ) ||
          /PleaseWaitFewMinutes|TooManyRequests/i.test(et)
        ) {
          // Throttling yang lebih serius dari 429 — JANGAN retry dalam loop,
          // berhenti agar akun aman (pesan disimpan untuk diagnosis UI).
          err.rateLimited = true;
          err.pleaseWait = true;
        } else if (
          /feedback_required|action blocked|restricted|banned/i.test(msg) ||
          /FeedbackRequired|ActionBlocked/i.test(et)
        ) {
          // Akun dibatasi Instagram — berhenti segera, jangan lanjut.
          err.rateLimited = true;
          err.feedbackBlocked = true;
        } else if (/not found|not_found/i.test(msg) || /NotFound/i.test(et)) {
          // Endpoint tidak dikenal di versi klien ini — caller boleh fallback.
          err.notFound = true;
        }
        throw err;
      }
      return data;
    }
  }

  // ---- DOM helpers ----

  function commentDialogOpen() {
    return !!document.querySelector('[role="dialog"]');
  }

  function scrollCommentContainer() {
    const dlg = document.querySelector('[role="dialog"]');
    if (dlg) {
      try {
        dlg.scrollTop = dlg.scrollHeight;
      } catch {
        /* ignore */
      }
      return;
    }
    window.scrollBy(0, 400);
  }

  /**
   * Open the comments view automatically so IG fires the comments API and
   * the background can capture the URL template — no manual click needed.
   */
  async function tryOpenComments() {
    if (commentDialogOpen()) {
      scrollCommentContainer();
      return true;
    }
    const candidates = [
      'svg[aria-label*="comment" i]',
      'svg[aria-label*="komentar" i]',
      'button[aria-label*="comment" i]',
      'button[aria-label*="komentar" i]',
      'button[aria-label*="view all comments" i]',
      'button[aria-label*="lihat semua komentar" i]',
      '[aria-label*="view all" i]',
      '[aria-label*="lihat semua" i]',
      '[aria-label*="comment" i]',
      '[aria-label*="komentar" i]',
      'a[href*="/comments/"]',
      '[data-pressable-container] svg[aria-label*="message" i]',
    ];
    for (const sel of candidates) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const target =
          el.closest("button, a, [role='button'], [data-pressable-container]") ||
          el;
        try {
          target.click();
          await sleepWhile(600);
          if (commentDialogOpen()) return true;
        } catch {
          /* try next candidate */
        }
      }
    }
    // Text-based fallback: "View all comments" / "Lihat semua komentar"
    try {
      const textEls = document.querySelectorAll(
        "button, a[role='link'], div[role='button'], span[dir='auto']"
      );
      for (const el of textEls) {
        const t = (el.innerText || el.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        if (!t || t.length > 120) continue;
        if (
          !/(view all|see all|lihat semua|tampilkan semua)[\s\S]{0,40}(comments?|komentar)/i.test(
            t
          )
        )
          continue;
        const target = el.closest("button, a, [role='button']") || el;
        try {
          target.click();
          await sleepWhile(600);
          if (commentDialogOpen()) return true;
        } catch {
          /* try next */
        }
      }
    } catch {
      /* ignore */
    }
    // If no dialog, at least scroll the page (inline comments on some layouts)
    window.scrollBy(0, 500);
    return commentDialogOpen();
  }

  /** Fallback: usernames from profile links inside the comments dialog / main. */
  function scrapeDomUsernames() {
    let added = 0;
    const scopes = [];
    const dlg = document.querySelector('[role="dialog"]');
    if (dlg) scopes.push(dlg);
    const main = document.querySelector("main");
    if (main) scopes.push(main);

    const profileRe = /^\/[a-zA-Z0-9._]{1,30}\/?$/;
    const seen = new Set();
    for (const scope of scopes) {
      const anchors = scope.querySelectorAll("a[href]");
      for (const a of anchors) {
        // Skip nav/header chrome (suggested profiles in the sidebar are noisy)
        if (a.closest("nav, header")) continue;
        const href = a.getAttribute("href") || "";
        if (!profileRe.test(href)) continue;
        const u = href.replace(/^\/|\/$/g, "");
        if (seen.has(u)) continue;
        seen.add(u);
        if (addUsername(u)) added++;
      }
    }
    return added;
  }

  async function paginateList(templateUrl, mediaId, maxMs) {
    const start = Date.now();
    const deadline = start + maxMs;
    const heartbeat = (message) =>
      post("PROGRESS", {
        names: snapshot(),
        message,
        postHint: mediaId
          ? `media ${mediaId}`
          : extractShortcodeFromUrl(location.href) || "",
      });
    let nextMaxId = null;
    let idle = 0;
    let pages = 0;
    let reason = "idle";
    // Reply budget PER-RUN (bukan per halaman) — balasan tidak boleh memakan
    // seluruh jatah run atau meng-hammer IG.
    let replyRequests = 0;

    while (running && !stopFlag && Date.now() - start < maxMs) {
      if (requestBudget >= BUDGET) {
        reason = "timeout";
        break;
      }
      const before = nameMap.size;
      const url = buildUrl(templateUrl, { nextMaxId, mediaId });
      if (!url) {
        reason = "error";
        break;
      }

      let page;
      try {
        const data = await fetchJson(url, { deadline, heartbeat });
        page = parsePage(data);
        // IG occasionally returns empty pages mid-pagination while still
        // saying has_more — retry the same cursor before declaring done.
        let emptyRetries = 0;
        while (
          page.batchSize === 0 &&
          page.hasMore &&
          emptyRetries < 2 &&
          running &&
          !stopFlag &&
          Date.now() < deadline
        ) {
          emptyRetries++;
          heartbeat("Halaman kosong — mencoba lagi…");
          await sleepWhile(2500);
          if (!running || stopFlag) break;
          const data2 = await fetchJson(url, { deadline, heartbeat });
          page = parsePage(data2);
        }
      } catch (err) {
        if (
          err.rateLimited ||
          err.loginRequired ||
          err.checkpointRequired ||
          err.blocked
        )
          throw err;
        if (pages === 0) {
          await tryOpenComments();
          await sleepWhile(1200);
          try {
            const data = await fetchJson(url, { deadline, heartbeat });
            page = parsePage(data);
          } catch (err2) {
            if (
              err2.rateLimited ||
              err2.loginRequired ||
              err2.checkpointRequired ||
              err2.blocked
            )
              throw err2;
            post("ERROR", {
              message: String(err2?.message || err2),
              stopReason: "error",
            });
            return "error";
          }
        } else {
          reason = nameMap.size ? "timeout" : "error";
          break;
        }
      }

      pages++;
      scrapeDomUsernames();
      heartbeat(`Mengumpulkan… ${nameMap.size} username (halaman ${pages})`);

      // Optional replies (inline child comments) — capped per-run so replies
      // can never starve top-level pagination or blow the safety budget.
      if (includeReplies && page.replyTargets?.length) {
        for (const t of page.replyTargets.slice(0, 20)) {
          if (stopFlag || replyRequests >= REPLY_BUDGET) break;
          let rCursor = null;
          let rGuard = 0;
          // Endpoint balasan bisa beda antar versi klien IG: coba
          // inline_child_comments/ dulu, fallback ke child_comments/ sekali
          // per thread bila endpoint menjawab 404 / "not found".
          const rEndpoints = ["inline_child_comments", "child_comments"];
          let rEi = 0;
          while (
            rEi < rEndpoints.length &&
            rGuard < 8 &&
            !stopFlag &&
            replyRequests < REPLY_BUDGET
          ) {
            rGuard++;
            const rUrl = buildUrl(templateUrl, {
              nextMaxId: rCursor,
              reply: true,
              commentId: t.commentId,
              mediaId,
              replyEndpoint: rEndpoints[rEi],
            });
            try {
              const rData = await fetchJson(rUrl, { deadline, heartbeat });
              replyRequests++;
              const rp = parsePage(rData, true);
              heartbeat(`Balasan… ${nameMap.size} username`);
              if (!rp.hasMore || !rp.nextMaxId) break;
              rCursor = rp.nextMaxId;
            } catch (e) {
              // A real gate (429 / login / checkpoint / block) must stop the
              // run, not be swallowed — retrying after 429 risks the account.
              if (
                e.rateLimited ||
                e.loginRequired ||
                e.checkpointRequired ||
                e.blocked
              )
                throw e;
              // Endpoint tidak ada di versi klien ini → coba sibling-nya.
              if (e.notFound && rEi === 0) {
                rEi = 1;
                continue;
              }
              // Transient error → one polite retry, then move on
              await sleepWhile(1500);
              if (!running || stopFlag) break;
              try {
                const rData = await fetchJson(rUrl, { deadline, heartbeat });
                replyRequests++;
                const rp = parsePage(rData, true);
                heartbeat(`Balasan… ${nameMap.size} username`);
                if (rp.hasMore && rp.nextMaxId) rCursor = rp.nextMaxId;
              } catch (e2) {
                if (
                  e2.rateLimited ||
                  e2.loginRequired ||
                  e2.checkpointRequired ||
                  e2.blocked
                )
                  throw e2;
                break;
              }
            }
            await sleepWhile(1400 + Math.random() * 1000);
          }
          await sleepWhile(1100 + Math.random() * 900);
        }
      }

      if (nameMap.size === before) idle++;
      else idle = 0;
      if (Date.now() - lastNewAt < 2500) idle = Math.max(0, idle - 1);

      if (page.batchSize === 0) {
        // Still empty after retries — nothing more to read
        reason = "complete";
        break;
      }
      if (!page.hasMore) {
        reason = "complete";
        break;
      }
      if (!page.nextMaxId) {
        // has_more but no cursor: can't paginate without looping
        reason = "complete";
        break;
      }
      if (idle >= 4) {
        reason = "idle";
        break;
      }
      nextMaxId = page.nextMaxId;

      // Polite pacing — IG is the most fragile platform (checkpoint risk)
      await sleepWhile(1800 + Math.random() * 1400);
    }

    if (stopFlag) reason = "stopped";
    else if (Date.now() - start >= maxMs) reason = "timeout";
    return reason;
  }

  async function runExtract(options = {}) {
    const myRunId = options.runId || String(Date.now());

    if (running) {
      stopFlag = true;
      const waitStart = Date.now();
      while (running && Date.now() - waitStart < 4000) {
        await sleep(80);
      }
      running = false;
      stopFlag = false;
    }
    running = true;
    stopFlag = false;
    nameMap.clear();
    currentRunId = myRunId;
    includeReplies = options.includeReplies === true;
    // Prioritas: explicit → post yang sedang dibuka (halaman) → media asal
    // template. Halaman diutamakan agar replay tidak menyasar post lain.
    activeMediaId =
      options.mediaId ||
      extractMediaIdFromPage() ||
      extractMediaIdFromUrl(options.templateUrl);
    lastNewAt = Date.now();
    requestBudget = 0;

    post("PROGRESS", {
      names: [],
      message: "Memulai…",
      postHint: extractShortcodeFromUrl(location.href) || "",
    });

    const stillMine = () => currentRunId === myRunId;

    try {
      for (let i = 0; i < 3; i++) {
        if (await tryOpenComments()) break;
        if (!(await sleepWhile(700))) break;
      }
      scrapeDomUsernames();
      await sleepWhile(600);

      let templateUrl = options.templateUrl || engineTemplateUrl || null;

      // Poll for template after opening comments (background may capture mid-flight)
      if (!templateUrl) {
        post("NEED_TEMPLATE", { mediaId: activeMediaId });
        for (let i = 0; i < 24 && !stopFlag; i++) {
          if (!(await sleepWhile(300))) break;
          scrapeDomUsernames();
          templateUrl = engineTemplateUrl || null;
          if (templateUrl) break;
          if (i % 4 === 3) {
            await tryOpenComments();
            post("PROGRESS", {
              names: snapshot(),
              message: "Menunggu API komentar… membuka komentar",
              postHint: extractShortcodeFromUrl(location.href) || "",
            });
          }
        }
      }

      if (!templateUrl) {
        // Pure intercept/DOM mode: scroll comments a while
        post("PROGRESS", {
          names: snapshot(),
          message: "Menunggu traffic komentar… buka komentar (login wajib)",
          postHint: extractShortcodeFromUrl(location.href) || "",
        });
        const start = Date.now();
        let idle = 0;
        let loopCount = 0;
        while (running && !stopFlag && Date.now() - start < 45000) {
          loopCount++;
          if (loopCount % 4 === 0) await tryOpenComments();
          const before = nameMap.size;
          scrapeDomUsernames();
          scrollCommentContainer();
          post("PROGRESS", {
            names: snapshot(),
            message: `Mengumpulkan… ${nameMap.size} username (mode scroll)`,
            postHint: extractShortcodeFromUrl(location.href) || "",
          });
          if (nameMap.size === before) idle++;
          else idle = 0;
          if (idle >= 10 && nameMap.size > 0) break;
          if (!(await sleepWhile(900))) break;
        }
        if (stillMine()) {
          const names = snapshot();
          post("DONE", {
            names,
            stopReason: stopFlag
              ? "stopped"
              : names.length
                ? "complete"
                : "no_template",
            postHint: extractShortcodeFromUrl(location.href) || "",
          });
        }
        return;
      }

      engineTemplateUrl = templateUrl;
      const reason = await paginateList(
        templateUrl,
        activeMediaId,
        options.maxMs || 120_000
      );
      scrapeDomUsernames();
      if (stillMine()) {
        post("DONE", {
          names: snapshot(),
          stopReason: reason,
          postHint: activeMediaId
            ? `media ${activeMediaId}`
            : extractShortcodeFromUrl(location.href) || "",
        });
      }
    } catch (err) {
      if (stillMine()) {
        if (err.checkpointRequired) {
          const names = snapshot();
          post("DONE", {
            names,
            stopReason: "checkpoint",
            postHint:
              "Checkpoint Instagram — buka instagram.com & selesaikan verifikasi, lalu Proses lagi",
          });
        } else if (err.loginRequired) {
          post("ERROR", {
            message:
              "Login Instagram diperlukan — buka instagram.com, login, lalu Proses lagi.",
            stopReason: "no_login",
          });
        } else if (err.blocked) {
          // 403 = blok anti-bot/App-ID, BUKAN login — diagnosis eksplisit.
          const names = snapshot();
          post("DONE", {
            names,
            stopReason: "blocked",
            postHint:
              "Instagram memblokir permintaan (403) — kemungkinan anti-bot atau App-ID ditolak. Berhenti agar akun aman; coba lagi beberapa saat kemudian.",
          });
        } else if (err.rateLimited) {
          // rate_limit = stopReason resmi (konsisten dengan FB/TT): status
          // partial bila ada hasil / error bila kosong, pesan 429 atau
          // "minta berhenti sejenak" sesuai diagnosis engine.
          const names = snapshot();
          post("DONE", {
            names,
            stopReason: "rate_limit",
            postHint: err.pleaseWait
              ? "Rate limit Instagram — minta berhenti sejenak (Please wait). Berhenti agar akun aman."
              : err.feedbackBlocked
                ? "Instagram membatasi akun (FeedbackRequired) — berhenti agar akun aman."
                : "Rate limit (429) — berhenti agar akun aman",
          });
        } else {
          post("ERROR", {
            message: String(err?.message || err),
            stopReason: "error",
          });
        }
      }
    } finally {
      if (stillMine()) {
        running = false;
        stopFlag = false;
      }
    }
  }

  function stopExtract() {
    stopFlag = true;
  }

  function setTemplate(url) {
    engineTemplateUrl = url || null;
  }

  try {
    Object.defineProperty(window, "__RESO_ING__", {
      configurable: true,
      enumerable: false,
      writable: false,
      value: Object.freeze({
        version: 1,
        start: (opts) => {
          if (opts?.templateUrl) engineTemplateUrl = opts.templateUrl;
          runExtract(opts || {});
        },
        stop: () => {
          stopExtract();
        },
        setTemplate: (url) => {
          setTemplate(url);
        },
        ping: () => ({ ok: true, version: 1, running }),
      }),
    });
  } catch {
    window.__RESO_ING__ = {
      version: 1,
      start: runExtract,
      stop: stopExtract,
      setTemplate,
      ping: () => ({ ok: true, version: 1, running }),
    };
  }

  post("READY", { version: 1 });
})();
