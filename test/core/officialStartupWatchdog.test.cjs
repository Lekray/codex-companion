"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const patcher = require("../../scripts/patchOfficialHistory.cjs");

const ROOT = path.resolve(__dirname, "..", "..");
const ORIG_DIR = path.join(ROOT, ".artifacts", "openai-project-history", "original");
const WATCHDOG_SOURCE = fs.readFileSync(
  path.join(ROOT, "resources", "officialStartupWatchdog.js"),
  "utf8"
);

function makeClock() {
  let now = 0;
  let nextId = 1;
  let timers = [];
  function fakeSetTimeout(fn, ms) {
    const id = nextId++;
    timers.push({ id, at: now + Math.max(0, Number(ms) || 0), fn });
    return id;
  }
  function fakeClearTimeout(id) {
    timers = timers.filter((timer) => timer.id !== id);
  }
  function advance(ms) {
    const target = now + ms;
    for (;;) {
      const due = timers
        .filter((timer) => timer.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      timers = timers.filter((timer) => timer.id !== due.id);
      now = due.at;
      due.fn();
    }
    now = target;
  }
  return {
    date: { now: () => now },
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    advance,
    pending: () => timers.length,
  };
}

function loadWatchdog() {
  const clock = makeClock();
  const factory = new Function(
    "Date",
    "setTimeout",
    "clearTimeout",
    WATCHDOG_SOURCE +
      "\nreturn {__companionStartupWatchdog:__companionStartupWatchdog,__companionBindStartupVisibility:__companionBindStartupVisibility};"
  );
  const api = factory(clock.date, clock.setTimeout, clock.clearTimeout);
  return { ...api, clock };
}

function makePanel(visible) {
  const listeners = [];
  const subscription = {
    disposed: 0,
    dispose() {
      this.disposed += 1;
    },
  };
  return {
    visible,
    active: false,
    listeners,
    subscription,
    onDidChangeViewState(listener) {
      listeners.push(listener);
      return subscription;
    },
    fire() {
      for (const listener of listeners.slice()) listener({ visible: this.visible });
    },
  };
}

test("default visible watchdog fires exactly once at 30000ms", () => {
  const { __companionStartupWatchdog: Watchdog, clock } = loadWatchdog();
  const calls = [];
  const watchdog = new Watchdog((info) => calls.push(info));

  watchdog.start();
  watchdog.start();
  assert.strictEqual(clock.pending(), 1);
  clock.advance(29999);
  assert.strictEqual(calls.length, 0);
  clock.advance(1);
  assert.deepStrictEqual(calls, [
    {
      elapsedMs: 30000,
      receivedWebviewMessage: false,
      timeoutMs: 30000,
      visibleElapsedMs: 30000,
    },
  ]);
  assert.strictEqual(watchdog.disposed, true);
  assert.strictEqual(clock.pending(), 0);

  watchdog.start();
  watchdog.setVisible(false);
  watchdog.setVisible(true);
  clock.advance(90000);
  assert.strictEqual(calls.length, 1);
});

test("hidden before start never arms; reveal spends the full 30000 visible ms", () => {
  const { __companionStartupWatchdog: Watchdog, clock } = loadWatchdog();
  const calls = [];
  const watchdog = new Watchdog((info) => calls.push(info));

  watchdog.setVisible(false);
  watchdog.start();
  clock.advance(60000);
  assert.strictEqual(clock.pending(), 0);
  assert.strictEqual(calls.length, 0);

  watchdog.setVisible(true);
  assert.strictEqual(clock.pending(), 1);
  clock.advance(29999);
  assert.strictEqual(calls.length, 0);
  clock.advance(1);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].elapsedMs, 90000);
  assert.strictEqual(calls[0].visibleElapsedMs, 30000);
});

test("hide pauses and reveal resumes the same cumulative visible budget", () => {
  const { __companionStartupWatchdog: Watchdog, clock } = loadWatchdog();
  const calls = [];
  const watchdog = new Watchdog((info) => calls.push(info));

  watchdog.start();
  clock.advance(10000);
  watchdog.setVisible(false);
  assert.strictEqual(clock.pending(), 0);
  clock.advance(20000);
  watchdog.setVisible(true);
  assert.strictEqual(clock.pending(), 1);
  clock.advance(19999);
  assert.strictEqual(calls.length, 0);
  clock.advance(1);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].elapsedMs, 50000);
  assert.strictEqual(calls[0].visibleElapsedMs, 30000);

  // A second hide/reveal cycle does not grant a fresh 30s.
  const calls2 = [];
  const second = new Watchdog((info) => calls2.push(info));
  second.start();
  clock.advance(12000);
  second.setVisible(false);
  clock.advance(5000);
  second.setVisible(true);
  clock.advance(10000);
  second.setVisible(false);
  clock.advance(5000);
  second.setVisible(true);
  clock.advance(7999);
  assert.strictEqual(calls2.length, 0);
  clock.advance(1);
  assert.strictEqual(calls2.length, 1);
  assert.strictEqual(calls2[0].visibleElapsedMs, 30000);
});

