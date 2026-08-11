/**
 * Fixture test — salinan kode bersama harus IDENTIK antar-world.
 *
 * shared.js memegang single source of truth di dalam blok marker
 * BEGIN/END-RESO-<KIND>:
 *   NORMALIZE — 3 blok: normalizeCommentName (FB), normalizeNickname (TT),
 *               normalizeInstagramUsername (IG)
 *   DONEMSG   — 1 blok: doneMessage (pesan akhir run lintas platform)
 *   PARSERS   — 3 blok: parseTikTokComments, parseIgComments,
 *               extractGraphqlNames (parse payload komentar, murni)
 *   PANELTOOLS — 1 blok: filterNames/sortNamesAz/csvContent/
 *               downloadTextFile/mergeAcrossPlatforms (perkakas UI daftar)
 *
 * Engine MAIN-world (inject-*.js) membawa salinan NORMALIZE + PARSERS;
 * content scripts (content-*.js) membawa salinan NORMALIZE + DONEMSG +
 * PANELTOOLS; popup.js memakai PANELTOOLS via export dari shared.
 * Test ini gagal saat salah satu salinan menyimpang — itulah pengaman drift.
 *
 * Node >= 18, zero dependency (node --test).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(path.join(root, f), "utf8");

/** Extract every marker block of one kind (e.g. "NORMALIZE", "DONEMSG"). */
function extractBlocks(kind, src) {
  const BEGIN = `// BEGIN-RESO-${kind}`;
  const END = `// END-RESO-${kind}`;
  const out = [];
  let i = 0;
  for (;;) {
    const b = src.indexOf(BEGIN, i);
    if (b === -1) break;
    const e = src.indexOf(END, b);
    assert.ok(e > b, `END marker missing after BEGIN ${kind}`);
    out.push(src.slice(b + BEGIN.length, e).trim());
    i = e + END.length;
  }
  return out;
}

/** Compare sources token-for-token: drop whitespace + // comments. */
function minify(src) {
  return src.replace(/\/\/[^\n]*/g, "").replace(/\s+/g, "");
}

/** Compile a marker block (function declaration) into a callable. */
function compile(fnSrc) {
  // eslint-disable-next-line no-new-func
  return new Function(`return (${fnSrc});`)();
}

// ---- Load all copies -----------------------------------------------------

const sharedNorm = extractBlocks("NORMALIZE", read("shared.js")); // [FB, TT, IG]
const sharedDone = extractBlocks("DONEMSG", read("shared.js")); // [DONE]
const sharedParsers = extractBlocks("PARSERS", read("shared.js")); // [1 block: TT+IG+FB]
const sharedTools = extractBlocks("PANELTOOLS", read("shared.js")); // [1]
const sharedUrls = extractBlocks("FBURLS", read("shared.js")); // [1 block: deteksi permalink FB]
const members = {
  "inject-fb.js": extractBlocks("NORMALIZE", read("inject-fb.js")),
  "content-fb.js": extractBlocks("NORMALIZE", read("content-fb.js")),
  "inject-tiktok.js": extractBlocks("NORMALIZE", read("inject-tiktok.js")),
  "content-tiktok.js": extractBlocks("NORMALIZE", read("content-tiktok.js")),
  "inject-ig.js": extractBlocks("NORMALIZE", read("inject-ig.js")),
  "content-ig.js": extractBlocks("NORMALIZE", read("content-ig.js")),
};
const membersDone = {
  "content-fb.js": extractBlocks("DONEMSG", read("content-fb.js")),
  "content-tiktok.js": extractBlocks("DONEMSG", read("content-tiktok.js")),
  "content-ig.js": extractBlocks("DONEMSG", read("content-ig.js")),
};
const membersParsers = {
  "inject-fb.js": extractBlocks("PARSERS", read("inject-fb.js")),
  "inject-tiktok.js": extractBlocks("PARSERS", read("inject-tiktok.js")),
  "inject-ig.js": extractBlocks("PARSERS", read("inject-ig.js")),
};
const membersTools = {
  "content-fb.js": extractBlocks("PANELTOOLS", read("content-fb.js")),
  "content-tiktok.js": extractBlocks("PANELTOOLS", read("content-tiktok.js")),
  "content-ig.js": extractBlocks("PANELTOOLS", read("content-ig.js")),
};
const membersUrls = {
  "inject-fb.js": extractBlocks("FBURLS", read("inject-fb.js")),
  "content-fb.js": extractBlocks("FBURLS", read("content-fb.js")),
};

