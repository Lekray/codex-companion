"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const autoscroll = require("../../scripts/officialAutoscroll.cjs");

const EXPECTED_ORIGINAL_HASH =
  "2fcd72651c746aed39703185eecc59e285479db3a7a5710e326c2810da1ed563";
const EXPECTED_PATCHED_HASH =
  "670ec720c734332d68050319cc047bd853dd6ddbea0edeab10effe0db6d81ed4";

const sourcePath = path.resolve(
  __dirname,
  "../../.artifacts/autoscroll/baseline-official",
  autoscroll.FILE
);
const sourceAvailable = fs.existsSync(sourcePath);
const source = sourceAvailable ? fs.readFileSync(sourcePath, "utf8") : "";
const patched = sourceAvailable ? autoscroll.transform(source) : "";
const originalInfo = sourceAvailable ? autoscroll.analyze(source) : null;
const patchedInfo = sourceAvailable ? autoscroll.analyze(patched) : null;

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

function sliceBetween(text, startMarker, endMarker, label) {
  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, `${label}: start marker is missing`);
  assert.equal(
    countOccurrences(text, startMarker),
    1,
    `${label}: start marker must occur exactly once`
  );
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `${label}: end marker is missing`);
  return text.slice(start, end);
}

/*
 * Pull the native reducer and its small follow-mode helper straight out of the
 * bundle. The transform must never rewrite either of them.
 */
function extractReducer(text) {
  const vg = sliceBetween(text, "function vg(e,t){", "function yg(e)", "reducer vg");
  const xgStart = "function xg(e,t){";
  const start = text.indexOf(xgStart);
  assert.notEqual(start, -1, "reducer helper xg is missing");
  assert.equal(countOccurrences(text, xgStart), 1, "reducer helper xg must occur once");
  const end = text.indexOf("function ", start + xgStart.length);
  assert.notEqual(end, -1, "reducer helper xg end is missing");
  const xg = text.slice(start, end);
  return `${xg}\n${vg}`;
}

function extractEffectTail(text) {
  return sliceBetween(
    text,
    "let i=U.current",
    "},t[82]=B",
    "latest-turn effect tail"
  );
}

const originalReducer = sourceAvailable ? extractReducer(source) : "";
const patchedReducer = sourceAvailable ? extractReducer(patched) : "";
const originalTail = sourceAvailable ? extractEffectTail(source) : "";
const patchedTail = sourceAvailable ? extractEffectTail(patched) : "";

function compileReducer(code) {
  return new Function(`${code}\nreturn vg;`)();
}

const reduce = sourceAvailable ? compileReducer(originalReducer) : null;
const compileEffect = (tail) => new Function("U", "q", "B", "F", "A", "t", tail);

function needSource(t) {
  if (sourceAvailable) return true;
  t.skip(`baseline ${autoscroll.FILE} is not available at ${sourcePath}`);
  return false;
}

function runEffect(tail, scenario) {
  const events = [];
  const initial = { followMode: scenario.followMode };
  let state = initial;
  let distanceReads = 0;

  const q = (action, force) => {
    events.push({ kind: "dispatch", type: action.type, force });
    state = reduce(state, action);
  };
  const B = () => {
    events.push({ kind: "clear_spacer" });
  };
  const F = {
    getLastScrollDistanceFromBottomPx() {
      distanceReads += 1;
      events.push({ kind: "read_distance" });
      return scenario.distance;
    },
    scrollToDistanceFromBottomPx(distance, behavior) {
      events.push({ kind: "scroll", distance, behavior });
    },
  };
  const U = { current: initial };

  compileEffect(tail)(U, q, B, F, scenario.latestPhase, scenario.previousPhase);
  return { events, state, distanceReads };
}

