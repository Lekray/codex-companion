"use strict";
/*
 * Pure transform for the latest-turn autoscroll effect in the official ChatGPT
 * 26.1021.22027 webview local-conversation-thread bundle.
 *
 * The pristine effect scrolls to the bottom only when a prework_follow
 * viewport observes prework -> final_answer. If the user is already at the
 * bottom in static or prework_watch, the output phase change does not re-arm
 * follow. This module rewrites only that effect tail: the existing
 * prework_follow path is preserved, and a genuine transition to final_answer
 * in any non-user_follow mode at a finite 0..24px distance clears the spacer,
 * re-arms scroll_to_bottom and scrolls instantly to the bottom.
 *
 * Same-phase rerenders, user_follow, non-final phases and distances that are
 * >24, negative, non-finite or unknown are untouched. The reducer, layout and
 * every other byte of the bundle are preserved. The source is hash-pinned and
 * treated as text; it is never evaluated here.
 */

const crypto = require("node:crypto");

const SUPPORTED_VERSION = "26.1021.22027";
const FILE = "webview/assets/local-conversation-thread-a37d62aef644.js";
const ORIGINAL_HASH =
  "2fcd72651c746aed39703185eecc59e285479db3a7a5710e326c2810da1ed563";
const PATCHED_HASH =
  "670ec720c734332d68050319cc047bd853dd6ddbea0edeab10effe0db6d81ed4";

const ORIGINAL_EFFECT_TAIL =
  "let i=U.current;q({type:`latest_turn_phase_changed`,latestTurnPhase:A,previousLatestTurnPhase:t}),t===`prework`&&A===`final_answer`&&i.followMode===`prework_follow`&&(B(),F.scrollToDistanceFromBottomPx(0,`instant`))";
const PATCHED_EFFECT_TAIL =
  "let i=U.current,s;q({type:`latest_turn_phase_changed`,latestTurnPhase:A,previousLatestTurnPhase:t}),(t===`prework`&&A===`final_answer`&&i.followMode===`prework_follow`||t!==A&&A===`final_answer`&&i.followMode!==`user_follow`&&(s=F.getLastScrollDistanceFromBottomPx(),s=Number.isFinite(s)&&s>=0&&s<=24))&&(q({type:`scroll_to_bottom`},!0),B(),F.scrollToDistanceFromBottomPx(0,`instant`))";

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function countOccurrences(text, needle) {
  let count = 0;
  let from = 0;
  for (;;) {
    const index = text.indexOf(needle, from);
    if (index === -1) return count;
    count += 1;
    from = index + needle.length;
  }
}

/*
 * Structural analysis without a hash check. Exactly one known variant of the
 * effect tail must be present; transform() still refuses anything whose
 * whole-file hash is not pinned.
 */
function analyze(source) {
  if (typeof source !== "string") {
    throw new TypeError("autoscroll: source must be a string");
  }

  const originalCount = countOccurrences(source, ORIGINAL_EFFECT_TAIL);
  const patchedCount = countOccurrences(source, PATCHED_EFFECT_TAIL);
  if (originalCount + patchedCount !== 1) {
    throw new Error(
      `autoscroll: known effect tail must occur exactly once (original ${originalCount}, patched ${patchedCount})`
    );
  }

  const patched = patchedCount === 1;
  const tail = patched ? PATCHED_EFFECT_TAIL : ORIGINAL_EFFECT_TAIL;
  const tailStart = source.indexOf(tail);
  return {
    version: SUPPORTED_VERSION,
    file: FILE,
    patched,
    tailStart,
    tailEnd: tailStart + tail.length,
    tailLength: tail.length,
  };
}

function transform(source) {
  if (typeof source !== "string") {
    throw new TypeError("autoscroll: source must be a string");
  }

  const inputHash = sha256(source);
  if (inputHash === PATCHED_HASH) return source;
  if (inputHash !== ORIGINAL_HASH) {
    throw new Error(
      `autoscroll: unsupported ${FILE} SHA256 ${inputHash}; expected ${ORIGINAL_HASH}`
    );
  }

  const info = analyze(source);
  if (info.patched) {
    throw new Error("autoscroll: pristine effect tail is missing");
  }

  const output =
    source.slice(0, info.tailStart) +
    PATCHED_EFFECT_TAIL +
    source.slice(info.tailEnd);
  const outputHash = sha256(output);
  if (outputHash !== PATCHED_HASH) {
    throw new Error(
      `autoscroll: deterministic output SHA256 ${outputHash} does not match ${PATCHED_HASH}`
    );
  }
  return output;
}

module.exports = {
  SUPPORTED_VERSION,
  FILE,
  ORIGINAL_HASH,
  PATCHED_HASH,
  ORIGINAL_EFFECT_TAIL,
  PATCHED_EFFECT_TAIL,
  transform,
  analyze,
};

if (require.main === module) {
  process.stderr.write("officialAutoscroll.cjs exports pure transforms only\n");
  process.exitCode = 2;
}