const FILES_FB = ["inject-fb.js", "content-fb.js"];
const FILES_TT = ["inject-tiktok.js", "content-tiktok.js"];
const FILES_IG = ["inject-ig.js", "content-ig.js"];
const FILES_DONE = ["content-fb.js", "content-tiktok.js", "content-ig.js"];
const FILES_PARSERS = ["inject-fb.js", "inject-tiktok.js", "inject-ig.js"];
const FILES_TOOLS = ["content-fb.js", "content-tiktok.js", "content-ig.js"];
const FILES_URLS = ["inject-fb.js", "content-fb.js"];

test("block layout: shared 3 norm + 1 done + 3 parsers + 1 tools + 1 fburls; members carry copies", () => {
  assert.equal(sharedNorm.length, 3, "shared normalize blocks");
  assert.equal(sharedDone.length, 1, "shared doneMessage block");
  assert.equal(sharedParsers.length, 1, "shared parsers block");
  assert.equal(sharedTools.length, 1, "shared panelTools block");
  assert.equal(sharedUrls.length, 1, "shared fburls block");
  for (const f of Object.keys(members)) {
    assert.equal(members[f].length, 1, `${f} must carry one normalize block`);
  }
  for (const f of Object.keys(membersDone)) {
    assert.equal(membersDone[f].length, 1, `${f} must carry one doneMessage block`);
  }
  for (const f of Object.keys(membersParsers)) {
    assert.equal(membersParsers[f].length, 1, `${f} must carry one parser block`);
  }
  for (const f of Object.keys(membersTools)) {
    assert.equal(membersTools[f].length, 1, `${f} must carry one panelTools block`);
  }
  for (const f of Object.keys(membersUrls)) {
    assert.equal(membersUrls[f].length, 1, `${f} must carry one fburls block`);
  }
});

test("SOURCE PARITY: 6 normalize + 4 done + 9 parser + 4 panelTools + 3 fburls copies byte-identical", () => {
  const ref = [minify(sharedNorm[0]), minify(sharedNorm[1]), minify(sharedNorm[2])];
  const doneRef = minify(sharedDone[0]);
  const parserRef = minify(sharedParsers[0]); // one block: TT+IG+FB
  const toolsRef = minify(sharedTools[0]);
  const urlsRef = minify(sharedUrls[0]);
  for (const f of FILES_FB) {
    assert.equal(minify(members[f][0]), ref[0], `${f} FB normalize drifted`);
  }
  for (const f of FILES_TT) {
    assert.equal(minify(members[f][0]), ref[1], `${f} TT normalize drifted`);
  }
  for (const f of FILES_IG) {
    assert.equal(minify(members[f][0]), ref[2], `${f} IG normalize drifted`);
  }
  for (const f of FILES_DONE) {
    assert.equal(
      minify(membersDone[f][0]),
      doneRef,
      `${f} doneMessage drifted`
    );
  }
  for (const f of FILES_PARSERS) {
    assert.equal(
      minify(membersParsers[f][0]),
      parserRef,
      `${f} parser block drifted`
    );
  }
  for (const f of FILES_TOOLS) {
    assert.equal(
      minify(membersTools[f][0]),
      toolsRef,
      `${f} panelTools drifted`
    );
  }
  for (const f of FILES_URLS) {
    assert.equal(
      minify(membersUrls[f][0]),
      urlsRef,
      `${f} fburls drifted`
    );
  }
});

// ---- Behavior fixtures ----------------------------------------------------

