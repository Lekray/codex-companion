"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const recovery = require("../../scripts/officialWebviewRecovery.cjs");
const root = path.resolve(__dirname, "../..");
const fixture = process.env.COMPANION_WEBVIEW_RECOVERY_FIXTURE
  ? path.resolve(process.env.COMPANION_WEBVIEW_RECOVERY_FIXTURE)
  : path.join(root, ".artifacts/webview-recovery/originals/rail.js");

assert.ok(fs.existsSync(fixture), `webview recovery fixture is missing: ${fixture}`);
const source = fs.readFileSync(fixture, "utf8");

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

function cssIndices(dependencies) {
  const result = [];
  for (let index = 0; index < dependencies.length; index += 1) {
    if (recovery.dependencyKind(dependencies[index]) === "css") result.push(index);
  }
  return result;
}

function parsePatchedIndices(patched) {
  const factoryStart = patched.indexOf(recovery.FACTORY_PREFIX);
  assert.notEqual(factoryStart, -1, "patched lazy factory prefix");
  const start = factoryStart + recovery.FACTORY_PREFIX.length;
  const patchedSuffix = recovery.FACTORY_SUFFIX.replace(
    recovery.PROPAGATE_TRUE,
    recovery.PROPAGATE_FALSE
  );
  const end = patched.indexOf(patchedSuffix, start);
  assert.notEqual(end, -1, "patched lazy factory suffix");
  return patched.slice(start, end).split(",").map(Number);
}

const info = recovery.analyze(source);
const patched = recovery.transform(source);
const retainedCss = cssIndices(info.dependencies);

test("pins the exact pristine 26.1021.22027 bundle", () => {
  assert.equal(recovery.SUPPORTED_VERSION, "26.1021.22027");
  assert.equal(
    recovery.FILE,
    "webview/assets/bookmarked-thread-user-message-navigation-36a0dadf9f5d.js"
  );
  assert.equal(
    recovery.ORIGINAL_HASH,
    "6295d2141f11872bb070e03049e326a7cc340bd6ffdb3761f5a80bea88ba186b"
  );
  assert.equal(sha256(source), recovery.ORIGINAL_HASH);
  assert.equal(info.dependencyCount, 2775);
  assert.equal(info.cssDependencyCount, 143);
  assert.equal(info.jsDependencyCount, 2632);
  assert.equal(info.removedDependencyCount, 2632);
  assert.deepEqual(retainedCss, info.retainedDependencyIndices);
});

test("changes exactly the dependency index list and propagate flag", () => {
  assert.equal(sha256(patched), recovery.PATCHED_HASH);

  const originalList = source.slice(info.listStart, info.listEnd);
  const replacement = retainedCss.join(",");
  const expected =
    source.slice(0, info.listStart) +
    replacement +
    source.slice(info.listEnd, info.propagateStart) +
    recovery.PROPAGATE_FALSE +
    source.slice(info.propagateStart + recovery.PROPAGATE_TRUE.length);
  assert.equal(patched, expected);

  assert.equal(patched.slice(0, info.listStart), source.slice(0, info.listStart));
  assert.equal(
    patched.slice(
      info.propagateStart + replacement.length - originalList.length + recovery.PROPAGATE_FALSE.length
    ),
    source.slice(info.propagateStart + recovery.PROPAGATE_TRUE.length)
  );

  const revertedList =
    patched.slice(0, info.listStart) +
    originalList +
    patched.slice(info.listStart + replacement.length);
  const revertedFlag =
    revertedList.slice(0, info.propagateStart) +
    recovery.PROPAGATE_TRUE +
    revertedList.slice(info.propagateStart + recovery.PROPAGATE_FALSE.length);
  assert.equal(revertedFlag, source);

  assert.equal(countOccurrences(patched, recovery.PROPAGATE_TRUE), 0);
  assert.equal(countOccurrences(patched, recovery.PROPAGATE_FALSE), 1);
  assert.equal(patched.length, 111614);
});

test("retains every CSS URL/index and drops every speculative JS preload", () => {
  const outputMapEnd = patched.indexOf(recovery.MAP_CLOSING);
  assert.notEqual(outputMapEnd, -1);
  const outputMap = JSON.parse(
    patched.slice(recovery.MAP_PREFIX.length, outputMapEnd + 1)
  );
  assert.deepEqual(outputMap, info.dependencies);

  const indices = parsePatchedIndices(patched);
  assert.equal(indices.length, 143);
  assert.deepEqual(indices, retainedCss);
  assert.equal(new Set(indices).size, indices.length);
  for (const index of indices) {
    assert.equal(recovery.dependencyKind(info.dependencies[index]), "css");
    assert.equal(outputMap[index], info.dependencies[index]);
  }

  const retained = new Set(indices);
  for (let index = 0; index < info.dependencies.length; index += 1) {
    if (recovery.dependencyKind(info.dependencies[index]) === "js") {
      assert.equal(retained.has(index), false, `speculative JS index ${index} was retained`);
    }
  }
});

