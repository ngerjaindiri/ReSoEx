/**
 * MAIN-world engine — TikTok Nama Komentar
 * Capture/replay comment/list | nickname only | runId | delay
 */
(function () {
  const SOURCE = "tt-nama-komentar-inject";

  if (window.__TNK_ENGINE__) {
    // Engine already live; ENGINE_CMD uses non-enumerable __RESO_TNK__
    return;
  }
  window.__TNK_ENGINE__ = true;

  /** Captured / provided comment-list URL template (closure only) */
  let engineTemplateUrl = null;

  /** @type {Map<string, string>} */
  const nameMap = new Map();
  let running = false;
  let stopFlag = false;
  let lastNewAt = Date.now();
  let includeReplies = false;
  let activeAwemeId = null;
  let currentRunId = null;
  /** Total API requests this run (budget guard against runaway pagination) */
  let requestBudget = 0;

  /** Data-plane only. Control plane is ENGINE_CMD via executeScript. */
  function post(type, payload = {}) {
    window.postMessage(
      { source: SOURCE, type, runId: currentRunId, ...payload },
      "*"
    );
  }

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

  function addName(raw) {
    const name = normalizeNickname(raw);
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

  function extractAwemeId(url) {
    if (!url) url = location.href;
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

  function ingestCommentArrays(data) {
    for (const nick of parseTikTokComments(data, includeReplies)) addName(nick);
  }

  function parsePage(data) {
    ingestCommentArrays(data);
    const comments = data?.comments || data?.data?.comments || [];
    const hasMore =
      data?.has_more === 1 ||
      data?.has_more === true ||
      data?.data?.has_more === 1;
    let cursor = data?.cursor ?? data?.data?.cursor;
    if (cursor != null) cursor = Number(cursor);
    const replyTargets = [];
    if (Array.isArray(comments)) {
      for (const c of comments) {
        const id = c?.cid ?? c?.comment_id ?? c?.id;
        const total = c?.reply_comment_total ?? c?.reply_count ?? 0;
        if (id && Number(total) > 0) {
          replyTargets.push({ commentId: String(id), total: Number(total) });
        }
      }
    }
    return {
      hasMore: !!hasMore,
      cursor: Number.isFinite(cursor) ? cursor : null,
      batchSize: Array.isArray(comments) ? comments.length : 0,
      replyTargets,
    };
  }

  function looksLikeCommentApi(url) {
    if (!url) return false;
    const u = String(url).toLowerCase();
    return u.includes("tiktok.com/api/comment/list");
  }

  function payloadMatchesVideo(url, text) {
    if (!activeAwemeId) return true;
    if (url && String(url).includes(activeAwemeId)) return true;
    if (text && text.includes(activeAwemeId)) return true;
    // Comment payloads often omit aweme in body — allow if pure comment list shape
    if (text && (text.includes('"comments"') || text.includes("has_more")))
      return true;
    return false;
  }

  function tryParseResponse(url, text) {
    if (!running) return;
    if (!looksLikeCommentApi(url) && text && !text.includes('"comments"'))
      return;
    if (!payloadMatchesVideo(url, text)) return;
    try {
      const data = JSON.parse(text);
      parsePage(data);
    } catch {
      /* ignore */
    }
  }

  // ---- network intercept ----
  if (!window.__TNK_NET__) {
    window.__TNK_NET__ = true;
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      const res = await origFetch.apply(this, args);
      try {
        const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
        if (running && looksLikeCommentApi(url)) {
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
      this.__tnk_url = url;
      return oOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener("load", function () {
        try {
          if (!running) return;
          if (!looksLikeCommentApi(this.__tnk_url)) return;
          if (typeof this.responseText === "string") {
            tryParseResponse(this.__tnk_url, this.responseText);
          }
        } catch {
          /* ignore */
        }
      });
      return oSend.apply(this, args);
    };
  }

  function buildUrl(templateUrl, { cursor, awemeId, reply, commentId }) {
    if (!templateUrl) return null;
    let base = templateUrl;
    if (reply) {
      if (!base.includes("/list/reply")) {
        base = base.replace("/api/comment/list", "/api/comment/list/reply");
      }
    } else {
      base = base.replace("/api/comment/list/reply", "/api/comment/list");
    }
    let u;
    try {
      u = new URL(base);
    } catch {
      return null;
    }
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
    u.searchParams.set("cursor", String(cursor || 0));
    if (awemeId) {
      if (reply) {
        u.searchParams.set("item_id", String(awemeId));
        u.searchParams.delete("aweme_id");
      } else {
        u.searchParams.set("aweme_id", String(awemeId));
      }
    }
    if (reply && commentId) {
      u.searchParams.set("comment_id", String(commentId));
      if (!u.searchParams.get("count")) u.searchParams.set("count", "20");
    }
    return u.toString();
  }

  async function fetchJson(url) {
    requestBudget += 1;
    let res;
    try {
      res = await fetch(url, {
        credentials: "include",
        headers: {
          Accept: "application/json, text/plain, */*",
        },
      });
    } catch (err) {
      const e = new Error("Jaringan terganggu — coba lagi.");
      e.kind = "network";
      throw e;
    }
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 429) {
        const ra = Number(res.headers.get("retry-after"));
        const e = new Error(
          "Rate limit TikTok (HTTP 429) — jeda sejenak lalu coba lagi."
        );
        e.kind = "rate_limit";
        e.retryAfter = Number.isFinite(ra) && ra > 0 ? ra : null;
        throw e;
      }
      if (res.status === 401) {
        const e = new Error("Sesi TikTok tidak aktif — login lalu Proses lagi.");
        e.kind = "no_login";
        throw e;
      }
      throw new Error(`API ${res.status}: ${text.slice(0, 180)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      const e = new Error(`Respons bukan JSON: ${text.slice(0, 120)}`);
      e.kind = "parse";
      throw e;
    }
  }

  /**
   * fetchJson dengan ketahanan: backoff adaptif 429 (hormati Retry-After,
   * eskalasi 8s → 16s, maks 2 retry, hanya jika sisa waktu cukup), retry cepat
   * untuk blip jaringan, heartbeat PROGRESS selama menunggu. Error
   * rate_limit/no_login diteruskan agar run berhenti aman.
   */
  async function fetchJsonWithBackoff(url, deadline) {
    let attempt = 0;
    for (;;) {
      try {
        return await fetchJson(url);
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
            videoHint: activeAwemeId,
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

  function scrapeDomNicknames() {
    // Fallback: visible comment author names in DOM
    let added = 0;
    const sels = [
      '[data-e2e="comment-username-1"]',
      '[data-e2e="comment-username-2"]',
      '[data-e2e="comment-item"] a[href*="/@"]',
      'div[class*="Comment"] a[href*="/@"]',
    ];
    for (const sel of sels) {
      document.querySelectorAll(sel).forEach((el) => {
        const t = (el.innerText || el.textContent || "").trim();
        // Prefer title/aria if text is @handle — still take visible label
        const aria = el.getAttribute("aria-label") || "";
        if (addName(aria || t)) added++;
      });
    }
    return added;
  }

  function commentPanelOpen() {
    return !!document.querySelector(
      '[data-e2e="comment-list"], [data-e2e="comment-container"], [class*="CommentList"]'
    );
  }

  /**
   * Open the comment panel automatically (so the comment/list API fires and
   * the background can capture the URL template) — no manual click needed.
   */
  async function tryOpenComments() {
    // Already open — nothing to do (keep it scrolled down for lazy batches)
    if (commentPanelOpen()) {
      try {
        const list = document.querySelector(
          '[data-e2e="comment-list"], [class*="CommentList"]'
        );
        if (list) list.scrollTop = list.scrollHeight;
      } catch {
        /* ignore */
      }
      return true;
    }
    const candidates = [
      '[data-e2e="comment-icon"]',
      '[data-e2e="browse-comment-icon"]',
      '[data-e2e="comment-count"]',
      'button[aria-label*="comment" i]',
      'button[aria-label*="komentar" i]',
      'span[data-e2e="comment-icon"]',
      'button[data-e2e*="comment" i]',
      '[data-e2e="comment-item"]',
      'a[href*="comment"]',
    ];
    for (const sel of candidates) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        // Click the interactive ancestor, not an inert SVG/text node
        const target =
          el.closest("button, a, [role='button'], [data-e2e]") || el;
        try {
          target.click();
          await sleepWhile(500);
          if (commentPanelOpen()) return true;
        } catch {
          /* try next candidate */
        }
      }
    }
    const list = document.querySelector(
      '[data-e2e="comment-list"], [class*="CommentList"]'
    );
    if (list) {
      try {
        list.scrollTop = list.scrollHeight;
      } catch {
        /* ignore */
      }
    }
    return commentPanelOpen();
  }

  async function paginateList(templateUrl, awemeId, maxMs) {
    const start = Date.now();
    const deadline = start + maxMs;
    let cursor = 0;
    let idle = 0;
    let emptyPages = 0;
    let pages = 0;
    let reason = "idle";
    const REPLY_BUDGET = 40;
    let replyRequests = 0;
    let replyFailStreak = 0;

    while (running && !stopFlag && Date.now() - start < maxMs) {
      const before = nameMap.size;
      const url = buildUrl(templateUrl, {
        cursor,
        awemeId,
        reply: false,
      });
      if (!url) {
        reason = "error";
        break;
      }

      let page;
      try {
        const data = await fetchJsonWithBackoff(url, deadline);
        page = parsePage(data);
      } catch (err) {
        const kind = err && err.kind;
        // Rate limit / sesi tidak aktif = hentikan run aman, jangan hammer
        if (kind === "rate_limit") return "rate_limit";
        if (kind === "no_login") return "no_login";
        // One soft retry after opening comments
        if (pages === 0) {
          await tryOpenComments();
          await sleepWhile(800);
          try {
            const data = await fetchJsonWithBackoff(url, deadline);
            page = parsePage(data);
          } catch (err2) {
            const k2 = err2 && err2.kind;
            if (k2 === "rate_limit") return "rate_limit";
            if (k2 === "no_login") return "no_login";
            return nameMap.size ? "timeout" : "error";
          }
        } else {
          // stop with partial
          reason = nameMap.size ? "timeout" : "error";
          break;
        }
      }

      pages++;
      if (requestBudget >= 350) {
        reason = "timeout";
        break;
      }
      scrapeDomNicknames();
      post("PROGRESS", {
        names: snapshot(),
        message: `Mengumpulkan… ${nameMap.size} nama (halaman ${pages})`,
        videoHint: awemeId,
      });

      // Optional replies for this page's parents — budget terpisah 40 request/run
      if (includeReplies && page.replyTargets?.length) {
        for (const t of page.replyTargets) {
          if (stopFlag) break;
          if (replyRequests >= REPLY_BUDGET) break;
          let rCursor = 0;
          let rGuard = 0;
          while (rGuard < 8 && !stopFlag) {
            rGuard++;
            if (replyRequests >= REPLY_BUDGET || requestBudget >= 350) break;
            const rUrl = buildUrl(templateUrl, {
              cursor: rCursor,
              awemeId,
              reply: true,
              commentId: t.commentId,
            });
            try {
              const rData = await fetchJsonWithBackoff(rUrl, deadline);
              replyRequests++;
              replyFailStreak = 0;
              const rp = parsePage(rData);
              post("PROGRESS", {
                names: snapshot(),
                message: `Balasan… ${nameMap.size} nama`,
                videoHint: awemeId,
              });
              if (!rp.hasMore) break;
              rCursor =
                rp.cursor != null ? rp.cursor : rCursor + (rp.batchSize || 20);
            } catch (err) {
              const kind = err && err.kind;
              // 429 / sesi tidak aktif di balasan = hentikan seluruh run
              if (kind === "rate_limit") return "rate_limit";
              if (kind === "no_login") return "no_login";
              replyFailStreak++;
              if (replyFailStreak >= 2) break;
            }
            if (!(await sleepWhile(400 + Math.random() * 400))) break;
          }
          if (!(await sleepWhile(300 + Math.random() * 400))) break;
        }
      }

      if (nameMap.size === before) idle++;
      else idle = 0;
      if (Date.now() - lastNewAt < 2500) idle = Math.max(0, idle - 1);

      if (page.hasMore === false) {
        reason = "complete";
        break;
      }
      // Halaman kosong di tengah pagination — retry cursor sama 2× sebelum
      // menyerah (jangan pernah dinyatakan "complete" padahal belum selesai)
      if (page.batchSize === 0) {
        emptyPages++;
        if (emptyPages <= 2 && Date.now() - start < maxMs - 3000) {
          await sleepWhile(700 + Math.random() * 500);
          continue;
        }
        reason = nameMap.size ? "idle" : "error";
        break;
      }
      emptyPages = 0;
      if (idle >= 4) {
        reason = "idle";
        break;
      }

      cursor =
        page.cursor != null && page.cursor !== cursor
          ? page.cursor
          : cursor + (page.batchSize || 20);

      // polite delay
      if (!(await sleepWhile(700 + Math.random() * 900))) {
        reason = "stopped";
        break;
      }
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
    activeAwemeId = options.awemeId || extractAwemeId(location.href);
    lastNewAt = Date.now();
    requestBudget = 0;

    post("PROGRESS", {
      names: [],
      message: "Memulai…",
      videoHint: activeAwemeId || "",
    });

    const stillMine = () => currentRunId === myRunId;

    try {
      if (!activeAwemeId) {
        if (stillMine()) {
          post("DONE", {
            names: [],
            stopReason: "no_video",
            videoHint: "",
          });
        }
        return;
      }

      for (let i = 0; i < 3; i++) {
        if (await tryOpenComments()) break;
        if (!(await sleepWhile(700))) break;
      }
      scrapeDomNicknames();
      await sleepWhile(500);

      let templateUrl = options.templateUrl || engineTemplateUrl || null;

      // Poll for template after opening comments (background may capture mid-flight)
      if (!templateUrl) {
        post("NEED_TEMPLATE", { awemeId: activeAwemeId });
        for (let i = 0; i < 24 && !stopFlag; i++) {
          if (!(await sleepWhile(250))) break;
          scrapeDomNicknames();
          templateUrl = engineTemplateUrl || null;
          if (templateUrl) break;
          if (i % 4 === 3) {
            await tryOpenComments();
            post("PROGRESS", {
              names: snapshot(),
              message: "Menunggu API komentar… membuka panel komentar",
              videoHint: activeAwemeId,
            });
          }
        }
      }

      if (!templateUrl) {
        // Pure intercept mode: scroll comments a while
        post("PROGRESS", {
          names: snapshot(),
          message: "Menunggu traffic komentar… buka panel komentar",
          videoHint: activeAwemeId,
        });
        const start = Date.now();
        let idle = 0;
        let loopCount = 0;
        while (running && !stopFlag && Date.now() - start < 45000) {
          loopCount++;
          if (loopCount % 5 === 0) await tryOpenComments();
          const before = nameMap.size;
          scrapeDomNicknames();
          const list = document.querySelector(
            '[data-e2e="comment-list"], [class*="CommentList"]'
          );
          if (list) {
            try {
              list.scrollTop = list.scrollHeight;
            } catch {
              /* ignore */
            }
          } else {
            window.scrollBy(0, 300);
          }
          post("PROGRESS", {
            names: snapshot(),
            message: `Mengumpulkan… ${nameMap.size} nama (mode scroll)`,
            videoHint: activeAwemeId,
          });
          if (nameMap.size === before) idle++;
          else idle = 0;
          if (idle >= 10 && nameMap.size > 0) break;
          if (!(await sleepWhile(800))) break;
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
            videoHint: activeAwemeId,
          });
        }
        return;
      }

      engineTemplateUrl = templateUrl;
      const reason = await paginateList(
        templateUrl,
        activeAwemeId,
        options.maxMs || 120_000
      );
      scrapeDomNicknames();
      if (stillMine()) {
        post("DONE", {
          names: snapshot(),
          stopReason: reason,
          videoHint: activeAwemeId,
        });
      }
    } catch (err) {
      if (stillMine()) {
        post("ERROR", {
          message: String(err?.message || err),
          stopReason: "error",
        });
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
    Object.defineProperty(window, "__RESO_TNK__", {
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
    window.__RESO_TNK__ = {
      version: 1,
      start: runExtract,
      stop: stopExtract,
      setTemplate,
      ping: () => ({ ok: true, version: 1, running }),
    };
  }

  post("READY", { version: 1 });
})();