const FB_FIXTURES = [
  ["Andi 2 jam yang lalu", "Andi"],
  ["Budi sehari yang lalu", "Budi"],
  ["Cici sekitar satu jam yang lalu", "Cici"],
  ["Dewi about 5 hours ago", "Dewi"],
  ["Eka a minute ago", "Eka"],
  ["Fani just now", "Fani"],
  ["Gilang 3d", "Gilang"],
  ["Hana 2 jam", "Hana"],
  ["Indra · 5m", "Indra"],
  ["Joko Edited", "Joko"],
  ["Kiki is with Lala", "Kiki"],
  ["@handle", ""],
  ["123456", ""],
  ["https://evil.com", ""],
  ["wa.me/12345", ""],
  ["Like", ""],
  ["Komentar", ""],
  ["Follow", ""],
  ["TikTok", ""],
  ["Most relevant", ""],
  ["😀😀😀", ""],
  ["Ahmad ❤️", "Ahmad ❤️"],
  ["Andi Pratama", "Andi Pratama"],
  ["محمد", "محمد"],
  ["田中 太郎", "田中 太郎"],
  ["View all comments", ""],
  ["See more", ""],
  ["Reply", ""],
  ["Write a comment", ""],
  ["Log in", ""],
  ["Hide", ""],
  ["Sponsor", ""],
  ["Add a comment", ""],
  ["lihat selengkapnya", ""],
  ["Send", ""],
  [null, ""],
  ["", ""],
];

const TT_FIXTURES = [
  ["@user123", "user123"],
  ["user123", "user123"],
  ["12345", ""],
  ["https://evil.com", ""],
  ["bit.ly/x", ""],
  ["Follow", ""],
  ["Komentar", ""],
  ["tiktok", ""],
  ["😀", "😀"],
  ["user 2 jam yang lalu", "user 2 jam yang lalu"],
  ["View", ""],
  ["See", ""],
  ["Write", ""],
  ["Log in", ""],
  ["like", ""],
  ["reply", ""],
  ["share", ""],
  ["comment", ""],
  ["suka", ""],
  ["balas", ""],
  ["bagikan", ""],
  ["komentar", ""],
  ["send", ""],
  ["kirim", ""],
  ["ikuti", ""],
  ["following", ""],
  ["followers", ""],
  ["Hide", ""],
  ["Open", ""],
  ["Photo", ""],
  ["Video", ""],
  ["Reels", ""],
  ["Add a comment", ""],
  ["See more", ""],
  ["Lihat selengkapnya", ""],
  ["Most relevant", ""],
  [null, ""],
  ["", ""],
];

const IG_FIXTURES = [
  ["@user123", "user123"],
  ["User.Name_1", "user.name_1"],
  ["USER123", "user123"],
  ["user_123", "user_123"],
  ["n4m3.with.dots", "n4m3.with.dots"],
  ["ok", "ok"],
  ["User Name", ""],
  ["user-name", ""],
  ["a..b", ""],
  [".lead", ""],
  ["trail.", ""],
  ["https://evil.com", ""],
  ["followers", ""],
  ["explore", ""],
  ["instagram", ""],
  ["reel", ""],
  ["direct", ""],
  ["threads", ""],
  ["@  spaced", ""],
  ["reply", ""],
  ["like", ""],
  ["comment", ""],
  ["view", ""],
  ["translate", ""],
  ["a".repeat(31), ""],
  [null, ""],
  ["", ""],
];

/** Run fixtures through every copy of a family and assert full agreement. */
function runFamily(refIdx, files, fixtures) {
  test(`BEHAVIOR: reference + copies agree on ${fixtures.length} fixtures`, () => {
    const refs = compile(sharedNorm[refIdx]);
    const impls = files.map((f) => compile(members[f][0]));
    for (const [input, expected] of fixtures) {
      const got = refs(input);
      assert.equal(
        got,
        expected,
        `reference failed for ${JSON.stringify(input)}`
      );
      for (let i = 0; i < impls.length; i++) {
        assert.equal(
          impls[i](input),
          got,
          `${files[i]} differs from reference for ${JSON.stringify(input)}`
        );
      }
    }
  });
}

runFamily(0, FILES_FB, FB_FIXTURES);
runFamily(1, FILES_TT, TT_FIXTURES);
runFamily(2, FILES_IG, IG_FIXTURES);

// ---- doneMessage behavior fixtures (guard wording contract) ----

const DONE_FN = compile(sharedDone[0]);