function expectedRuns(scenario) {
  const initial = { followMode: scenario.followMode };
  const afterPhase = reduce(initial, {
    type: "latest_turn_phase_changed",
    latestTurnPhase: scenario.latestPhase,
    previousLatestTurnPhase: scenario.previousPhase,
  });
  const oldCase =
    scenario.previousPhase === "prework" &&
    scenario.latestPhase === "final_answer" &&
    scenario.followMode === "prework_follow";
  const transitionToFinal =
    scenario.previousPhase !== scenario.latestPhase &&
    scenario.latestPhase === "final_answer" &&
    scenario.followMode !== "user_follow";
  const evaluateNewCase = !oldCase && transitionToFinal;
  const atBottom =
    typeof scenario.distance === "number" &&
    Number.isFinite(scenario.distance) &&
    scenario.distance >= 0 &&
    scenario.distance <= 24;
  const newRearm = evaluateNewCase && atBottom;
  const rearm = oldCase || newRearm;

  const phase = {
    kind: "dispatch",
    type: "latest_turn_phase_changed",
    force: undefined,
  };
  const scrollToBottom = {
    kind: "dispatch",
    type: "scroll_to_bottom",
    force: true,
  };
  const readDistance = { kind: "read_distance" };
  const clearSpacer = { kind: "clear_spacer" };
  const scroll = { kind: "scroll", distance: 0, behavior: "instant" };

  const baselineEvents = oldCase
    ? [phase, clearSpacer, scroll]
    : [phase];
  let patchedEvents;
  if (oldCase) {
    patchedEvents = [phase, scrollToBottom, clearSpacer, scroll];
  } else if (evaluateNewCase && atBottom) {
    patchedEvents = [phase, readDistance, scrollToBottom, clearSpacer, scroll];
  } else if (evaluateNewCase) {
    patchedEvents = [phase, readDistance];
  } else {
    patchedEvents = [phase];
  }

  return {
    baseline: {
      events: baselineEvents,
      state: oldCase ? { followMode: "user_follow" } : afterPhase,
      distanceReads: 0,
    },
    patched: {
      events: patchedEvents,
      state: rearm ? { followMode: "user_follow" } : afterPhase,
      distanceReads: evaluateNewCase ? 1 : 0,
    },
  };
}

const CASES = [];
for (const previousPhase of ["idle", "prework"]) {
  for (const followMode of ["prework_watch", "static"]) {
    for (const distance of [0, 24, 25, 120, -1, NaN]) {
      CASES.push({
        name: `${followMode} ${previousPhase}->final at ${String(distance)}`,
        previousPhase,
        latestPhase: "final_answer",
        followMode,
        distance,
      });
    }
  }
}
CASES.push(
  {
    name: "prework_follow prework->final far from bottom",
    previousPhase: "prework",
    latestPhase: "final_answer",
    followMode: "prework_follow",
    distance: 120,
  },
  {
    name: "prework_follow prework->final at 0",
    previousPhase: "prework",
    latestPhase: "final_answer",
    followMode: "prework_follow",
    distance: 0,
  },
  {
    name: "prework_follow idle->final at 0",
    previousPhase: "idle",
    latestPhase: "final_answer",
    followMode: "prework_follow",
    distance: 0,
  },
  {
    name: "prework_follow idle->final far from bottom",
    previousPhase: "idle",
    latestPhase: "final_answer",
    followMode: "prework_follow",
    distance: 120,
  },
  {
    name: "direct idle->final at 0",
    previousPhase: "idle",
    latestPhase: "final_answer",
    followMode: "static",
    distance: 0,
  },
  {
    name: "repeated final rerender",
    previousPhase: "final_answer",
    latestPhase: "final_answer",
    followMode: "static",
    distance: 0,
  },
  {
    name: "user_follow transition",
    previousPhase: "idle",
    latestPhase: "final_answer",
    followMode: "user_follow",
    distance: 0,
  },
  {
    name: "idle->prework",
    previousPhase: "idle",
    latestPhase: "prework",
    followMode: "static",
    distance: 0,
  },
  {
    name: "final->idle",
    previousPhase: "final_answer",
    latestPhase: "idle",
    followMode: "static",
    distance: 0,
  },
  {
    name: "same prework rerender",
    previousPhase: "prework",
    latestPhase: "prework",
    followMode: "prework_watch",
    distance: 0,
  },
  {
    name: "unknown Infinity distance",
    previousPhase: "idle",
    latestPhase: "final_answer",
    followMode: "static",
    distance: Infinity,
  },
  {
    name: "unknown undefined distance",
    previousPhase: "idle",
    latestPhase: "final_answer",
    followMode: "static",
    distance: undefined,
  }
);

