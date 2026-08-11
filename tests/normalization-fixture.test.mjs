/**
 * Fixture test — salinan kode bersama harus IDENTIK antar-world.
 *
 * shared.js memegang single source of truth di dalam blok marker
 * BEGIN/END-RESO-<KIND>:
 *   NORMALIZE — 3 blok: normalizeCommentName (FB), normalizeNickname (TT),
 *               normalizeInstagramUsername (IG)
 *   DONEMSG   — 1 blok: doneMessage (pesan akhir run lintas platform)
 *
 * Engine MAIN-world (inject-*.js) membawa salinan NORMALIZE;
 * content scripts (content-*.js) membawa salinan NORMALIZE + DONEMSG.
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

const FILES_FB = ["inject-fb.js", "content-fb.js"];
const FILES_TT = ["inject-tiktok.js", "content-tiktok.js"];
const FILES_IG = ["inject-ig.js", "content-ig.js"];
const FILES_DONE = ["content-fb.js", "content-tiktok.js", "content-ig.js"];

test("block layout: shared 3 norm + 1 done; members carry copies", () => {
  assert.equal(sharedNorm.length, 3, "shared normalize blocks");
  assert.equal(sharedDone.length, 1, "shared doneMessage block");
  for (const f of Object.keys(members)) {
    assert.equal(members[f].length, 1, `${f} must carry one normalize block`);
  }
  for (const f of Object.keys(membersDone)) {
    assert.equal(membersDone[f].length, 1, `${f} must carry one doneMessage block`);
  }
});

test("SOURCE PARITY: 6 normalize copies + 4 doneMessage copies byte-identical", () => {
  const ref = [minify(sharedNorm[0]), minify(sharedNorm[1]), minify(sharedNorm[2])];
  const doneRef = minify(sharedDone[0]);
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