test("BEHAVIOR: doneMessage wording contract is platform-aware", () => {
  assert.equal(DONE_FN("complete", 5, "facebook"), "Selesai — 5 nama. Klik Copy.");
  assert.equal(
    DONE_FN("complete", 5, "instagram"),
    "Selesai — 5 username. Klik Copy."
  );
  assert.equal(
    DONE_FN("stopped", 0, "tiktok"),
    "Dihentikan — belum ada nama."
  );
  assert.equal(
    DONE_FN("stopped", 0, "instagram"),
    "Dihentikan — belum ada username."
  );
  assert.match(DONE_FN("timeout", 3, "tiktok"), /Waktu habis — 3 nama \(mungkin belum semua\)/);
  assert.match(DONE_FN("rate_limit", 7, "facebook"), /Rate limit Facebook \(429\) — 7 nama/);
  assert.match(DONE_FN("rate_limit", 4, "instagram"), /Rate limit Instagram \(429\) — 4 username/);
  assert.match(DONE_FN("rate_limit", 0, "tiktok"), /Rate limit TikTok \(429\)/);
  assert.match(DONE_FN("blocked", 2, "instagram"), /403/);
  assert.match(DONE_FN("checkpoint", 9, "instagram"), /9 username/);
  assert.match(DONE_FN("no_media", 0, "instagram"), /post\/reel/);
  assert.match(DONE_FN("no_video", 0, "tiktok"), /video/);
  assert.match(DONE_FN("idle", 0, "facebook"), /Tidak ada nama/);
  assert.match(
    DONE_FN("idle", 0, "facebook", { tip: "Tip: buka komentar dulu" }),
    /Tidak ada nama\. Tip: buka komentar dulu/
  );
  assert.match(
    DONE_FN("timeout", 42, "instagram", {
      extra: "Rate limit (429) — berhenti agar akun aman",
    }),
    /429/
  );
  assert.match(
    DONE_FN("timeout", 42, "instagram", {
      extra: "Rate limit (429) — berhenti agar akun aman",
    }),
    /42/
  );
  assert.equal(DONE_FN("complete", 0, "tiktok"), "Tidak ada nama. Pastikan komentar terbuka di video, lalu Proses lagi.");
  assert.equal(DONE_FN("idle", 0, "instagram"), "Tidak ada username. Pastikan komentar terbuka & sudah login, lalu Proses lagi.");
});

// ---- PARSERS behavior fixtures (parse payload komentar, murni) ----

// PARSERS block = 3 hoisted function declarations; compile whole block.
const PARSER_FNS = new Function(
  sharedParsers[0] +
    "\nreturn { parseTikTokComments, parseIgComments, extractGraphqlNames };"
)();
const PARSE_TT = PARSER_FNS.parseTikTokComments;
const PARSE_IG = PARSER_FNS.parseIgComments;
const PARSE_FB = PARSER_FNS.extractGraphqlNames;

test("BEHAVIOR: parseTikTokComments — array, fallback walk, replies", () => {
  // Jalur array: comments[].user.nickname
  assert.deepEqual(
    PARSE_TT(
      {
        comments: [
          { user: { nickname: "Alya" } },
          { user: { nickName: "Bima" } },
          { nickname: "Cici" },
        ],
      },
      false
    ),
    ["Alya", "Bima", "Cici"]
  );
  // Jalur data.comments (payload replay TikTok)
  assert.deepEqual(
    PARSE_TT({ data: { comments: [{ user: { nickname: "Dewi" } }] } }, false),
    ["Dewi"]
  );
  // Balasan tertanam hanya saat includeReplies
  const withReply = {
    comments: [{ user: { nickname: "Eka" }, reply_comment: [{ user: { nickname: "Fani" } }] }],
  };
  assert.deepEqual(PARSE_TT(withReply, false), ["Eka"]);
  assert.deepEqual(PARSE_TT(withReply, true), ["Eka", "Fani"]);
  // Fallback walk: objek berbentuk komentar (punya marker cid/text) di kedalaman
  assert.deepEqual(
    PARSE_TT(
      { some: { nested: { user: { nickname: "Gilang" }, text: "hai" } } },
      false
    ),
    ["Gilang"]
  );
  // Tanpa marker komentar (cid/comment_id/text/create_time/digg_count) → bukan komentar
  assert.deepEqual(
    PARSE_TT({ some: { nested: { user: { nickname: "Gilang" } } } }, false),
    []
  );
  // Payload kosong / bukan objek
  assert.deepEqual(PARSE_TT(null, false), []);
  assert.deepEqual(PARSE_TT("x", false), []);
});