test("exports the pinned autoscroll constants", () => {
  assert.equal(autoscroll.SUPPORTED_VERSION, "26.1021.22027");
  assert.equal(
    autoscroll.FILE,
    "webview/assets/local-conversation-thread-a37d62aef644.js"
  );
  assert.equal(autoscroll.ORIGINAL_HASH, EXPECTED_ORIGINAL_HASH);
  assert.equal(autoscroll.PATCHED_HASH, EXPECTED_PATCHED_HASH);
  assert.ok(autoscroll.ORIGINAL_EFFECT_TAIL.includes("i.followMode===`prework_follow`"));
  assert.ok(autoscroll.PATCHED_EFFECT_TAIL.includes("Number.isFinite"));
  assert.ok(autoscroll.PATCHED_EFFECT_TAIL.includes("scroll_to_bottom"));
});

test("pins the exact baseline and replaces only the effect tail", (t) => {
  if (!needSource(t)) return;

  assert.equal(sha256(source), autoscroll.ORIGINAL_HASH);
  assert.equal(originalInfo.patched, false);
  assert.equal(originalInfo.tailLength, autoscroll.ORIGINAL_EFFECT_TAIL.length);
  assert.equal(originalTail, autoscroll.ORIGINAL_EFFECT_TAIL);
  assert.equal(countOccurrences(source, autoscroll.ORIGINAL_EFFECT_TAIL), 1);
  assert.equal(countOccurrences(source, autoscroll.PATCHED_EFFECT_TAIL), 0);

  assert.equal(sha256(patched), autoscroll.PATCHED_HASH);
  assert.equal(patchedInfo.patched, true);
  assert.equal(patchedInfo.tailStart, originalInfo.tailStart);
  assert.equal(patchedInfo.tailLength, autoscroll.PATCHED_EFFECT_TAIL.length);
  assert.equal(patchedTail, autoscroll.PATCHED_EFFECT_TAIL);
  assert.equal(
    patched.length,
    source.length -
      autoscroll.ORIGINAL_EFFECT_TAIL.length +
      autoscroll.PATCHED_EFFECT_TAIL.length
  );
  assert.equal(
    patched.slice(0, originalInfo.tailStart),
    source.slice(0, originalInfo.tailStart)
  );
  assert.equal(
    patched.slice(patchedInfo.tailEnd),
    source.slice(originalInfo.tailEnd)
  );
  assert.equal(countOccurrences(patched, autoscroll.ORIGINAL_EFFECT_TAIL), 0);
  assert.equal(countOccurrences(patched, autoscroll.PATCHED_EFFECT_TAIL), 1);
});

test("is idempotent but refuses unknown bytes", (t) => {
  if (!needSource(t)) return;

  assert.equal(autoscroll.transform(patched), patched);
  assert.throws(() => autoscroll.transform(source + " "), /SHA256/);
  assert.throws(() => autoscroll.transform(patched + " "), /SHA256/);
  assert.throws(() => autoscroll.transform(""), /SHA256/);
  assert.throws(
    () =>
      autoscroll.transform(
        source.replace(
          "latest_turn_phase_changed",
          "latest_turn_phase_changed_"
        )
      ),
    /SHA256/
  );
  assert.throws(() => autoscroll.transform(null), /source must be a string/);
  assert.throws(() => autoscroll.transform(42), /source must be a string/);
});

test("analyze rejects missing, duplicated and mutated effect seams", (t) => {
  if (!needSource(t)) return;

  assert.throws(
    () => autoscroll.analyze(""),
    /known effect tail must occur exactly once/
  );
  assert.throws(
    () => autoscroll.analyze(source + autoscroll.ORIGINAL_EFFECT_TAIL),
    /known effect tail must occur exactly once/
  );
  assert.throws(
    () => autoscroll.analyze(patched + autoscroll.ORIGINAL_EFFECT_TAIL),
    /known effect tail must occur exactly once/
  );
  assert.throws(
    () =>
      autoscroll.analyze(
        source.replace(autoscroll.ORIGINAL_EFFECT_TAIL, "mutated")
      ),
    /known effect tail must occur exactly once/
  );
  assert.throws(() => autoscroll.analyze(null), /source must be a string/);
});

test("patched bundle remains valid native ES module syntax", (t) => {
  if (!needSource(t)) return;

  const check = spawnSync(
    process.execPath,
    ["--input-type=module", "--check", "-"],
    { input: patched, encoding: "utf8", windowsHide: true }
  );
  assert.equal(check.status, 0, check.stderr);
});

