/**
 * Unit tests untuk logika murni engine Facebook (inject-fb.js):
 * fbIdB64 / fbIdsMatch / normalizeFeedbackId / buildSyntheticPaginationTemplates.
 * Pure ESM — node --test, zero deps. Fungsi diekstrak langsung dari source
 * (brace-counting) dan dieksekusi dengan stub minimal, sehingga perbaikan
 * engine apa pun di masa depan langsung ter-uji di sini.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "inject-fb.js"),
  "utf8"
);

function extract(fnName) {
  const start = src.indexOf(`function ${fnName}(`);
  assert.ok(start >= 0, `function ${fnName} not found in inject-fb.js`);
  const openIdx = src.indexOf("{", start);
  let depth = 0;
  let i = openIdx;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return src.slice(start, i + 1);
}

const b64 = (s) => Buffer.from(s, "binary").toString("base64");
const atob = (s) => Buffer.from(s, "base64").toString("binary");

const helpers = new Function(
  "btoa",
  "atob",
  `${extract("fbIdB64")}
   ${extract("fbIdsMatch")}
   ${extract("normalizeFeedbackId")}
   return { fbIdB64, fbIdsMatch, normalizeFeedbackId };`
)(b64, atob);

const { fbIdB64, fbIdsMatch, normalizeFeedbackId } = helpers;

// Nilai nyata dari laporan user (permalink album kolektif):
// https://www.facebook.com/photo?fbid=1483436860484357&set=pcb.1483436933817683
const REAL_ID = "1483436860484357";
const REAL_B64 = b64(`feedback:${REAL_ID}`);

// ===================== fbIdB64 =====================
test("fbIdB64: id mentah → base64 Relay feedback:<id>", () => {
  assert.equal(fbIdB64(REAL_ID), REAL_B64);
  assert.equal(fbIdB64(REAL_ID), "ZmVlZGJhY2s6MTQ4MzQzNjg2MDQ4NDM1Nw==");
  assert.notEqual(fbIdB64(REAL_ID), REAL_ID); // benar-benar ditransformasi
});

test("fbIdB64: non-string / empty dipertahankan", () => {
  assert.equal(fbIdB64(null), null);
  assert.equal(fbIdB64(""), "");
});

// ===================== fbIdsMatch =====================
test("fbIdsMatch: cocok raw ↔ base64 dua arah", () => {
  assert.equal(fbIdsMatch(REAL_ID, REAL_B64), true);
  assert.equal(fbIdsMatch(REAL_B64, REAL_ID), true);
  assert.equal(fbIdsMatch(REAL_ID, REAL_ID), true);
});

test("fbIdsMatch: id berbeda / kosong → false", () => {
  assert.equal(fbIdsMatch(REAL_ID, b64("feedback:9999999999999999")), false);
  assert.equal(fbIdsMatch("", REAL_B64), false);
  assert.equal(fbIdsMatch(REAL_ID, null), false);
});

// ===================== normalizeFeedbackId =====================
test("normalizeFeedbackId: base64 Relay → id mentah", () => {
  assert.equal(normalizeFeedbackId(REAL_B64), REAL_ID);
});

test("normalizeFeedbackId: id mentah / kecil / non-string tetap apa adanya", () => {
  assert.equal(normalizeFeedbackId(REAL_ID), REAL_ID);
  assert.equal(normalizeFeedbackId("12345"), "12345");
  assert.equal(normalizeFeedbackId(null), null);
});

// ===================== PAGINATION_DOC_IDS =====================
test("PAGINATION_DOC_IDS: 3 kandidat dari scraper publik 2024–2026", () => {
  const m = src.match(/const PAGINATION_DOC_IDS\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(m, "PAGINATION_DOC_IDS tidak ditemukan");
  const ids = [...m[1].matchAll(/"(\d{10,})"/g)].map((x) => x[1]);
  assert.ok(ids.includes("25399415259725176"), "doc_id 2026 hilang");
  assert.ok(ids.includes("5676025945801633"), "doc_id 2025 hilang");
  assert.ok(ids.includes("4712008195539492"), "doc_id 2024 hilang");
  assert.equal(ids.length, 3, "harus tepat 3 kandidat");
});

// ===================== Template sintetik =====================
const DOC_IDS = ["25399415259725176", "5676025945801633", "4712008195539492"];

function buildSynth(storedDocId) {
  const fnSrc = [
    "const PAGINATION_DOC_IDS = " + JSON.stringify(DOC_IDS) + ";",
    extract("fbIdB64"),
    `function feedbackIdsFromUrl() { return ["${REAL_ID}"]; }`,
    storedDocId
      ? `function bestStoredPaginationTemplate() { return { doc_id: "${storedDocId}" }; }`
      : `function bestStoredPaginationTemplate() { return null; }`,
    extract("buildSyntheticPaginationTemplates"),
    "return buildSyntheticPaginationTemplates();",
  ].join("\n");
  return new Function("btoa", fnSrc)(b64);
}

test("Synthetic: 3 kandidat + doc_id + feedbackID Relay + Semua Komentar", () => {
  const synth = buildSynth(null);
  assert.equal(synth.length, 3);
  for (const t of synth) {
    assert.match(t.params.doc_id, /^\d{10,}$/);
    assert.equal(t.variables.feedbackID, REAL_B64);
    assert.equal(t.variables.sortKey, "RANKED_UNFILTERED");
    assert.equal(t.variables.topLevelViewOption, "RANKED_UNFILTERED");
    assert.equal(
      t.variables.commentsIntentToken,
      "RANKED_UNFILTERED_CHRONOLOGICAL_REPLIES_INTENT_V1"
    );
    assert.equal(t.variables.includeNestedComments, true);
    assert.equal(t.variables.isPaginating, true);
    assert.equal(t.url, "https://www.facebook.com/api/graphql/");
    assert.equal(t.friendlyName, "CometUFICommentsProviderPaginationQuery");
  }
});

test("Synthetic: doc_id tersimpan diprioritaskan di kandidat pertama", () => {
  const synth = buildSynth("STORED_DOC_ID_123");
  assert.equal(synth[0].params.doc_id, "STORED_DOC_ID_123");
  // id dari URL tetap dipakai untuk semua kandidat (anti salah post)
  for (const t of synth) assert.equal(t.variables.feedbackID, REAL_B64);
});
