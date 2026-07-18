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

  /** Data-plane only. Control plane is ENGINE_CMD via executeScript. */
  function post(type, payload = {}) {
    window.postMessage(
      { source: SOURCE, type, runId: currentRunId, ...payload },
      "*"
    );
  }

  function normalizeName(raw) {
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
      /^tiktok$/i, /^follow$/i, /^following$/i, /^followers$/i,
      /^ikuti$/i, /^like\b/i, /^reply\b/i, /^share\b/i,
      /^comment\b/i, /^suka$/i, /^balas$/i, /^bagikan$/i,
      /^komentar$/i, /^send\b/i, /^kirim$/i,
    ];
    if (blocked.some((re) => re.test(name))) return "";
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
    const arrays = [];
    if (Array.isArray(data?.comments)) arrays.push(data.comments);
    if (Array.isArray(data?.data?.comments)) arrays.push(data.data.comments);
    if (Array.isArray(data?.comments?.list)) arrays.push(data.comments.list);

    const takeUser = (user) => {
      if (!user || typeof user !== "object") return;
      const nick = user.nickname || user.nickName;
      if (typeof nick === "string") addName(nick);
    };

    if (arrays.length) {
      for (const comments of arrays) {
        for (const c of comments) {
          if (!c || typeof c !== "object") continue;
          takeUser(c.user);
          if (typeof c.nickname === "string") addName(c.nickname);
          // Only pull embedded replies when the user opted in
          if (includeReplies) {
            const replies = c.reply_comment || c.reply_comments || c.comments;
            if (Array.isArray(replies)) {
              for (const r of replies) takeUser(r?.user);
            }
          }
        }
      }
      return;
    }

    // Fallback: only comment-shaped nodes (top-level shape; avoid deep reply trees when off)
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
        // Skip nested reply arrays when replies disabled
        if (
          !includeReplies &&
          (k === "reply_comment" || k === "reply_comments")
        ) {
          continue;
        }
        walk(v[k], depth + 1);
      }
    };
    walk(data);
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
    const res = await fetch(url, {
      credentials: "include",
      headers: {
        Accept: "application/json, text/plain, */*",
      },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`API ${res.status}: ${text.slice(0, 180)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Respons bukan JSON: ${text.slice(0, 120)}`);
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  async function tryOpenComments() {
    const candidates = [
      '[data-e2e="comment-icon"]',
      '[data-e2e="browse-comment-icon"]',
      'button[aria-label*="comment" i]',
      'button[aria-label*="komentar" i]',
      'span[data-e2e="comment-icon"]',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) {
        try {
          el.click();
          await sleep(600);
          return true;
        } catch {
          /* ignore */
        }
      }
    }
    // Scroll comment list if present
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
    return false;
  }

  async function paginateList(templateUrl, awemeId, maxMs) {
    const start = Date.now();
    let cursor = 0;
    let idle = 0;
    let pages = 0;
    let reason = "idle";

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
        const data = await fetchJson(url);
        page = parsePage(data);
      } catch (err) {
        // One soft retry after opening comments
        if (pages === 0) {
          await tryOpenComments();
          await sleep(800);
          try {
            const data = await fetchJson(url);
            page = parsePage(data);
          } catch (err2) {
            post("ERROR", {
              message: String(err2?.message || err2),
              stopReason: "error",
            });
            return "error";
          }
        } else {
          // stop with partial
          reason = nameMap.size ? "timeout" : "error";
          break;
        }
      }

      pages++;
      scrapeDomNicknames();
      post("PROGRESS", {
        names: snapshot(),
        message: `Mengumpulkan… ${nameMap.size} nama (halaman ${pages})`,
        videoHint: awemeId,
      });

      // Optional replies for this page's parents
      if (includeReplies && page.replyTargets?.length) {
        for (const t of page.replyTargets.slice(0, 30)) {
          if (stopFlag) break;
          let rCursor = 0;
          let rGuard = 0;
          while (rGuard < 15 && !stopFlag) {
            rGuard++;
            const rUrl = buildUrl(templateUrl, {
              cursor: rCursor,
              awemeId,
              reply: true,
              commentId: t.commentId,
            });
            try {
              const rData = await fetchJson(rUrl);
              const rp = parsePage(rData);
              post("PROGRESS", {
                names: snapshot(),
                message: `Balasan… ${nameMap.size} nama`,
                videoHint: awemeId,
              });
              if (!rp.hasMore) break;
              rCursor =
                rp.cursor != null ? rp.cursor : rCursor + (rp.batchSize || 20);
            } catch {
              break;
            }
            await sleep(400 + Math.random() * 400);
          }
          await sleep(300 + Math.random() * 400);
        }
      }

      if (nameMap.size === before) idle++;
      else idle = 0;
      if (Date.now() - lastNewAt < 2500) idle = Math.max(0, idle - 1);

      if (!page.hasMore || page.batchSize === 0) {
        reason = "complete";
        break;
      }
      if (idle >= 4) {
        reason = "idle";
        break;
      }

      cursor =
        page.cursor != null && page.cursor !== cursor
          ? page.cursor
          : cursor + (page.batchSize || 20);

      // polite delay
      await sleep(700 + Math.random() * 900);
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

      await tryOpenComments();
      scrapeDomNicknames();
      await sleep(500);

      let templateUrl = options.templateUrl || engineTemplateUrl || null;

      // Poll for template after opening comments (background may capture mid-flight)
      if (!templateUrl) {
        post("NEED_TEMPLATE", { awemeId: activeAwemeId });
        for (let i = 0; i < 24 && !stopFlag; i++) {
          await sleep(250);
          scrapeDomNicknames();
          templateUrl = engineTemplateUrl || null;
          if (templateUrl) break;
          if (i % 4 === 3) {
            post("PROGRESS", {
              names: snapshot(),
              message: "Menunggu API komentar… buka/scroll panel komentar",
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
        while (running && !stopFlag && Date.now() - start < 45000) {
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
          await sleep(800);
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