test("native vg reducer is untouched by the transform", (t) => {
  if (!needSource(t)) return;

  assert.equal(originalReducer, patchedReducer);
  assert.equal(typeof reduce, "function");

  const phase = (previousLatestTurnPhase, latestTurnPhase) => ({
    type: "latest_turn_phase_changed",
    previousLatestTurnPhase,
    latestTurnPhase,
  });

  assert.deepEqual(
    reduce({ followMode: "prework_follow" }, phase("prework", "final_answer")),
    { followMode: "user_follow" }
  );
  assert.deepEqual(
    reduce({ followMode: "static" }, phase("prework", "final_answer")),
    { followMode: "static" }
  );
  assert.deepEqual(
    reduce({ followMode: "prework_watch" }, phase("prework", "final_answer")),
    { followMode: "static" }
  );
  assert.deepEqual(
    reduce({ followMode: "prework_watch" }, phase("idle", "final_answer")),
    { followMode: "prework_watch" }
  );
  assert.deepEqual(
    reduce({ followMode: "static" }, phase("idle", "final_answer")),
    { followMode: "static" }
  );
  assert.deepEqual(
    reduce({ followMode: "user_follow" }, phase("idle", "final_answer")),
    { followMode: "user_follow" }
  );
  assert.deepEqual(
    reduce({ followMode: "static" }, phase("final_answer", "final_answer")),
    { followMode: "static" }
  );
  assert.deepEqual(
    reduce({ followMode: "static" }, { type: "scroll_to_bottom" }),
    { followMode: "user_follow" }
  );
});

test("effect tail adds re-arm only for bottom final-answer transitions", (t) => {
  if (!needSource(t)) return;

  for (const scenario of CASES) {
    const expected = expectedRuns(scenario);
    const baseline = runEffect(originalTail, scenario);
    const patchedRun = runEffect(patchedTail, scenario);

    assert.deepEqual(baseline, expected.baseline, `${scenario.name}: baseline`);
    assert.deepEqual(patchedRun, expected.patched, `${scenario.name}: patched`);
    assert.deepEqual(
      patchedRun.events[0],
      baseline.events[0],
      `${scenario.name}: phase dispatch is preserved`
    );
  }
});

test("prework_follow far from bottom keeps the old clear+scroll path", (t) => {
  if (!needSource(t)) return;

  const scenario = {
    previousPhase: "prework",
    latestPhase: "final_answer",
    followMode: "prework_follow",
    distance: 120,
  };
  const baseline = runEffect(originalTail, scenario);
  const patchedRun = runEffect(patchedTail, scenario);
  const phase = {
    kind: "dispatch",
    type: "latest_turn_phase_changed",
    force: undefined,
  };

  assert.deepEqual(baseline.events, [
    phase,
    { kind: "clear_spacer" },
    { kind: "scroll", distance: 0, behavior: "instant" },
  ]);
  assert.deepEqual(patchedRun.events, [
    phase,
    { kind: "dispatch", type: "scroll_to_bottom", force: true },
    { kind: "clear_spacer" },
    { kind: "scroll", distance: 0, behavior: "instant" },
  ]);
  assert.equal(baseline.distanceReads, 0);
  assert.equal(patchedRun.distanceReads, 0);
});

test("distant, invalid and non-final transitions do not re-arm", (t) => {
  if (!needSource(t)) return;

  const scenarios = [
    {
      previousPhase: "idle",
      latestPhase: "final_answer",
      followMode: "static",
      distance: 25,
    },
    {
      previousPhase: "idle",
      latestPhase: "final_answer",
      followMode: "static",
      distance: -1,
    },
    {
      previousPhase: "idle",
      latestPhase: "final_answer",
      followMode: "static",
      distance: NaN,
    },
    {
      previousPhase: "final_answer",
      latestPhase: "final_answer",
      followMode: "static",
      distance: 0,
    },
    {
      previousPhase: "idle",
      latestPhase: "final_answer",
      followMode: "user_follow",
      distance: 0,
    },
    {
      previousPhase: "idle",
      latestPhase: "prework",
      followMode: "static",
      distance: 0,
    },
    {
      previousPhase: "final_answer",
      latestPhase: "idle",
      followMode: "static",
      distance: 0,
    },
  ];

  for (const scenario of scenarios) {
    const run = runEffect(patchedTail, scenario);
    assert.equal(run.events.some((event) => event.kind === "scroll"), false);
    assert.equal(
      run.events.some(
        (event) =>
          event.kind === "dispatch" && event.type === "scroll_to_bottom"
      ),
      false
    );
    assert.equal(run.events.some((event) => event.kind === "clear_spacer"), false);
  }
});