test("renderer_ready cancels before start and while hidden; other phases do not", () => {
  const { __companionStartupWatchdog: Watchdog, clock } = loadWatchdog();
  const calls = [];
  const beforeStart = new Watchdog((info) => calls.push(info));
  beforeStart.setVisible(false);
  beforeStart.handleStartupPhase("renderer_ready");
  beforeStart.start();
  beforeStart.setVisible(true);
  clock.advance(60000);
  assert.strictEqual(clock.pending(), 0);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(beforeStart.disposed, true);

  const whileHidden = new Watchdog((info) => calls.push(info));
  whileHidden.setVisible(false);
  whileHidden.start();
  whileHidden.handleStartupPhase("renderer_ready");
  whileHidden.setVisible(true);
  clock.advance(60000);
  assert.strictEqual(clock.pending(), 0);
  assert.strictEqual(calls.length, 0);

  const otherPhase = new Watchdog((info) => calls.push(info));
  otherPhase.start();
  otherPhase.handleStartupPhase("renderer_loading");
  clock.advance(30000);
  assert.strictEqual(calls.length, 1);
});

test("a first message is not readiness", () => {
  const { __companionStartupWatchdog: Watchdog, clock } = loadWatchdog();
  const calls = [];
  const watchdog = new Watchdog((info) => calls.push(info));

  watchdog.start();
  watchdog.markMessageReceived();
  assert.strictEqual(watchdog.disposed, false);
  clock.advance(30000);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].receivedWebviewMessage, true);
});

test("dispose cancels an armed or hidden timer and prevents later resurrection", () => {
  const { __companionStartupWatchdog: Watchdog, clock } = loadWatchdog();
  const calls = [];

  const armed = new Watchdog((info) => calls.push(info));
  armed.start();
  clock.advance(1000);
  armed.dispose();
  assert.strictEqual(clock.pending(), 0);
  armed.setVisible(false);
  armed.setVisible(true);
  clock.advance(60000);
  assert.strictEqual(calls.length, 0);

  const hidden = new Watchdog((info) => calls.push(info));
  hidden.setVisible(false);
  hidden.start();
  hidden.dispose();
  hidden.setVisible(true);
  clock.advance(60000);
  assert.strictEqual(clock.pending(), 0);
  assert.strictEqual(calls.length, 0);
});

test("binder uses panel.visible only, pauses on hide, counts visible inactive time", () => {
  const { __companionStartupWatchdog: Watchdog, __companionBindStartupVisibility: bind, clock } =
    loadWatchdog();
  const calls = [];
  const watchdog = new Watchdog((info) => calls.push(info));
  const panel = makePanel(true);
  const disposable = bind(watchdog, panel);

  assert.strictEqual(panel.listeners.length, 1);
  watchdog.start();
  clock.advance(10000);

  panel.visible = false;
  panel.active = true;
  panel.fire();
  assert.strictEqual(clock.pending(), 0);
  clock.advance(30000);
  assert.strictEqual(calls.length, 0);

  panel.visible = true;
  panel.active = false;
  panel.fire();
  assert.strictEqual(clock.pending(), 1);
  clock.advance(19999);
  assert.strictEqual(calls.length, 0);
  clock.advance(1);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].visibleElapsedMs, 30000);

  disposable.dispose();
  disposable.dispose();
  assert.strictEqual(panel.subscription.disposed, 1);
  panel.fire();
  clock.advance(60000);
  assert.strictEqual(calls.length, 1);
});

test("binder disposes a throwing panel watchdog safely without leaking a timer", () => {
  const { __companionStartupWatchdog: Watchdog, __companionBindStartupVisibility: bind, clock } =
    loadWatchdog();
  const calls = [];
  const watchdog = new Watchdog((info) => calls.push(info));
  const panel = {
    get visible() {
      throw new Error("panel disposed");
    },
  };

  const disposable = bind(watchdog, panel);
  watchdog.start();
  clock.advance(60000);
  assert.strictEqual(disposable, undefined);
  assert.strictEqual(watchdog.disposed, true);
  assert.strictEqual(clock.pending(), 0);
  assert.strictEqual(calls.length, 0);
});