test("BEHAVIOR: parseIgComments — hanya top-level comments", () => {
  assert.deepEqual(
    PARSE_IG({
      comments: [
        { user: { username: "andi_" } },
        { user: { username: "budi" } },
        { user: {} },
      ],
    }),
    ["andi_", "budi"]
  );
  assert.deepEqual(PARSE_IG({}), []);
  assert.deepEqual(PARSE_IG(null), []);
});

test("BEHAVIOR: extractGraphqlNames — pola JSON teks GraphQL FB", () => {
  const json = JSON.stringify({
    __typename: "Comment",
    author: { __typename: "User", name: "Hana" },
    created_time: 1234567,
  });
  assert.deepEqual(PARSE_FB(json), ["Hana"]);
  assert.deepEqual(PARSE_FB("no author here"), []);
  assert.deepEqual(PARSE_FB(null), []);
  assert.deepEqual(PARSE_FB(""), []);
  // Dua komentar berbeda ter-extract
  const two =
    '{"__typename":"Comment","author":{"__typename":"User","name":"Ida"}}' +
    '{"__typename":"Comment","author":{"__typename":"User","name":"Joko"}}';
  assert.deepEqual(PARSE_FB(two), ["Ida", "Joko"]);
});

// ---- FBURLS behavior fixtures (deteksi permalink per bentuk URL) ----

// FBURLS block = 3 hoisted function declarations; compile whole block.
const URLS_FNS = new Function(
  sharedUrls[0] +
    "\nreturn { extractFbFeedbackIds, extractFbFeedbackId, isFacebookPostPage };"
)();

const FB_URL_CASES = [
  // [url, expected ids, isPostPage]
  ["https://www.facebook.com/posts/10153322400567519", ["10153322400567519"], true],
  ["https://www.facebook.com/LaraFabianTheNetherlands/posts/2-photos-source-gala-france1/960401149426609/", ["960401149426609"], true],
  ["https://www.facebook.com/permalink.php?story_fbid=10153322400567519&id=14038332518", ["10153322400567519"], true],
  ["https://www.facebook.com/permalink.php?story_fbid=pfbid024uFTLCkH5XDVJBrbeuCmZJixzf2qJM8kKr&id=123", ["pfbid024uFTLCkH5XDVJBrbeuCmZJixzf2qJM8kKr"], true],
  ["https://www.facebook.com/story.php?story_fbid=10153322400567519", ["10153322400567519"], true],
  ["https://www.facebook.com/photo.php?fbid=123456789012345&set=a.757108353089224.1812885352.1020472719478&type=3", ["123456789012345", "1020472719478"], true],
  // Terverifikasi lapangan (2026-08-11): klik gambar 1 di postingan multi-foto
  // → /photo?fbid=<id foto>&set=pcb.<story id> — story id harus menang atas fbid
  ["https://www.facebook.com/photo?fbid=1483436860484357&set=pcb.1483436933817683", ["1483436933817683", "1483436860484357"], true],
  ["https://www.facebook.com/kominfojember/posts/pfbid02oqmBrVwpYWoUhRCaoMbwGUqwzUz7375c3cZVmr5Zbih6BeHUVZ8GQCcz8xtSJCiPl", ["pfbid02oqmBrVwpYWoUhRCaoMbwGUqwzUz7375c3cZVmr5Zbih6BeHUVZ8GQCcz8xtSJCiPl"], true],
  ["https://www.facebook.com/metalwavewebzine/photos/a.10223953348016180.1829884567", ["1829884567"], true],
  ["https://www.facebook.com/photos/123456789012345", ["123456789012345"], true],
  ["https://www.facebook.com/videos/10151234567890123", ["10151234567890123"], true],
  ["https://www.facebook.com/reel/1076159001615150", ["1076159001615150"], true],
  ["https://www.facebook.com/watch?v=3762250110740268", ["3762250110740268"], true],
  ["https://www.facebook.com/watch/?v=1467518380953415", ["1467518380953415"], true],
  ["https://www.facebook.com/watch/live/?ref=watch_permalink&v=10151234567890123", ["10151234567890123"], true],
  ["https://www.facebook.com/video.php?v=10151234567890123", ["10151234567890123"], true],
  ["https://www.facebook.com/media/set/?set=a.2286037437005.2137559.1430993860", ["1430993860"], true],
  ["https://www.facebook.com/media/set/?set=a.1293535879446466&type=3", [], false],
  ["https://www.facebook.com/100000123456789", [], false],
  ["https://www.facebook.com/profile.php?id=100000123456789", [], false],
  ["https://www.facebook.com/", [], false],
  ["https://www.facebook.com/groups/x", [], false],
  [null, [], false],
  ["", [], false],
];

