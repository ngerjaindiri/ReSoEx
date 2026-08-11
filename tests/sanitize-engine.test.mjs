/**
 * Unit tests untuk sanitizeEngineOptions (batas aman ENGINE_CMD) dan
 * reasonToMessage yang platform-aware. Pure ESM — node --test, zero deps.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  sanitizeEngineOptions,
  reasonToMessage,
  doneMessage,
  wordFor,
} from "../shared.js";

const TT_URL = "https://www.tiktok.com/api/comment/list/?aweme_id=1&cursor=0";
const TT_REPLY_URL =
  "https://www.tiktok.com/api/comment/list/reply?comment_id=9";
const IG_URL =
  "https://www.instagram.com/api/v1/media/12345/comments/?can_support_threading=true";
const IG_REPLY_URL =
  "https://www.instagram.com/api/v1/media/12345/comments/9/inline_child_comments/";

// ===================== SET_TEMPLATE =====================

test("SET_TEMPLATE tiktok: keeps valid comment/list, rejects reply + foreign", () => {
  const ok = sanitizeEngineOptions("SET_TEMPLATE", { templateUrl: TT_URL }, "tiktok");
  assert.equal(ok.templateUrl, TT_URL);
  const reply = sanitizeEngineOptions(
    "SET_TEMPLATE",
    { templateUrl: TT_REPLY_URL },
    "tiktok"
  );
  assert.equal(reply.templateUrl, null);
  const foreign = sanitizeEngineOptions(
    "SET_TEMPLATE",
    { templateUrl: "https://evil.com/api/comment/list/" },
    "tiktok"
  );
  assert.equal(foreign.templateUrl, null);
  assert.equal(
    sanitizeEngineOptions("SET_TEMPLATE", { templateUrl: 42 }, "tiktok").templateUrl,
    null
  );
});

test("SET_TEMPLATE instagram: keeps valid media/comments, rejects replies + foreign", () => {
  const ok = sanitizeEngineOptions("SET_TEMPLATE", { templateUrl: IG_URL }, "instagram");
  assert.equal(ok.templateUrl, IG_URL);
  const reply = sanitizeEngineOptions(
    "SET_TEMPLATE",
    { templateUrl: IG_REPLY_URL },
    "instagram"
  );
  assert.equal(reply.templateUrl, null);
  const foreign = sanitizeEngineOptions(
    "SET_TEMPLATE",
    { templateUrl: TT_URL },
    "instagram"
  );
  assert.equal(foreign.templateUrl, null);
});

test("SET_TEMPLATE facebook: always rejected (FB builds queries itself)", () => {
  const out = sanitizeEngineOptions("SET_TEMPLATE", { templateUrl: TT_URL }, "facebook");
  assert.equal(out.templateUrl, null);
});

test("Unknown cmds sanitize to {} (nothing crosses into MAIN world)", () => {
  assert.deepEqual(sanitizeEngineOptions("PING", { templateUrl: TT_URL }, "tiktok"), {});
  assert.deepEqual(sanitizeEngineOptions("STOP", { maxMs: 1 }, "facebook"), {});
  assert.deepEqual(sanitizeEngineOptions(null, null, "instagram"), {});
});

// ===================== START — shared fields =====================

test("START maxMs is clamped to [8s, 180s]", () => {
  const fb = sanitizeEngineOptions("START", { maxMs: 999999 }, "facebook");
  assert.equal(fb.maxMs, 180_000);
  const tt = sanitizeEngineOptions("START", { maxMs: 100 }, "tiktok");
  assert.equal(tt.maxMs, 8_000);
  const ig = sanitizeEngineOptions("START", { maxMs: 30_000 }, "instagram");
  assert.equal(ig.maxMs, 30_000);
});

test("START default maxMs is platform-aware", () => {
  assert.equal(sanitizeEngineOptions("START", {}, "tiktok").maxMs, 120_000);
  assert.equal(sanitizeEngineOptions("START", {}, "instagram").maxMs, 150_000);
  assert.equal(sanitizeEngineOptions("START", {}, "facebook").maxMs, 150_000);
});

test("START runId: string <= 80 kept, anything else null", () => {
  const ok = sanitizeEngineOptions("START", { runId: "run_abc" }, "facebook");
  assert.equal(ok.runId, "run_abc");
  const long = sanitizeEngineOptions(
    "START",
    { runId: "x".repeat(120) },
    "facebook"
  );
  assert.equal(long.runId, null);
  assert.equal(sanitizeEngineOptions("START", { runId: 42 }, "facebook").runId, null);
});

test("START includeReplies: FB default true; TT/IG only strict true", () => {
  assert.equal(sanitizeEngineOptions("START", {}, "facebook").includeReplies, true);
  assert.equal(
    sanitizeEngineOptions("START", { includeReplies: false }, "facebook").includeReplies,
    false
  );
  assert.equal(
    sanitizeEngineOptions("START", { includeReplies: "yes" }, "facebook").includeReplies,
    true
  );
  assert.equal(sanitizeEngineOptions("START", {}, "tiktok").includeReplies, false);
  assert.equal(
    sanitizeEngineOptions("START", { includeReplies: true }, "tiktok").includeReplies,
    true
  );
  assert.equal(
    sanitizeEngineOptions("START", { includeReplies: "yes" }, "tiktok").includeReplies,
    false
  );
  assert.equal(
    sanitizeEngineOptions("START", { includeReplies: 1 }, "instagram").includeReplies,
    false
  );
});

// ===================== START — platform fields =====================

test("START tiktok: awemeId digits-only (max 32), templateUrl validated", () => {
  const out = sanitizeEngineOptions(
    "START",
    { awemeId: "abc7290000000000000000000000000000000000123456!", templateUrl: TT_URL },
    "tiktok"
  );
  assert.equal(out.awemeId, "7290000000000000000000000000000000000123456".slice(0, 32));
  assert.equal(out.templateUrl, TT_URL);
  const bad = sanitizeEngineOptions(
    "START",
    { awemeId: "", templateUrl: TT_REPLY_URL },
    "tiktok"
  );
  assert.equal(bad.awemeId, null);
  assert.equal(bad.templateUrl, null);
});

test("START instagram: mediaId digits-only, templateUrl validated", () => {
  const out = sanitizeEngineOptions(
    "START",
    { mediaId: "12a34567890123!", templateUrl: IG_URL },
    "instagram"
  );
  assert.equal(out.mediaId, "1234567890123");
  assert.equal(out.templateUrl, IG_URL);
  const bad = sanitizeEngineOptions(
    "START",
    { mediaId: null, templateUrl: IG_REPLY_URL },
    "instagram"
  );
  assert.equal(bad.mediaId, null);
  assert.equal(bad.templateUrl, null);
});

// ===================== reasonToMessage platform-aware =====================

test("no_template message is platform-specific (FB vs TT vs IG)", () => {
  const fb = reasonToMessage("no_template", 0, "facebook");
  const tt = reasonToMessage("no_template", 0, "tiktok");
  const ig = reasonToMessage("no_template", 0, "instagram");
  assert.match(fb, /permalink/);
  assert.match(fb, /GraphQL/);
  assert.match(tt, /video/);
  assert.match(ig, /post\/reel/);
  assert.match(ig, /login/);
});

test("no_login / no_video / no_media messages", () => {
  assert.match(reasonToMessage("no_login", 0, "instagram"), /login/);
  assert.match(reasonToMessage("no_video", 0, "tiktok"), /video/);
  assert.match(reasonToMessage("no_media", 0, "instagram"), /post\/reel/);
});

test("no_login is platform-aware (FB vs IG)", () => {
  const fb = reasonToMessage("no_login", 0, "facebook");
  assert.match(fb, /Facebook/);
  assert.match(fb, /login/i);
  const ig = reasonToMessage("no_login", 0, "instagram");
  assert.match(ig, /Instagram/);
  assert.doesNotMatch(ig, /Facebook/);
});

test("no_login is TikTok-aware (TT vs FB vs IG)", () => {
  const tt = reasonToMessage("no_login", 0, "tiktok");
  assert.match(tt, /TikTok/);
  assert.match(tt, /login/i);
  assert.doesNotMatch(tt, /Instagram/);
  assert.doesNotMatch(tt, /Facebook/);
  assert.match(reasonToMessage("no_login", 0, "facebook"), /Facebook/);
  assert.match(reasonToMessage("no_login", 0, "instagram"), /Instagram/);
});

test("rate_limit maps to a clear message with count (TikTok-specific wording)", () => {
  const tt = reasonToMessage("rate_limit", 5, "tiktok");
  assert.match(tt, /429/);
  assert.match(tt, /5/);
  assert.match(reasonToMessage("rate_limit", 0, "tiktok"), /429/);
});

test("rate_limit wording is platform-aware (nama vs username, not 'data')", () => {
  const tt = reasonToMessage("rate_limit", 5, "tiktok");
  assert.match(tt, /5 nama/);
  assert.doesNotMatch(tt, /data/);
  const ig = reasonToMessage("rate_limit", 5, "instagram");
  assert.match(ig, /5 username/);
  assert.doesNotMatch(ig, /data/);
  const fb = reasonToMessage("rate_limit", 5, "facebook");
  assert.match(fb, /5 nama/);
});

test("rate_limit maps to a clear message with count (FB-specific wording)", () => {
  const fb = reasonToMessage("rate_limit", 7, "facebook");
  assert.match(fb, /429/);
  assert.match(fb, /7/);
  assert.match(fb, /Facebook/);
  const fbEmpty = reasonToMessage("rate_limit", 0, "facebook");
  assert.match(fbEmpty, /429/);
  // Non-FB platforms fall back to generic wording
  assert.match(reasonToMessage("rate_limit", 0, "tiktok"), /429/);
  assert.match(reasonToMessage("rate_limit", 3, "instagram"), /429/);
});

test("blocked reason maps to an accurate IG 403 message (not login)", () => {
  const msg = reasonToMessage("blocked", 4, "instagram");
  assert.match(msg, /403/);
  assert.match(msg, /4/);
  assert.match(msg, /anti-bot|blokir/i);
  assert.doesNotMatch(msg, /login/i);
  const empty = reasonToMessage("blocked", 0, "instagram");
  assert.match(empty, /403/);
  assert.match(empty, /anti-bot|App-ID|blokir/i);
});

test("checkpoint reason maps to a clear IG verification message", () => {
  const msg = reasonToMessage("checkpoint", 12, "instagram");
  assert.match(msg, /checkpoint|verifikasi/i);
  assert.match(msg, /12/);
  const empty = reasonToMessage("checkpoint", 0, "instagram");
  assert.match(empty, /verifikasi/i);
  // Non-IG platforms fall back to the same clear wording
  assert.match(reasonToMessage("checkpoint", 0, "facebook"), /verifikasi/i);
});

test("timeout with extra carries the 429 diagnosis", () => {
  const msg = reasonToMessage(
    "timeout",
    42,
    "instagram",
    "Rate limit (429) — berhenti agar akun aman"
  );
  assert.match(msg, /42/);
  assert.match(msg, /429/);
});

test("doneMessage is the single source: reasonToMessage delegates identically", () => {
  for (const platform of ["facebook", "tiktok", "instagram"]) {
    for (const reason of [
      "complete",
      "idle",
      "stopped",
      "timeout",
      "rate_limit",
      "blocked",
      "checkpoint",
      "no_login",
      "no_template",
      "no_video",
      "no_media",
    ]) {
      assert.equal(
        reasonToMessage(reason, 3, platform),
        doneMessage(reason, 3, platform),
        `reasonToMessage vs doneMessage mismatch: ${reason}/${platform}`
      );
    }
  }
});

test("doneMessage word is platform-aware (nama vs username)", () => {
  assert.equal(wordFor("instagram"), "username");
  assert.equal(wordFor("facebook"), "nama");
  assert.equal(wordFor("tiktok"), "nama");
  assert.match(doneMessage("complete", 1, "instagram"), /1 username/);
  assert.match(doneMessage("complete", 1, "facebook"), /1 nama/);
  assert.doesNotMatch(doneMessage("rate_limit", 5, "instagram"), /data/);
});
