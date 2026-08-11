/**
 * Unit tests for shared.js — pure ESM, no Chrome API, run with `npm test`
 * (node --test tests/), zero dependencies.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeName,
  mergeNames,
  mergeAcrossPlatforms,
  namesToClipboardText,
  detectPlatform,
  isFacebookUrl,
  isTikTokUrl,
  isInstagramUrl,
  extractAwemeId,
  extractInstagramShortcode,
  extractFbFeedbackIds,
  isFacebookPostPage,
  normalizeInstagramUsername,
  sanitizeTikTokTemplateUrl,
  isTikTokTemplateValid,
  sanitizeInstagramTemplateUrl,
  isInstagramTemplateValid,
  storageKeyFor,
  defaultStateFor,
  newRunId,
  isStaleRun,
  SAVED_KEY,
  PREFS_KEY,
  STORAGE_KEY_IG,
  IG_TEMPLATE_KEY,
} from "../shared.js";

// ===================== normalizeName — Facebook =====================

test("FB: strip Indonesian timestamp suffixes", () => {
  assert.equal(normalizeName("Andi 2 jam yang lalu", "facebook"), "Andi");
  assert.equal(normalizeName("Budi sehari yang lalu", "facebook"), "Budi");
  assert.equal(normalizeName("Cici sekitar satu jam yang lalu", "facebook"), "Cici");
});

test("FB: strip English timestamp suffixes", () => {
  assert.equal(normalizeName("Dewi about 5 hours ago", "facebook"), "Dewi");
  assert.equal(normalizeName("Eka a minute ago", "facebook"), "Eka");
  assert.equal(normalizeName("Fani just now", "facebook"), "Fani");
});

test("FB: strip generic relative suffixes (3d, 5h, 2 jam)", () => {
  assert.equal(normalizeName("Gilang 3d", "facebook"), "Gilang");
  assert.equal(normalizeName("Hana 2 jam", "facebook"), "Hana");
});

test("FB: strip dot/bullet separators and 'Edited'", () => {
  assert.equal(normalizeName("Indra · 5m", "facebook"), "Indra");
  assert.equal(normalizeName("Joko Edited", "facebook"), "Joko");
});

test("FB: split 'is with'", () => {
  assert.equal(normalizeName("Kiki is with Lala", "facebook"), "Kiki");
});

test("FB: reject non-names", () => {
  assert.equal(normalizeName("@handle", "facebook"), "");
  assert.equal(normalizeName("123456", "facebook"), "");
  assert.equal(normalizeName("https://evil.com", "facebook"), "");
  assert.equal(normalizeName("wa.me/12345", "facebook"), "");
});

test("FB: reject UI/navigation words", () => {
  assert.equal(normalizeName("Like", "facebook"), "");
  assert.equal(normalizeName("Komentar", "facebook"), "");
  assert.equal(normalizeName("Follow", "facebook"), "");
  assert.equal(normalizeName("TikTok", "facebook"), "");
  assert.equal(normalizeName("Most relevant", "facebook"), "");
});

test("FB: drop emoji/symbol-only noise", () => {
  assert.equal(normalizeName("😀😀😀", "facebook"), "");
  assert.equal(normalizeName("❤️", "facebook"), "");
  assert.equal(normalizeName("Ahmad ❤️", "facebook"), "Ahmad ❤️");
});

test("FB: keep valid names (incl. non-Latin)", () => {
  assert.equal(normalizeName("Andi Pratama", "facebook"), "Andi Pratama");
  assert.equal(normalizeName("محمد", "facebook"), "محمد");
  assert.equal(normalizeName("田中 太郎", "facebook"), "田中 太郎");
});

// ===================== normalizeName — TikTok =====================

test("TT: strip leading @ on plain handles", () => {
  assert.equal(normalizeName("@user123", "tiktok"), "user123");
});

test("TT: reject non-names", () => {
  assert.equal(normalizeName("12345", "tiktok"), "");
  assert.equal(normalizeName("https://evil.com", "tiktok"), "");
  assert.equal(normalizeName("bit.ly/x", "tiktok"), "");
});

test("TT: reject UI words", () => {
  assert.equal(normalizeName("Follow", "tiktok"), "");
  assert.equal(normalizeName("Komentar", "tiktok"), "");
  assert.equal(normalizeName("tiktok", "tiktok"), "");
});

test("TT: keep emoji/symbol-only nicknames (by design)", () => {
  assert.equal(normalizeName("😀", "tiktok"), "😀");
});

test("TT: does NOT strip FB-style timestamps", () => {
  assert.equal(normalizeName("user 2 jam yang lalu", "tiktok"), "user 2 jam yang lalu");
});

// ===================== mergeNames / clipboard =====================

test("mergeNames: dedupe case-insensitively + filter", () => {
  const out = mergeNames(
    [],
    ["Andi", "andi", "Andi ", "Budi 2 jam yang lalu", "Like"],
    "facebook"
  );
  assert.deepEqual(out, ["Andi", "Budi"]);
});

test("mergeNames: combine existing + incoming", () => {
  const out = mergeNames(["Andi"], ["Budi"], "facebook");
  assert.deepEqual(out, ["Andi", "Budi"]);
});

test("namesToClipboardText: one name per line", () => {
  assert.equal(
    namesToClipboardText(["Andi", "Budi 3h", "Like"], "facebook"),
    "Andi\nBudi"
  );
});

test("mergeAcrossPlatforms: normalisasi per-platform tanpa data loss", () => {
  const out = mergeAcrossPlatforms([
    { platform: "facebook", names: ["Andi Pratama", "Budi"] },
    { platform: "tiktok", names: ["@user123", "😀", "Budi"] },
    { platform: "instagram", names: ["User.Name_1", "dewi"] },
  ]);
  // TikTok @handle & emoji dipertahankan; nama FB dengan spasi tidak hilang
  // saat di-merge dengan IG; IG dinormalisasi lowercase; Budi dedupe.
  assert.deepEqual(out, [
    "Andi Pratama",
    "Budi",
    "user123",
    "😀",
    "user.name_1",
    "dewi",
  ]);
});

test("mergeAcrossPlatforms: dedupe case-insensitive lintas platform", () => {
  const out = mergeAcrossPlatforms([
    { platform: "facebook", names: ["Andi"] },
    { platform: "tiktok", names: ["andi"] },
    { platform: "instagram", names: ["ANDI"] },
  ]);
  assert.deepEqual(out, ["Andi"]);
});

test("mergeAcrossPlatforms: groups kosong / nama tidak valid aman", () => {
  assert.deepEqual(mergeAcrossPlatforms([]), []);
  assert.deepEqual(mergeAcrossPlatforms(null), []);
  assert.deepEqual(
    mergeAcrossPlatforms([{ platform: "facebook", names: ["Like", "https://x"] }]),
    []
  );
  assert.deepEqual(mergeAcrossPlatforms([{ platform: "instagram", names: [] }]), []);
});

// ===================== platform detection =====================

test("detectPlatform: facebook / tiktok / null", () => {
  assert.equal(detectPlatform("https://www.facebook.com/x"), "facebook");
  assert.equal(detectPlatform("https://m.facebook.com/x"), "facebook");
  assert.equal(detectPlatform("https://www.tiktok.com/@u/video/1"), "tiktok");
  assert.equal(detectPlatform("https://google.com"), null);
  assert.equal(detectPlatform(null), null);
});

test("isFacebookUrl / isTikTokUrl: strict host matching", () => {
  assert.equal(isFacebookUrl("https://facebook.com.evil.com/x"), false);
  assert.equal(isFacebookUrl("https://web.facebook.com/x"), true);
  assert.equal(isTikTokUrl("https://vm.tiktok.com/abc"), true);
  assert.equal(isTikTokUrl("https://tiktok.com.evil.com/x"), false);
});

// ===================== TikTok aweme id / template =====================

test("extractAwemeId: known URL shapes", () => {
  assert.equal(
    extractAwemeId("https://www.tiktok.com/@user/video/7290000000000000001"),
    "7290000000000000001"
  );
  assert.equal(extractAwemeId("https://www.tiktok.com/embed/12345"), "12345");
  assert.equal(extractAwemeId("https://x.com/anything"), null);
  assert.equal(extractAwemeId(null), null);
});

test("sanitizeTikTokTemplateUrl: strips short-lived signing params", () => {
  const clean = sanitizeTikTokTemplateUrl(
    "https://www.tiktok.com/api/comment/list/?aweme_id=1&msToken=abc&X-Bogus=def&_signature=xyz"
  );
  assert.ok(!clean.includes("msToken"));
  assert.ok(!clean.includes("X-Bogus"));
  assert.ok(!clean.includes("_signature"));
  assert.ok(clean.includes("aweme_id=1"));
});

test("isTikTokTemplateValid: TTL + shape + aweme match", () => {
  const url = "https://www.tiktok.com/api/comment/list/?aweme_id=1";
  assert.equal(
    isTikTokTemplateValid(url, { capturedAt: Date.now(), awemeId: "1" }, "1"),
    true
  );
  assert.equal(
    isTikTokTemplateValid(url, { capturedAt: Date.now() - 46 * 60 * 1000 }, "1"),
    false // expired (TTL 45 min)
  );
  assert.equal(
    isTikTokTemplateValid(
      "https://www.tiktok.com/api/comment/list/reply?comment_id=9",
      { capturedAt: Date.now() },
      null
    ),
    false // reply URLs are not valid top-level templates
  );
  assert.equal(
    isTikTokTemplateValid(url, { capturedAt: Date.now(), awemeId: "2" }, "1"),
    false // aweme mismatch
  );
});

// ===================== persisted storage keys =====================

test("persisted storage keys are exported", () => {
  assert.equal(typeof SAVED_KEY, "string");
  assert.equal(typeof PREFS_KEY, "string");
  assert.ok(SAVED_KEY.length > 0);
  assert.ok(PREFS_KEY.length > 0);
});

// ===================== run ids =====================

test("newRunId / isStaleRun", () => {
  const a = newRunId();
  const b = newRunId();
  assert.equal(typeof a, "string");
  assert.notEqual(a, b);
  assert.equal(isStaleRun("runA", "runB"), true);
  assert.equal(isStaleRun("runA", "runA"), false);
  assert.equal(isStaleRun(null, "runB"), false);
  assert.equal(isStaleRun("runA", null), true);
});

// ===================== Instagram =====================

test("detectPlatform: instagram", () => {
  assert.equal(detectPlatform("https://www.instagram.com/p/AbC123/"), "instagram");
  assert.equal(detectPlatform("https://instagram.com/reel/xyz_9/"), "instagram");
  assert.equal(detectPlatform("https://www.instagram.com/"), "instagram");
  assert.equal(detectPlatform("https://instagram.com.evil.com/x"), null);
  assert.equal(isInstagramUrl("https://www.instagram.com/p/x/"), true);
  assert.equal(isInstagramUrl("https://google.com"), false);
});

test("IG: username normalized — no @, lowercase, allowed charset", () => {
  assert.equal(normalizeName("@user123", "instagram"), "user123");
  assert.equal(normalizeName("User.Name_1", "instagram"), "user.name_1");
  assert.equal(normalizeName("USER123", "instagram"), "user123");
  assert.equal(normalizeInstagramUsername("@  spaced  "), "");
});

test("IG: reject invalid usernames", () => {
  assert.equal(normalizeName("User Name", "instagram"), ""); // space
  assert.equal(normalizeName("user-name", "instagram"), ""); // hyphen
  assert.equal(normalizeName("a..b", "instagram"), ""); // double dot
  assert.equal(normalizeName(".lead", "instagram"), ""); // leading dot
  assert.equal(normalizeName("trail.", "instagram"), ""); // trailing dot
  assert.equal(normalizeName("https://evil.com", "instagram"), "");
});

test("IG: reject UI/navigation words", () => {
  assert.equal(normalizeName("followers", "instagram"), "");
  assert.equal(normalizeName("explore", "instagram"), "");
  assert.equal(normalizeName("instagram", "instagram"), "");
  assert.equal(normalizeName("reel", "instagram"), "");
  assert.equal(normalizeName("direct", "instagram"), "");
  assert.equal(normalizeName("threads", "instagram"), "");
});

test("IG: merge dedupes case-insensitively (lowercase canonical)", () => {
  const out = mergeNames(
    [],
    ["User123", "@user123", "User.123", "followers"],
    "instagram"
  );
  assert.deepEqual(out, ["user123", "user.123"]);
});

test("isFacebookPostPage: permalink post shapes (synthetic GraphQL ready)", () => {
  // Bentuk lama (teks/foto/video/reel)
  assert.equal(isFacebookPostPage("https://www.facebook.com/posts/10153322400567519"), true);
  assert.equal(
    isFacebookPostPage("https://www.facebook.com/permalink.php?story_fbid=10153322400567519&id=14038332518"),
    true
  );
  assert.equal(
    isFacebookPostPage("https://www.facebook.com/story.php?story_fbid=10153322400567519"),
    true
  );
  assert.equal(isFacebookPostPage("https://www.facebook.com/photos/123456789012345"), true);
  assert.equal(isFacebookPostPage("https://www.facebook.com/videos/10151234567890123"), true);
  assert.equal(isFacebookPostPage("https://www.facebook.com/reel/1076159001615150"), true);
  assert.equal(isFacebookPostPage("https://m.facebook.com/story.php?story_fbid=10153322400567519"), true);
  // Bentuk modern yang sebelumnya MISS (v1.0.28): slug posts, watch?v=, album
  assert.equal(
    isFacebookPostPage("https://www.facebook.com/LaraFabianTheNetherlands/posts/2-photos-source-gala-france1/960401149426609/"),
    true
  );
  assert.equal(
    isFacebookPostPage("https://www.facebook.com/watch?v=3762250110740268"),
    true
  );
  assert.equal(
    isFacebookPostPage("https://www.facebook.com/watch/?v=1467518380953415"),
    true
  );
  assert.equal(
    isFacebookPostPage("https://www.facebook.com/watch/live/?ref=watch_permalink&v=10151234567890123"),
    true
  );
  assert.equal(
    isFacebookPostPage("https://www.facebook.com/video.php?v=10151234567890123"),
    true
  );
  assert.equal(
    isFacebookPostPage("https://www.facebook.com/media/set/?set=a.2286037437005.2137559.1430993860"),
    true
  );
  assert.equal(
    isFacebookPostPage("https://www.facebook.com/metalwavewebzine/photos/a.10223953348016180.1829884567"),
    true
  );
  // Bukan permalink post: profil, feed, album tanpa story id, null
  assert.equal(isFacebookPostPage("https://www.facebook.com/100000123456789"), false);
  assert.equal(
    isFacebookPostPage("https://www.facebook.com/media/set/?set=a.1293535879446466&type=3"),
    false
  );
  assert.equal(isFacebookPostPage("https://www.facebook.com/"), false);
  assert.equal(isFacebookPostPage("https://www.facebook.com/home"), false);
  assert.equal(isFacebookPostPage("https://www.facebook.com/groups/x"), false);
  assert.equal(isFacebookPostPage(null), false);
  assert.equal(isFacebookPostPage(""), false);
});

test("extractFbFeedbackIds: prioritas & dedupe kandidat id permalink", () => {
  const ids = extractFbFeedbackIds(
    "https://www.facebook.com/photo.php?fbid=123456789012345&set=a.757108353089224.1812885352.1020472719478&type=3"
  );
  assert.deepEqual(ids, ["123456789012345", "1020472719478"]);
  // Postingan multi-foto (set=pcb.): story id menang atas fbid (id foto)
  assert.deepEqual(
    extractFbFeedbackIds(
      "https://www.facebook.com/photo?fbid=1483436860484357&set=pcb.1483436933817683"
    ),
    ["1483436933817683", "1483436860484357"]
  );
  // Dedupe: watch?v= muncul sekali walau dari dua sumber
  assert.deepEqual(
    extractFbFeedbackIds("https://www.facebook.com/watch/?v=1467518380953415"),
    ["1467518380953415"]
  );
  assert.deepEqual(extractFbFeedbackIds("https://www.facebook.com/"), []);
});

test("extractInstagramShortcode: post/reel/share shapes", () => {
  assert.equal(extractInstagramShortcode("https://www.instagram.com/p/AbC123/"), "AbC123");
  assert.equal(extractInstagramShortcode("https://www.instagram.com/reel/xyz_9/"), "xyz_9");
  assert.equal(extractInstagramShortcode("https://www.instagram.com/share/p/AbC123/"), "AbC123");
  assert.equal(extractInstagramShortcode("https://www.instagram.com/"), null);
});

test("sanitizeInstagramTemplateUrl: strips cursor params, keeps base", () => {
  const clean = sanitizeInstagramTemplateUrl(
    "https://www.instagram.com/api/v1/media/12345/comments/?can_support_threading=true&max_id=abc&index=0&__a=1"
  );
  assert.ok(clean.includes("/media/12345/comments/"));
  assert.ok(clean.includes("can_support_threading=true"));
  assert.ok(!clean.includes("max_id"));
  assert.ok(!clean.includes("index"));
  assert.equal(sanitizeInstagramTemplateUrl("https://www.tiktok.com/api/comment/list/"), null);
});

test("isInstagramTemplateValid: shape + TTL", () => {
  const url =
    "https://www.instagram.com/api/v1/media/12345/comments/?can_support_threading=true";
  assert.equal(
    isInstagramTemplateValid(url, { capturedAt: Date.now(), mediaId: "12345" }),
    true
  );
  assert.equal(
    isInstagramTemplateValid(url, { capturedAt: Date.now() - 31 * 60 * 1000 }),
    false // expired (TTL 30 min)
  );
  assert.equal(
    isInstagramTemplateValid(
      "https://www.instagram.com/api/v1/media/12345/comments/999/inline_child_comments/",
      { capturedAt: Date.now() }
    ),
    false // reply URLs are not top-level templates
  );
});

test("IG: storage key + default state", () => {
  assert.equal(STORAGE_KEY_IG, "ing_state");
  assert.equal(IG_TEMPLATE_KEY, "ing_comment_url");
  assert.equal(storageKeyFor("instagram"), STORAGE_KEY_IG);
  assert.equal(defaultStateFor("instagram").includeReplies, false);
  assert.equal(defaultStateFor("instagram").hasTemplate, false);
  assert.equal(defaultStateFor("tiktok").includeReplies, false);
  assert.equal(defaultStateFor("facebook").includeReplies, true);
});
