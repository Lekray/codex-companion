"use strict";
/*
 * Pure draft-isolation transform for the pinned official Codex 26.1007.21434
 * extension.
 *
 * Input is the accepted history + model + title workflow baseline:
 *   - webview/assets/app-initial-c014f9ee4429.js (accepted workflow bytes)
 *   - webview/assets/app-initial-7a199c66e670.js (unmodified fifth original)
 *
 * Changed seams:
 *   - both bundles receive the dependency-free helper from
 *     resources/officialDraftIsolation.js as a prefix. The 7a prefix makes
 *     __companionDraftIsolation available before the cyclic ESM graph reaches
 *     early Fv calls / native atom initialization; 7a native bytes are
 *     otherwise completely unchanged.
 *   - c014 Fv: only the kind:"new" / entrypoint:"home" / gptId==null branch
 *     wraps its native xp({entrypoint:"home"}) result in
 *     __companionDraftIsolation.scopeKey(). Every other branch, including
 *     panel, saved/local, gpt-draft, cloud, chatgpt and other, is byte
 *     identical. This one key scopes the native ComposerScope atom and both
 *     native persistent text/document stores without a per-focus suffix.
 *
 * Everything else (host, 97d and unknown files) is returned unchanged. The
 * function is pure: it never writes, never reads CLI artifacts, and refuses
 * unknown bytes (hash/marker/anchor mismatch, duplicate anchors, double apply).
 * Installer integration, backups and live acceptance belong to Main.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const HOST_FILE = "out/extension.js";
const TITLE_BUNDLE_FILE = "webview/assets/app-initial-97d3534ad35f.js";
const DRAFT_7A_FILE = "webview/assets/app-initial-7a199c66e670.js";
const DRAFT_C014_FILE = "webview/assets/app-initial-c014f9ee4429.js";

const FIFTH_FILE = DRAFT_7A_FILE;
const ORIGINAL_7A_SHA256 =
  "59b909377a370e09cb8523ab99a1f4ff282a0126527bd339db31e6d9ac7c9c26";
const FIFTH_FILE_SHA256 = ORIGINAL_7A_SHA256;
const ACCEPTED_WORKFLOW_C014_SHA256 =
  "a39eeb9e8403aa8feacb7bffb75c09f500aeeb1b10991de7cc4d5c6904cfe4be";

const TARGET_FILES = Object.freeze([DRAFT_7A_FILE, DRAFT_C014_FILE]);
const HELPER_FILE = "resources/officialDraftIsolation.js";
const HELPER_GLOBAL = "__companionDraftIsolation";
const DRAFT_MARKER = "companion-draft-isolation-v1";

// ---------------------------------------------------------------------------
// Exact native anchors (backtick as \u0060 to keep source ASCII-safe)
// ---------------------------------------------------------------------------

const FV_ANCHOR =
  "case\u0060home\u0060:return e.gptId==null?xp({entrypoint:\u0060home\u0060}):\u0060gpt-draft:${e.gptId}\u0060;";

const FV_REPLACEMENT =
  "case\u0060home\u0060:return e.gptId==null?" +
  "__companionDraftIsolation.scopeKey(xp({entrypoint:\u0060home\u0060})):" +
  "\u0060gpt-draft:${e.gptId}\u0060;";

const C014_BASELINE_MARKERS = Object.freeze([
  "companion-history-scope-changed",
  "companion-tab-title",
  "__companionModelHost",
  "__companionModelCell",
  "draft-thread-identities-v1"
]);

function draftIsolationSourcePath() {
  return path.join(__dirname, "..", "resources", "officialDraftIsolation.js");
}

function loadDraftIsolationSource() {
  return fs.readFileSync(draftIsolationSourcePath(), "utf8");
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function replaceOnce(text, needle, replacement, label) {
  const index = text.indexOf(needle);
  if (index === -1) throw new Error(`draft anchor not found: ${label}`);
  if (text.indexOf(needle, index + needle.length) !== -1) {
    throw new Error(`draft anchor not unique: ${label}`);
  }
  return text.slice(0, index) + replacement + text.slice(index + needle.length);
}

function validateHelperSource(source) {
  if (typeof source !== "string" || source.length === 0) {
    throw new Error("draft helper source is empty");
  }
  if (
    !source.includes(HELPER_GLOBAL) ||
    !source.includes(DRAFT_MARKER) ||
    !source.includes("scopeKey")
  ) {
    throw new Error("draft helper source is not the expected isolation helper");
  }
  return source;
}

function helperBlock(source) {
  return "/* " + DRAFT_MARKER + " */\n" + source.replace(/\s+$/, "") + "\n";
}

function generateDraftText(file, baselineText, helperSource) {
  if (typeof baselineText !== "string") throw new Error("baseline text must be a string");
  if (file !== DRAFT_7A_FILE && file !== DRAFT_C014_FILE) return baselineText;

  if (baselineText.includes(DRAFT_MARKER) || baselineText.includes(HELPER_GLOBAL)) {
    throw new Error(`draft isolation is already present: ${file}`);
  }

  if (file === DRAFT_7A_FILE) {
    if (sha256(baselineText) !== ORIGINAL_7A_SHA256) {
      throw new Error("draft 7a: known prefix SHA256 mismatch");
    }
    const helper = validateHelperSource(
      helperSource === undefined ? loadDraftIsolationSource() : helperSource
    );
    return helperBlock(helper) + baselineText;
  }

  if (sha256(baselineText) !== ACCEPTED_WORKFLOW_C014_SHA256) {
    throw new Error("draft c014: accepted workflow SHA256 mismatch");
  }
  for (const marker of C014_BASELINE_MARKERS) {
    if (!baselineText.includes(marker)) {
      throw new Error(`draft c014: accepted workflow baseline is missing ${marker}`);
    }
  }

  const helper = validateHelperSource(
    helperSource === undefined ? loadDraftIsolationSource() : helperSource
  );
  let text = helperBlock(helper) + baselineText;
  text = replaceOnce(text, FV_ANCHOR, FV_REPLACEMENT, "c014:scope native home draft key");
  return text;
}

function applyDraftTransforms(file, baselineText, helperSource) {
  return generateDraftText(file, baselineText, helperSource);
}

module.exports = {
  applyDraftTransforms,
  generateDraftText,
  loadDraftIsolationSource,
  draftIsolationSourcePath,
  replaceOnce,
  sha256,
  HOST_FILE,
  TITLE_BUNDLE_FILE,
  DRAFT_7A_FILE,
  DRAFT_C014_FILE,
  FIFTH_FILE,
  FIFTH_FILE_SHA256,
  TARGET_FILES,
  HELPER_FILE,
  HELPER_GLOBAL,
  DRAFT_MARKER,
  FV_ANCHOR,
  FV_REPLACEMENT,
  ORIGINAL_7A_SHA256,
  ACCEPTED_WORKFLOW_C014_SHA256,
  C014_BASELINE_MARKERS
};

if (require.main === module) {
  // Intentionally no CLI: the parent owns guarded install/rollback.
  process.stderr.write("officialDraftTransform.cjs exports pure transforms only\n");
  process.exitCode = 2;
}