function generatedInitializeWebview() {
  const original = fs.readFileSync(path.join(ORIG_DIR, "out", "extension.js"), "utf8");
  const patched = patcher.generatePatchedText("out/extension.js", original);
  const start = patched.indexOf("async initializeWebview(e,r,n,o){");
  assert.notStrictEqual(start, -1, "generated host must contain initializeWebview");
  const end = patched.indexOf("onPanelReady(e){", start);
  assert.ok(end > start, "initializeWebview must end before onPanelReady");
  return patched.slice(start, end);
}

function makeGeneratedContext(clock, errors, panelLookups) {
  const je = {
    Uri: { joinPath: () => ({}) },
    window: { showErrorMessage: () => {} },
  };
  const factory = new Function(
    "je",
    "Date",
    "setTimeout",
    "clearTimeout",
    WATCHDOG_SOURCE +
      "\nvar ZF=__companionStartupWatchdog;\nreturn ({" +
      generatedInitializeWebview() +
      "});"
  );
  const proto = factory(je, clock.date, clock.setTimeout, clock.clearTimeout);
  const subscriptions = [];
  const context = {
    extensionUri: {},
    extensionVersion: "26.1007.21434",
    logger: { error: (...args) => errors.push(args) },
    chunkedMessageSender: { disposed: 0, dispose() { this.disposed += 1; } },
    workerBusMessageHandler: { registerWebview() {} },
    subscriptions: { push: (...items) => subscriptions.push(...items) },
    registerClientCoordinationForWebview() {},
    findPanelByWebview(webview) {
      panelLookups.push(webview);
      return panelLookups.panel;
    },
    postMessageToWebview() {},
    getChatFontSettings() {
      return { chatFontSize: null, chatCodeFontSize: null };
    },
    getWebviewContent: async () => "<html>ok</html>",
    initializeWebview: proto.initializeWebview,
  };
  return { context, subscriptions };
}

test("generated initializeWebview binds the actual watchdog to the looked-up panel", async () => {
  const clock = makeClock();
  const errors = [];
  const panel = makePanel(false);
  const lookups = [];
  lookups.panel = panel;
  const { context, subscriptions } = makeGeneratedContext(clock, errors, lookups);
  const webview = {
    options: {},
    html: "",
    onDidReceiveMessage: () => ({ dispose() {} }),
  };
  let nativeDispose;

  await context.initializeWebview(webview, "panel", (callback) => {
    nativeDispose = callback;
    return { dispose() {} };
  }, () => {});

  assert.strictEqual(lookups.length, 1);
  assert.strictEqual(lookups[0], webview);
  assert.strictEqual(subscriptions.length, 3, "message + visibility + panel-dispose subscriptions");
  assert.strictEqual(clock.pending(), 0, "hidden restored panel must not arm");

  panel.visible = true;
  panel.fire();
  assert.strictEqual(clock.pending(), 1, "revealed panel resumes the watchdog");

  nativeDispose();
  assert.strictEqual(clock.pending(), 0, "native panel dispose cancels the timer");
  assert.strictEqual(panel.subscription.disposed, 1, "visibility listener disposed");
  clock.advance(60000);
  assert.strictEqual(errors.length, 0);

  // A fresh visible panel still reaches the original timeout behavior.
  const clock2 = makeClock();
  const errors2 = [];
  const panel2 = makePanel(true);
  const lookups2 = [];
  lookups2.panel = panel2;
  const second = makeGeneratedContext(clock2, errors2, lookups2);
  const webview2 = {
    options: {},
    html: "",
    onDidReceiveMessage: () => ({ dispose() {} }),
  };
  await second.context.initializeWebview(webview2, "panel", () => ({ dispose() {} }), () => {});
  assert.strictEqual(clock2.pending(), 1);
  clock2.advance(30000);
  assert.strictEqual(errors2.length, 1);
  assert.match(errors2[0][0], /did not become ready/);
  assert.match(webview2.html, /Codex could not start/);
});

test("generated initializeWebview keeps the default watchdog for non-panel roles", async () => {
  const clock = makeClock();
  const errors = [];
  const lookups = [];
  const { context } = makeGeneratedContext(clock, errors, lookups);
  const webview = {
    options: {},
    html: "",
    onDidReceiveMessage: () => ({ dispose() {} }),
  };

  await context.initializeWebview(webview, "sidebar", () => ({ dispose() {} }), () => {});
  assert.strictEqual(lookups.length, 0, "sidebar must not look up an editor panel");
  assert.strictEqual(clock.pending(), 1);
  clock.advance(30000);
  assert.strictEqual(errors.length, 1);
});
