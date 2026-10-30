"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const recovery = require("../../scripts/officialComposerRecovery.cjs");
const root = path.resolve(__dirname, "../..");
const fixture = process.env.COMPANION_COMPOSER_RECOVERY_FIXTURE || path.join(root, ".artifacts/composer-recovery/originals", recovery.FILE);
const sourceAvailable = fs.existsSync(fixture);
const source = sourceAvailable ? fs.readFileSync(fixture, "utf8") : "";
const payload = fs.readFileSync(recovery.RESOURCE_FILE, "utf8");
const info = sourceAvailable ? recovery.analyze(source) : null;
const patched = sourceAvailable ? recovery.transform(source) : "";
const digest = (text) => crypto.createHash("sha256").update(text).digest("hex");
const first = "composer-content-1ca427b8427a.js";
const second = "queued-message-list-862b10cb6af9.js";
const importError = (file = first) => new TypeError(`Failed to fetch dynamically imported module: https://webview.invalid/assets/${file}`);
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function flush() { for (let n = 0; n < 12; n += 1) await Promise.resolve(); }
function runtime() {
  const context = vm.createContext({ console: { warn() {} }, setTimeout, clearTimeout });
  vm.runInContext(payload, context);
  return context;
}
function harness(firstLoader, secondLoader = () => Promise.resolve({ QueuedMessageList: "queue" })) {
  let time = 0, next = 0;
  const timers = new Map(), calls = [[], []], reports = [], snapshots = [];
  const env = {
    setTimeout(fn, delay) { const id = ++next; timers.set(id, { at: time + delay, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    report(error) { reports.push(error); }
  };
  const controller = runtime().__companionComposerController([
    { path: first, load(suffix) { calls[0].push(suffix); return firstLoader(suffix); } },
    { path: second, load(suffix) { calls[1].push(suffix); return secondLoader(suffix); } }
  ], env);
  const unsubscribe = controller.subscribe((value) => snapshots.push(value));
  async function advance(ms) {
    const until = time + ms;
    while (true) {
      const entry = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      time = entry[1].at; timers.delete(entry[0]); entry[1].fn(); await flush();
    }
    time = until; await flush();
  }
  return { controller, calls, reports, snapshots, timers, advance, unsubscribe };
}

test("composer recovery pins exact pristine input and deterministic output", { skip: !sourceAvailable }, () => {
  assert.equal(recovery.SUPPORTED_VERSION, "26.1021.22027");
  assert.equal(digest(source), recovery.ORIGINAL_HASH);
  assert.equal(digest(patched), recovery.PATCHED_HASH);
  assert.equal(recovery.transform(patched), patched);
  assert.equal(recovery.transform(source), patched);
  assert.equal(info.dependencyCount, 2776);
  assert.equal(info.cssDependencyCount, 143);
  assert.equal(info.jsDependencyCount, 2633);
});

test("preserves native dependency table, exports, each CSS list and root implementation identity", { skip: !sourceAvailable }, () => {
  const originalTable = source.slice(0, source.indexOf('import{'));
  assert.ok(patched.includes(originalTable));
  assert.ok(patched.endsWith(source.slice(info.factoryEnd)));
  assert.ok(patched.includes('rS as __companionComposerReact,Xx as t,Yx as n,ym as r'));
  info.roots.forEach((entry) => {
    const expected = entry.indices.filter((index) => info.dependencies[index].endsWith(".css"));
    assert.deepEqual(entry.cssIndices, expected);
    assert.ok(patched.includes(`import(${JSON.stringify("./" + entry.path)}+suffix),__vite__mapDeps([${expected.join(",")}])`));
  });
  assert.equal(patched.includes("propagateLoadError:!0"), false);
  assert.equal((patched.match(/companionComposerRetry=/g) || []).length, 1);
  assert.equal(/postMessage|location\.|thread\/(?:resume|interrupt|start)|turn\/(?:start|interrupt)|fetch\(/.test(payload), false);
});

test("rejects unknown bytes, truncated tables and ambiguous native seams", { skip: !sourceAvailable }, () => {
  assert.throws(() => recovery.transform(source + " "), /unsupported.*SHA256/);
  assert.throws(() => recovery.transform(42), /source must be a string/);
  assert.throws(() => recovery.analyze(source.replace('"./composer-content-1ca427b8427a.js",', '')), /dependency table/);
  assert.throws(() => recovery.analyze(source + source), /duplicated seam/);
});

test("patched ESM parses and the resource is inert before native initialization", { skip: !sourceAvailable }, () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: patched, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const context = vm.createContext({});
  vm.runInContext(payload, context);
  assert.equal(typeof context.__companionCreateComposerRecovery, "function");
});

test("successful initial load caches both roots and leaves no timers", async () => {
  const h = harness(() => Promise.resolve({ ComposerContent: "composer" }));
  h.controller.start(); await flush();
  assert.equal(h.controller.getSnapshot().status, "ready");
  assert.deepEqual(h.calls, [[""], [""]]);
  assert.equal(h.timers.size, 0);
  h.controller.start(); assert.equal(h.calls[0].length, 1);
});

test("transient root fetch uses one bounded root query and retains successful peer", async () => {
  let count = 0;
  const h = harness(() => ++count === 1 ? Promise.reject(importError()) : Promise.resolve({ ComposerContent: "composer" }));
  h.controller.start(); await flush();
  assert.equal(h.controller.getSnapshot().status, "loading");
  await h.advance(199); assert.equal(h.calls[0].length, 1);
  await h.advance(1);
  assert.equal(h.controller.getSnapshot().status, "ready");
  assert.deepEqual(h.calls, [["", "?companionComposerRetry=1"], [""]]);
  assert.equal(h.reports.length, 1);
});

test("queued root can retry without reimporting successful composer", async () => {
  let count = 0;
  const h = harness(() => Promise.resolve({ ComposerContent: "composer" }), () => ++count === 1 ? Promise.reject(importError(second)) : Promise.resolve({ QueuedMessageList: "queue" }));
  h.controller.start(); await flush(); await h.advance(200);
  assert.equal(h.controller.getSnapshot().status, "ready");
  assert.deepEqual(h.calls, [[""], ["", "?companionComposerRetry=1"]]);
});

test("persistent failure exhausts exactly two automatic retries then three explicit retries", async () => {
  const h = harness(() => Promise.reject(importError()));
  h.controller.start(); await flush(); await h.advance(800);
  assert.equal(h.controller.getSnapshot().status, "error");
  assert.equal(h.calls[0].length, 3);
  for (let i = 0; i < 3; i += 1) {
    assert.equal(h.controller.retry(), true);
    assert.equal(h.controller.retry(), false, "duplicate click during loading");
    await flush();
    assert.equal(h.controller.getSnapshot().status, "error");
    await h.advance(100000);
    assert.equal(h.calls[0].length, 4 + i, "manual retry cannot restart automatic loop");
  }
  assert.equal(h.controller.getSnapshot().canRetry, false);
  assert.equal(h.controller.retry(), false);
  assert.deepEqual(h.calls[0], ["", ...[1, 2, 3, 4, 5].map((n) => `?companionComposerRetry=${n}`)]);
  assert.equal(h.timers.size, 0);
});

test("manual recovery can succeed without reimporting its peer", async () => {
  let fail = true;
  const h = harness(() => fail ? Promise.reject(importError()) : Promise.resolve({ ComposerContent: "composer" }));
  h.controller.start(); await flush(); await h.advance(800);
  fail = false; h.controller.retry(); await flush();
  assert.equal(h.controller.getSnapshot().status, "ready");
  assert.equal(h.calls[1].length, 1);
});

test("runtime exceptions propagate to native boundary and never trigger retry", async () => {
  for (const error of [new TypeError("Cannot read properties of undefined"), new SyntaxError("Unexpected token"), new Error("Failed to fetch dynamically imported module: x")]) {
    const h = harness(() => Promise.reject(error));
    h.controller.start(); await flush(); await h.advance(100000);
    assert.equal(h.controller.getSnapshot().status, "fatal");
    assert.equal(h.controller.getSnapshot().error, error);
    assert.equal(h.controller.retry(), false);
    assert.equal(h.calls[0].length, 1);
    assert.equal(h.reports.length, 0);
  }
});

test("dependent module failure remains bounded and never gains a rewritten dependency URL", async () => {
  const h = harness(() => Promise.reject(importError("static-dependency.js")));
  h.controller.start(); await flush(); await h.advance(800);
  assert.equal(h.controller.getSnapshot().status, "error");
  assert.deepEqual(h.calls[0], ["", "", ""]);
});

test("similarly named dependency cannot cause cache busting of the wrong root", async () => {
  const h = harness(() => Promise.reject(importError(first + "-other.js")));
  h.controller.start(); await flush(); await h.advance(800);
  assert.deepEqual(h.calls[0], ["", "", ""]);
});

test("hanging import times out; late result cannot overwrite newer recovery", async () => {
  const late = deferred(); let count = 0;
  const h = harness(() => ++count === 1 ? late.promise : Promise.resolve({ ComposerContent: "new" }));
  h.controller.start(); await flush(); await h.advance(12000);
  assert.equal(h.reports.length, 1);
  await h.advance(200);
  assert.equal(h.controller.getSnapshot().status, "ready");
  late.resolve({ ComposerContent: "stale" }); await flush();
  assert.equal(h.controller.getSnapshot().modules[0].ComposerContent, "new");
  assert.deepEqual(h.calls[0], ["", "?companionComposerRetry=1"]);
});

test("all hanging requests reach visible error after the finite automatic budget", async () => {
  const h = harness(() => new Promise(() => {}));
  h.controller.start(); await flush(); await h.advance(36800);
  assert.equal(h.controller.getSnapshot().status, "error");
  assert.equal(h.calls[0].length, 3);
  assert.equal(h.timers.size, 0);
});

test("unmount clears scheduled retries and cannot emit stale results", async () => {
  const h = harness(() => Promise.reject(importError()));
  h.controller.start(); await flush();
  const before = h.snapshots.length;
  h.unsubscribe(); await h.advance(100000);
  assert.equal(h.snapshots.length, before);
  assert.equal(h.calls[0].length, 1);
  assert.equal(h.timers.size, 0);
  assert.equal(h.controller.retry(), false);
});

test("unmount during pending import prevents callbacks and reuses successful late cache", async () => {
  const late = deferred();
  const h = harness(() => late.promise);
  h.controller.start(); await flush(); const before = h.snapshots.length;
  h.unsubscribe(); late.resolve({ ComposerContent: "cached" }); await flush();
  assert.equal(h.snapshots.length, before);
  const unsubscribe = h.controller.subscribe(() => {});
  h.controller.start(); await flush();
  assert.equal(h.controller.getSnapshot().status, "ready");
  assert.deepEqual(h.calls[0], [""]);
  unsubscribe();
});

test("remount cannot reset exhausted automatic or manual attempt caps", async () => {
  const h = harness(() => Promise.reject(importError()));
  h.controller.start(); await flush(); await h.advance(800);
  for (let i = 0; i < 3; i += 1) { h.controller.retry(); await flush(); }
  h.unsubscribe();
  const unsubscribe = h.controller.subscribe(() => {});
  h.controller.start(); await h.advance(100000);
  assert.equal(h.controller.getSnapshot().canRetry, false);
  assert.equal(h.calls[0].length, 6);
  unsubscribe();
});

test("one subscriber unmount cannot cancel another mounted composer", async () => {
  const late = deferred(); const h = harness(() => late.promise);
  const seen = [];
  const unsubscribe = h.controller.subscribe((state) => seen.push(state.status));
  h.controller.start(); await flush(); h.unsubscribe();
  late.resolve({ ComposerContent: "composer" }); await flush();
  assert.equal(h.controller.getSnapshot().status, "ready");
  assert.deepEqual(seen, ["loading", "ready"]);
  unsubscribe();
});

test("composer React wrapper exposes local accessible loading and error UI; native runtime errors throw", () => {
  const context = runtime(); let state, effect;
  const React = {
    useState(initial) { state ??= initial(); return [state, (value) => { state = value; }]; },
    useEffect(fn) { effect = fn; }
  };
  const jsx = { jsx(type, props) { return { type, props }; }, jsxs(type, props) { return { type, props }; } };
  const component = context.__companionCreateComposerRecovery(React, jsx, []);
  let view = component({ draft: "keep" });
  assert.equal(view.props["data-companion-composer-recovery"], "loading");
  assert.equal(view.props.children[0].props["aria-live"], "polite");
  assert.equal(typeof effect, "function");
  state = { status: "error", attempt: 3, canRetry: true };
  view = component({ draft: "keep" });
  assert.equal(view.props["data-companion-composer-recovery"], "error");
  assert.equal(view.props.children[2].type, "button");
  assert.equal(view.props.children[2].props.type, "button");
  assert.equal(view.props.children[2].props.children, "Повторить загрузку");
  state = { status: "error", attempt: 6, canRetry: false };
  view = component({ draft: "keep" });
  assert.ok(view.props.children[2].props.children.includes("вручную"));
  state = { status: "ready", modules: [{ ComposerContent: "native" }, { QueuedMessageList: "queued" }] };
  view = component({ draft: "keep", onSubmit: "unchanged" });
  assert.equal(view.type, "native");
  assert.equal(view.props.draft, "keep");
  assert.equal(view.props.onSubmit, "unchanged");
  assert.equal(view.props.queuedMessageList, "queued");
  const error = new TypeError("native bug");
  state = { status: "fatal", error };
  assert.throws(() => component({}), (value) => value === error);
});