test("BEHAVIOR: fburls — ekstraksi id + isPostPage per bentuk URL", () => {
  for (const [url, wantIds, wantPage] of FB_URL_CASES) {
    assert.deepEqual(
      URLS_FNS.extractFbFeedbackIds(url),
      wantIds,
      `ids for ${url}`
    );
    assert.equal(URLS_FNS.isFacebookPostPage(url), wantPage, `page for ${url}`);
    assert.equal(
      URLS_FNS.extractFbFeedbackId(url),
      wantIds.length ? wantIds[0] : null,
      `first for ${url}`
    );
  }
});

// ---- PANELTOOLS behavior fixtures (filter/sort/CSV/merge) ----

// PANELTOOLS block references normalizeName (defined in shared.js module
// scope). Compile the three normalizers + dispatcher + tools block together
// so mergeAcrossPlatforms runs against the real rules.
const NORM_IMPL = sharedNorm.map((b) => compile(b));
const TOOLS = new Function(
  `function normalizeName(raw, platform) {
     if (platform === "instagram") return (${sharedNorm[2]})(raw);
     if (platform === "tiktok") return (${sharedNorm[1]})(raw);
     return (${sharedNorm[0]})(raw);
   }` +
    sharedTools[0] +
    "\nreturn { filterNames, sortNamesAz, csvContent, mergeAcrossPlatforms };"
)();

test("BEHAVIOR: filterNames case-insensitive substring", () => {
  assert.deepEqual(TOOLS.filterNames(["Andi", "Budi", "Cici"], "bu"), ["Budi"]);
  assert.deepEqual(TOOLS.filterNames(["Andi", "Budi"], ""), ["Andi", "Budi"]);
  assert.deepEqual(TOOLS.filterNames(["Andi"], null), ["Andi"]);
  assert.deepEqual(TOOLS.filterNames([], "x"), []);
});

test("BEHAVIOR: sortNamesAz locale id + stable", () => {
  assert.deepEqual(TOOLS.sortNamesAz(["budi", "Andi", "çak"]), ["Andi", "budi", "çak"]);
  assert.deepEqual(TOOLS.sortNamesAz([]), []);
});

test("BEHAVIOR: csvContent BOM + header platform-aware", () => {
  assert.equal(TOOLS.csvContent(["A", "B"], false), "\uFEFFNama\nA\nB");
  assert.equal(TOOLS.csvContent(["a"], true), "\uFEFFUsername\na");
  assert.equal(TOOLS.csvContent([], false), "\uFEFFNama\n");
});

test("BEHAVIOR: mergeAcrossPlatforms — normalisasi per-platform, dedupe", () => {
  const merged = TOOLS.mergeAcrossPlatforms([
    { platform: "facebook", names: ["Andi Pratama", "Andi Pratama"] },
    { platform: "tiktok", names: ["@user123", "😀"] },
    { platform: "instagram", names: ["andi_pratama", "USER123"] },
  ]);
  const joined = merged.join("|");
  assert.ok(joined.includes("Andi Pratama"), "FB name with space survives");
  assert.ok(joined.includes("user123"), "TT @handle normalized");
  assert.ok(joined.includes("😀"), "TT emoji survives");
  assert.ok(joined.includes("andi_pratama"), "IG username survives");
  assert.equal(new Set(merged.map((s) => s.toLowerCase())).size, merged.length, "dedupe");
});