test("leaves the native dynamic import, lazy runtime and retry calls untouched", () => {
  const importCall =
    "await import(`./thread-user-message-navigation-rail-app-e1fd1e68ad98.js`)";
  assert.equal(countOccurrences(patched, importCall), 1);
  assert.equal(countOccurrences(patched, "d(async()=>(await n(async()=>"), 1);
  assert.equal(
    countOccurrences(patched, "return{AppThreadUserMessageNavigationRail:e}}"),
    1
  );
  assert.equal(countOccurrences(patched, ",import.meta.url)).AppThreadUserMessageNavigationRail,"), 1);
  assert.equal(countOccurrences(patched, "propagateLoadError"), 1);
});

test("patched bundle is valid native ES module syntax", () => {
  const check = spawnSync(process.execPath, ["--input-type=module", "--check", "-"], {
    input: patched,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(check.status, 0, check.stderr);
});

test("exact pinned output is idempotent but any other source is refused", () => {
  assert.equal(recovery.transform(patched), patched);
  assert.throws(() => recovery.transform(source + " "), /SHA256/);
  assert.throws(() => recovery.transform(""), /SHA256/);
  assert.throws(
    () => recovery.transform(source.replace("const __vite__mapDeps", "var __vite__mapDeps")),
    /SHA256/
  );
  assert.throws(() => recovery.transform(null), /source must be a string/);
});

test("analyze rejects missing, duplicated and malformed structural seams", () => {
  assert.throws(
    () => recovery.analyze(source.slice(0, 100) + recovery.MAP_PREFIX + source.slice(100)),
    /dependency table prefix must occur exactly once/
  );
  assert.throws(
    () => recovery.analyze(source.slice(0, 100) + recovery.MAP_CLOSING + source.slice(100)),
    /dependency table closing seam must occur exactly once/
  );
  assert.throws(
    () => recovery.analyze(source.replace(recovery.MAP_CLOSING, "")),
    /dependency table closing seam must occur exactly once/
  );
  assert.throws(
    () =>
      recovery.analyze(
        source.slice(0, 100) + recovery.FACTORY_PREFIX + source.slice(100)
      ),
    /lazy factory prefix must occur exactly once/
  );
  assert.throws(
    () => recovery.analyze(source.replace(recovery.FACTORY_SUFFIX, "")),
    /lazy factory suffix must occur exactly once/
  );
  assert.throws(
    () => recovery.analyze(source.slice(0, 0) + recovery.PROPAGATE_TRUE + source),
    /propagateLoadError flag must occur exactly once/
  );

  const duplicateUrl = source.replace(
    JSON.stringify(info.dependencies[1]),
    JSON.stringify(info.dependencies[0])
  );
  assert.throws(() => recovery.analyze(duplicateUrl), /dependency URLs must be unique/);

  const missingDependency = source.replace(
    JSON.stringify(info.dependencies[0]) + ",",
    ""
  );
  assert.throws(
    () => recovery.analyze(missingDependency),
    /dependency table must contain 2775 entries/
  );

  const duplicateIndex =
    source.slice(0, info.listStart + 2) + "0" + source.slice(info.listStart + 3);
  assert.throws(
    () => recovery.analyze(duplicateIndex),
    /dependency index list is not exactly 0\.\.2774/
  );

  const withoutLastIndex =
    source.slice(0, info.listEnd - 5) + source.slice(info.listEnd);
  assert.throws(() => recovery.analyze(withoutLastIndex), /dependency index list/);
});

test("CSS classification uses the URL pathname, not raw suffix substrings", () => {
  assert.equal(recovery.dependencyKind("./x.css"), "css");
  assert.equal(recovery.dependencyKind("./x.js"), "js");
  assert.equal(recovery.dependencyKind("./x.css.js"), "js");
  assert.equal(recovery.dependencyKind("./x.js.css"), "css");
  assert.equal(recovery.dependencyKind("./x.css?cache=.js"), "css");
  assert.equal(recovery.dependencyKind("./x.js#fragment.css"), "js");
  assert.throws(() => recovery.dependencyKind("./x.txt"), /unsupported dependency extension/);
  assert.throws(() => recovery.dependencyKind("../x.css"), /not local/);
  assert.throws(() => recovery.dependencyKind("https://example.invalid/x.css"), /not local/);
});
