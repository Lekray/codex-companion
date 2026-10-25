"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const titles = require("../../scripts/patchOfficialTitles.cjs");

const ROOT = path.resolve(__dirname, "..", "..");
const FIXTURE = path.join(ROOT, ".artifacts", "openai-project-history", "original");
const SCRIPT_PATH = path.join(ROOT, "scripts", "patchOfficialTitles.cjs");
const FAKE_ROOT = path.resolve(ROOT, ".artifacts", "tab-title-sync", "unit", "memory");
const FAKE_EXT = path.join(FAKE_ROOT, "extension");
const FAKE_BACKUP = path.join(FAKE_ROOT, "backup");

const materials = titles.buildMaterials(FIXTURE);
const HOST = "out/extension.js";
const C014 = "webview/assets/app-initial-c014f9ee4429.js";

function fixtureText(file) {
  return fs.readFileSync(path.join(FIXTURE, file), "utf8");
}

// ---------------------------------------------------------------------------
// In-memory filesystem for the apply/restore lifecycle.
//
// The sandbox exposes .artifacts/tab-title-sync as a writable file, not a
// directory, so the unit tests must not create fixtures on disk. All fake paths
// are intercepted; reads below FAKE_ROOT never reach the real filesystem.
// ---------------------------------------------------------------------------

function createMemoryFs() {
  const files = new Map();
  const dirs = new Set([FAKE_ROOT]);

  function norm(p) {
    return path.resolve(p);
  }

  function isFake(p) {
    const n = norm(p);
    return n === FAKE_ROOT || n.startsWith(FAKE_ROOT + path.sep);
  }

  function ensureDirs(p) {
    let d = path.dirname(norm(p));
    while (isFake(d)) {
      dirs.add(d);
      if (d === FAKE_ROOT) break;
      d = path.dirname(d);
    }
  }

  function decode(value, encoding) {
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
    return encoding === "utf8" ? buf.toString("utf8") : Buffer.from(buf);
  }

  const memory = {
    files,
    dirs,
    seed(file, data) {
      ensureDirs(file);
      files.set(norm(file), Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(String(data), "utf8"));
    },
    read(file) {
      return files.get(norm(file));
    },
    snapshot() {
      return JSON.stringify(
        [...files.entries()]
          .map(([file, bytes]) => [file, bytes.toString("base64")])
          .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      );
    },
    install() {
      const real = {
        readFileSync: fs.readFileSync,
        existsSync: fs.existsSync,
        writeFileSync: fs.writeFileSync,
        renameSync: fs.renameSync,
        unlinkSync: fs.unlinkSync,
        mkdirSync: fs.mkdirSync,
      };

      fs.existsSync = function (p) {
        if (isFake(p)) {
          const n = norm(p);
          return files.has(n) || dirs.has(n);
        }
        return real.existsSync(p);
      };
      fs.readFileSync = function (p, encoding) {
        if (!isFake(p)) return real.readFileSync(p, encoding);
        const bytes = files.get(norm(p));
        if (bytes === undefined) {
          const e = new Error(`ENOENT: no such file, open '${p}'`);
          e.code = "ENOENT";
          throw e;
        }
        return decode(bytes, encoding);
      };
      fs.writeFileSync = function (p, data) {
        if (!isFake(p)) return real.writeFileSync(p, data);
        ensureDirs(p);
        files.set(norm(p), Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(String(data), "utf8"));
      };
      fs.renameSync = function (from, to) {
        if (!isFake(from) && !isFake(to)) return real.renameSync(from, to);
        if (!isFake(from) || !isFake(to)) throw new Error("cross-filesystem rename is not supported");
        const bytes = files.get(norm(from));
        if (bytes === undefined) {
          const e = new Error(`ENOENT: no such file, rename '${from}'`);
          e.code = "ENOENT";
          throw e;
        }
        ensureDirs(to);
        files.set(norm(to), bytes);
        files.delete(norm(from));
      };
      fs.unlinkSync = function (p) {
        if (!isFake(p)) return real.unlinkSync(p);
        files.delete(norm(p));
      };
      fs.mkdirSync = function (p, options) {
        if (!isFake(p)) return real.mkdirSync(p, options);
        ensureDirs(p);
        dirs.add(norm(p));
      };

      return function uninstall() {
        fs.readFileSync = real.readFileSync;
        fs.existsSync = real.existsSync;
        fs.writeFileSync = real.writeFileSync;
        fs.renameSync = real.renameSync;
        fs.unlinkSync = real.unlinkSync;
        fs.mkdirSync = real.mkdirSync;
      };
    },
  };

  return memory;
}

function withMemoryFs(fn) {
  const memory = createMemoryFs();
  const uninstall = memory.install();
  try {
    return fn(memory);
  } finally {
    uninstall();
  }
}

function seedPackage(memory, text) {
  memory.seed(path.join(FAKE_EXT, "package.json"), text);
}

function seedState(memory, state) {
  seedPackage(memory, fixtureText("package.json"));
  for (const file of titles.PATCHED_FILES) {
    const text =
      state === "baseline"
        ? materials.baselineTexts[file]
        : state === "patched"
          ? materials.titleTexts[file]
          : materials.fixture.texts[file];
    memory.seed(path.join(FAKE_EXT, file), text);
  }
}

function hashOfMemoryFile(memory, file) {
  const bytes = memory.read(path.join(FAKE_EXT, file));
  return bytes === undefined ? null : titles.sha256(bytes);
}

// ---------------------------------------------------------------------------
// Host glue with fake editor panels (native + custom editor alike).
// ---------------------------------------------------------------------------

function evaluateHostHelpers() {
  const baseline = materials.baselineTexts[HOST];
  const start = baseline.indexOf("function TKe(");
  assert.notStrictEqual(start, -1, "baseline must contain TKe");
  const end = baseline.indexOf("}", start);
  assert.notStrictEqual(end, -1, "baseline TKe must be closed");
  const tke = baseline.slice(start, end + 1);
  const factory = new Function(
    'const AKe=30,RKe="Codex";\n' +
      tke +
      "\n" +
      titles.loadTitleCoreSource() +
      "\n" +
      titles.TITLE_HOST_GLUE +
      "\nreturn {__companionTabTitlePayload,__companionApplyCompanionTabTitle,__companionShouldApplyPreviewTitle};"
  );
  return factory();
}

function makeFakeProvider() {
  const editorPanels = new Map();
  const webviews = new Map();
  return {
    editorPanels,
    findPanelByWebview(webview) {
      for (const [panel, candidate] of webviews) {
        if (candidate === webview) return panel;
        if (candidate && webview && candidate.id !== undefined && candidate.id === webview.id) return panel;
      }
      return undefined;
    },
    isPanelAlive(panel) {
      return editorPanels.has(panel) && webviews.has(panel);
    },
    add(panel, webview) {
      editorPanels.set(panel, { ready: true, pendingMessages: [], initialRoute: undefined });
      webviews.set(panel, webview);
      return panel;
    },
  };
}

function report(threadId, title, route, routeThreadId) {
  return {
    type: "companion-tab-title",
    threadId,
    hostId: "local",
    title,
    route,
    routeThreadId: routeThreadId === undefined ? null : routeThreadId,
  };
}

function reset(route) {
  return { type: "companion-tab-title", threadId: null, hostId: null, title: null, route: route || "/welcome", reset: true };
}

// ---------------------------------------------------------------------------
// Generated seams
// ---------------------------------------------------------------------------

test("generated host has the unique message case, live title handler and preview guard", () => {
  const patched = materials.titleTexts[HOST];
  assert.ok(
    patched.includes(
      'case"companion-tab-title":{__companionApplyCompanionTabTitle(this,e,r);break}case"view-focused":{this.setFocusedViewForWebview(e);break}'
    )
  );
  assert.ok(patched.includes("this.isPanelAlive(r)&&__companionShouldApplyPreviewTitle(this,r)&&(r.title=TKe(l))"));
  assert.strictEqual(patched.split('case"companion-tab-title"').length - 1, 1);
  assert.ok(patched.includes("function __companionTabTitlePayload"));
  assert.ok(patched.includes("function __companionApplyCompanionTabTitle"));
  assert.ok(patched.includes("function __companionShouldApplyPreviewTitle"));
  // Prior fixes survive.
  for (const marker of [
    "__companionStartupWatchdog",
    "__companionHistoryRoots",
    "__companionFilterHistoryResult",
    "companion-history-scope-changed",
  ]) {
    assert.ok(patched.includes(marker), `generated host lost ${marker}`);
  }
});

test("generated c014 reports the reactive atom title from the router seam", () => {
  const patched = materials.titleTexts[C014];
  assert.ok(patched.includes("T=e[9];aM();let __companionTabTitle=J(h0t,T),__companionTabHost=J(nc,T)"));
  assert.ok(patched.includes('vm.dispatchMessage("companion-tab-title"'));
  assert.ok(patched.includes("(0,b3i.useEffect)(()=>{try{"));
  assert.ok(patched.includes("reset:__companionTabText==null"));
  assert.strictEqual(patched.split("companion-tab-title").length - 1, 1);
  assert.ok(patched.includes("companion-history-scope-changed"));
  assert.ok(patched.includes("__companionBrowserSetScopeFromMessage"));
  // The compiler cache indexes around the seam are untouched.
  assert.ok(patched.includes("e[10]!==T||e[11]!==C||e[12]!==m||e[13]!==E"));
});

test("c014 effect sends a valid local payload and explicit resets", () => {
  function run({ T = null, x = null, route = "/welcome", title = null, host = "local" }) {
    const calls = [];
    let deps = null;
    let atomInitCount = 0;
    const TITLE_ATOM = Symbol("title");
    const HOST_ATOM = Symbol("host");
    const code =
      titles.C014_SEAM_REPLACEMENT.replace("let E=y?.params.taskId", "") +
      ";return {text:__companionTabText,local:__companionTabLocal,host:__companionTabHost,path:__companionTabPath};";
    const cache = [];
    cache[9] = T;
    const fn = new Function("e", "T", "x", "r", "aM", "J", "h0t", "nc", "b3i", "vm", code);
    const result = fn(
      cache,
      T,
      x,
      { pathname: route },
      () => {
        atomInitCount += 1;
      },
      (atom) => {
        if (atom === TITLE_ATOM) return title;
        if (atom === HOST_ATOM) return host;
        return undefined;
      },
      TITLE_ATOM,
      HOST_ATOM,
      {
        useEffect(callback, dependencies) {
          deps = dependencies;
          callback();
        },
      },
      {
        dispatchMessage(type, payload) {
          calls.push({ type, payload });
        },
      }
    );
    return { calls, deps, result, atomInitCount };
  }

  let r = run({ T: "t1", x: "client-1", route: "/local/t1", title: " Alpha " });
  assert.strictEqual(r.atomInitCount, 1);
  assert.deepStrictEqual(r.calls, [
    {
      type: "companion-tab-title",
      payload: {
        threadId: "t1",
        hostId: "local",
        title: " Alpha ",
        route: "/local/t1",
        routeThreadId: "client-1",
        reset: false,
      },
    },
  ]);
  assert.deepStrictEqual(r.deps, [" Alpha ", "t1", "local", "/local/t1", "client-1"]);

  // New chat route still carries the client id while the atom resolves the saved id.
  r = run({ T: "saved-2", x: "client-2", route: "/local/client-2", title: "Beta" });
  assert.strictEqual(r.calls[0].payload.threadId, "saved-2");
  assert.strictEqual(r.calls[0].payload.routeThreadId, "client-2");
  assert.strictEqual(r.calls[0].payload.reset, false);

  for (const args of [
    { T: null, route: "/", title: "Old" },
    { T: null, route: "/remote/r1", title: "Remote" },
    { T: "t1", route: "/local/t1", title: "Alpha", host: "cloud" },
    { T: "t1", route: "/settings", title: "Alpha" },
    { T: "t1", route: "/local/t1", title: "   " },
    { T: "t1", route: "/local/t1", title: null },
  ]) {
    r = run(args);
    assert.strictEqual(r.calls.length, 1);
    assert.strictEqual(r.calls[0].type, "companion-tab-title");
    assert.strictEqual(r.calls[0].payload.reset, true);
    assert.strictEqual(r.calls[0].payload.threadId, null);
    assert.strictEqual(r.calls[0].payload.title, null);
  }
});

test("title patch is deterministic and only changes the two expected seams", () => {
  for (const file of titles.PATCHED_FILES) {
    const again = titles.generatePatchedText(file, materials.baselineTexts[file]);
    assert.strictEqual(titles.sha256(again), materials.titleHashes[file], `${file}: non-deterministic`);
  }

  // Reverse the c014 insertion and get the accepted history baseline byte-for-byte.
  const c014 = materials.titleTexts[C014];
  const revertedC014 = c014.replace(titles.C014_SEAM_REPLACEMENT, titles.C014_SEAM);
  assert.strictEqual(revertedC014, materials.baselineTexts[C014]);

  // Reverse the three host edits and get the accepted history/watchdog baseline.
  let revertedHost = materials.titleTexts[HOST];
  revertedHost = revertedHost.replace(
    'case"companion-tab-title":{__companionApplyCompanionTabTitle(this,e,r);break}case"view-focused":{this.setFocusedViewForWebview(e);break}',
    'case"view-focused":{this.setFocusedViewForWebview(e);break}'
  );
  revertedHost = revertedHost.replace(
    "this.isPanelAlive(r)&&__companionShouldApplyPreviewTitle(this,r)&&(r.title=TKe(l))",
    "this.isPanelAlive(r)&&(r.title=TKe(l))"
  );
  revertedHost = revertedHost.replace(
    'function TKe(t){return t?t.length>AKe?t.substring(0,AKe)+"\\u2026":t:RKe}' +
      "\n" +
      titles.loadTitleCoreSource() +
      "\n" +
      titles.TITLE_HOST_GLUE,
    'function TKe(t){return t?t.length>AKe?t.substring(0,AKe)+"\\u2026":t:RKe}'
  );
  assert.strictEqual(revertedHost, materials.baselineTexts[HOST]);
});

test("generatePatchedText refuses original bytes and already patched bytes", () => {
  for (const file of titles.PATCHED_FILES) {
    assert.throws(
      () => titles.generatePatchedText(file, materials.fixture.texts[file]),
      /baseline is missing/
    );
    assert.throws(
      () => titles.generatePatchedText(file, materials.titleTexts[file]),
      /already present/
    );
  }
  assert.throws(() => titles.generatePatchedText("package.json", "{}"), /not a patched file/);
});

test("transformed host and webview parse as CJS and ESM", () => {
  execFileSync(process.execPath, ["--check"], {
    input: materials.titleTexts[HOST],
    stdio: ["pipe", "pipe", "pipe"],
  });
  execFileSync(process.execPath, ["--input-type=module", "--check"], {
    input: materials.titleTexts[C014],
    stdio: ["pipe", "pipe", "pipe"],
  });
});

// ---------------------------------------------------------------------------
// Host handler behavior
// ---------------------------------------------------------------------------

test("host handler: primary and custom panels update immediately; unrelated panels stay untouched", () => {
  const h = evaluateHostHelpers();
  const p = makeFakeProvider();
  const primary = p.add({ title: "Codex" }, { id: "primary" });
  const custom = p.add({ title: "Old preview" }, { id: "custom" });
  const specialized = p.add({ title: "Diff" }, { id: "diff" });
  p.diffPanel = { currentPanel: specialized };

  assert.strictEqual(h.__companionApplyCompanionTabTitle(p, { id: "primary" }, report("t1", "Alpha", "/local/t1")), true);
  assert.strictEqual(primary.title, "Alpha");
  assert.strictEqual(custom.title, "Old preview");
  assert.strictEqual(specialized.title, "Diff");

  assert.strictEqual(h.__companionApplyCompanionTabTitle(p, { id: "custom" }, report("t2", "Beta", "/local/t2")), true);
  assert.strictEqual(custom.title, "Beta");
  assert.strictEqual(primary.title, "Alpha");
  assert.strictEqual(specialized.title, "Diff");

  // The route may still carry the client id while the store has resolved the saved id.
  assert.strictEqual(
    h.__companionApplyCompanionTabTitle(p, { id: "custom" }, report("saved-3", "Gamma", "/local/client-3", "client-3")),
    true
  );
  assert.strictEqual(custom.title, "Gamma");

  // An unknown webview (e.g. the sidebar) is ignored and cannot rename anything.
  assert.strictEqual(h.__companionApplyCompanionTabTitle(p, { id: "sidebar" }, report("t4", "Nope", "/local/t4")), false);
  assert.strictEqual(primary.title, "Alpha");
  assert.strictEqual(custom.title, "Gamma");
  assert.strictEqual(specialized.title, "Diff");

  // Even a local-looking report cannot retitle the tracked diff panel.
  assert.strictEqual(
    h.__companionApplyCompanionTabTitle(p, { id: "diff" }, report("t5", "Not a chat", "/local/t5")),
    false
  );
  assert.strictEqual(specialized.title, "Diff");
});

test("host handler: home/nonlocal resets only panels that reported a chat title", () => {
  const h = evaluateHostHelpers();
  const p = makeFakeProvider();
  const a = p.add({ title: "Codex" }, { id: "a" });
  const b = p.add({ title: "Codex" }, { id: "b" });
  const specialized = p.add({ title: "Settings" }, { id: "settings" });

  h.__companionApplyCompanionTabTitle(p, { id: "a" }, report("t1", "Alpha", "/local/t1"));
  assert.strictEqual(a.title, "Alpha");

  assert.strictEqual(h.__companionApplyCompanionTabTitle(p, { id: "a" }, reset("/welcome")), true);
  assert.strictEqual(a.title, "Codex");

  // A panel that never reported keeps its native/specialized title on reset.
  assert.strictEqual(h.__companionApplyCompanionTabTitle(p, { id: "settings" }, reset("/settings")), false);
  assert.strictEqual(specialized.title, "Settings");

  // Remote title reports never rename a local editor panel.
  assert.strictEqual(
    h.__companionApplyCompanionTabTitle(
      p,
      { id: "settings" },
      { type: "companion-tab-title", threadId: "r1", hostId: "remote", title: "Remote", route: "/remote/r1" }
    ),
    false
  );
  assert.strictEqual(specialized.title, "Settings");

  // A stale report from a different local route resets the previous chat title.
  h.__companionApplyCompanionTabTitle(p, { id: "b" }, report("t2", "Beta", "/local/t2"));
  assert.strictEqual(b.title, "Beta");
  assert.strictEqual(
    h.__companionApplyCompanionTabTitle(p, { id: "b" }, report("t2", "Wrong", "/local/other")),
    true
  );
  assert.strictEqual(b.title, "Codex");
});

test("host handler: chat switching and restored state use the reactive value", () => {
  const h = evaluateHostHelpers();
  const p = makeFakeProvider();
  const panel = p.add({ title: "Codex" }, { id: "panel" });

  h.__companionApplyCompanionTabTitle(p, { id: "panel" }, report("t1", "First", "/local/t1"));
  assert.strictEqual(panel.title, "First");
  h.__companionApplyCompanionTabTitle(p, { id: "panel" }, report("t2", "Second", "/local/t2"));
  assert.strictEqual(panel.title, "Second");
  const record = p.editorPanels.get(panel);
  assert.strictEqual(record.__companionTitleThreadId, "t2");
  assert.strictEqual(record.__companionTitleActive, true);
  assert.strictEqual(record.__companionTitleSeen, true);

  // Same value repeatedly is still a safe no-op update.
  assert.strictEqual(h.__companionApplyCompanionTabTitle(p, { id: "panel" }, report("t2", "Second", "/local/t2")), true);
  assert.strictEqual(panel.title, "Second");

  // Home then restored/switch report.
  h.__companionApplyCompanionTabTitle(p, { id: "panel" }, reset("/"));
  assert.strictEqual(panel.title, "Codex");
  assert.strictEqual(record.__companionTitleActive, false);
  assert.strictEqual(record.__companionTitleSeen, true);
  h.__companionApplyCompanionTabTitle(p, { id: "panel" }, report("t3", "Restored", "/local/t3"));
  assert.strictEqual(panel.title, "Restored");
  assert.strictEqual(record.__companionTitleThreadId, "t3");
});

test("host handler: stale async preview cannot overwrite a live title report", () => {
  const h = evaluateHostHelpers();
  const p = makeFakeProvider();
  const reported = p.add({ title: "Codex" }, { id: "reported" });
  const fresh = p.add({ title: "Codex" }, { id: "fresh" });

  assert.strictEqual(h.__companionShouldApplyPreviewTitle(p, fresh), true);
  h.__companionApplyCompanionTabTitle(p, { id: "reported" }, report("t1", "Live", "/local/t1"));
  assert.strictEqual(h.__companionShouldApplyPreviewTitle(p, reported), false);
  assert.strictEqual(h.__companionShouldApplyPreviewTitle(p, fresh), true);

  // The "seen" flag is deliberately permanent: a late preview must not overwrite
  // the native fallback either after the panel navigates home.
  h.__companionApplyCompanionTabTitle(p, { id: "reported" }, reset("/welcome"));
  assert.strictEqual(reported.title, "Codex");
  assert.strictEqual(h.__companionShouldApplyPreviewTitle(p, reported), false);
});

test("host handler: malformed payloads and long titles are handled safely", () => {
  const h = evaluateHostHelpers();
  const p = makeFakeProvider();
  const panel = p.add({ title: "Keep" }, { id: "panel" });
  const bad = [
    null,
    {},
    { threadId: "t1", hostId: "local", title: "X", route: "/settings" },
    { threadId: "t1", hostId: "cloud", title: "X", route: "/local/t1" },
    { threadId: "t1", hostId: "local", title: "   ", route: "/local/t1" },
    { threadId: "t1", hostId: "local", title: "X", route: "/local/other" },
    { threadId: 123, hostId: "local", title: "X", route: "/local/123" },
    { threadId: "t1", hostId: "local", title: "X", route: "/local/t1", reset: true },
  ];
  for (const message of bad) {
    assert.strictEqual(h.__companionApplyCompanionTabTitle(p, { id: "panel" }, message), false);
    assert.strictEqual(panel.title, "Keep");
  }

  h.__companionApplyCompanionTabTitle(p, { id: "panel" }, report("t1", "x".repeat(40), "/local/t1"));
  assert.strictEqual(panel.title, "x".repeat(30) + "\u2026");

  // Once reported, a malformed/local-mismatch report is treated as a reset.
  assert.strictEqual(h.__companionApplyCompanionTabTitle(p, { id: "panel" }, bad[3]), true);
  assert.strictEqual(panel.title, "Codex");
});

// ---------------------------------------------------------------------------
// Lifecycle: check / apply / restore / refusal / rollback
// ---------------------------------------------------------------------------

test("check reports original/baseline/patched/foreign without writing", () => {
  withMemoryFs((memory) => {
    seedState(memory, "original");
    let before = memory.snapshot();
    let result = titles.checkPatch({ extDir: FAKE_EXT, originalDir: FIXTURE });
    assert.strictEqual(result.status, "original");
    assert.strictEqual(result.files[HOST], "original");
    assert.strictEqual(result.detail.plan[HOST].status, "original");
    assert.strictEqual(memory.snapshot(), before);
    assert.strictEqual(fs.existsSync(FAKE_BACKUP), false);

    seedState(memory, "baseline");
    before = memory.snapshot();
    result = titles.checkPatch({ extDir: FAKE_EXT, originalDir: FIXTURE });
    assert.strictEqual(result.status, "baseline");
    assert.strictEqual(result.files[HOST], "baseline");
    assert.strictEqual(result.detail.plan[HOST].currentSha, materials.baselineHashes[HOST]);
    assert.strictEqual(memory.snapshot(), before);
    assert.strictEqual(fs.existsSync(FAKE_BACKUP), false);

    seedState(memory, "patched");
    result = titles.checkPatch({ extDir: FAKE_EXT, originalDir: FIXTURE });
    assert.strictEqual(result.status, "patched");
    assert.strictEqual(result.files[C014], "patched");

    memory.seed(path.join(FAKE_EXT, C014), "foreign bytes");
    result = titles.checkPatch({ extDir: FAKE_EXT, originalDir: FIXTURE });
    assert.strictEqual(result.status, "foreign");
    assert.strictEqual(result.files[C014], "foreign");
  });
});

test("apply/restore are byte-preserving and idempotent on both sides", () => {
  withMemoryFs((memory) => {
    seedState(memory, "baseline");
    const baselineHost = memory.read(path.join(FAKE_EXT, HOST));
    const baselineC014 = memory.read(path.join(FAKE_EXT, C014));

    const applied = titles.applyPatch({ extDir: FAKE_EXT, backupDir: FAKE_BACKUP, originalDir: FIXTURE });
    assert.deepStrictEqual(applied.applied, titles.PATCHED_FILES);
    for (const file of titles.PATCHED_FILES) assert.strictEqual(applied.files[file], "patched");
    assert.strictEqual(hashOfMemoryFile(memory, HOST), materials.titleHashes[HOST]);
    assert.strictEqual(hashOfMemoryFile(memory, C014), materials.titleHashes[C014]);
    assert.deepStrictEqual(memory.read(titles.backupFilePath(FAKE_BACKUP, HOST)), baselineHost);
    assert.deepStrictEqual(memory.read(titles.backupFilePath(FAKE_BACKUP, C014)), baselineC014);
    assert.ok(memory.read(path.join(FAKE_BACKUP, "manifest.json")) !== undefined);

    const patchedSnapshot = memory.snapshot();
    const appliedAgain = titles.applyPatch({ extDir: FAKE_EXT, backupDir: FAKE_BACKUP, originalDir: FIXTURE });
    assert.deepStrictEqual(appliedAgain.applied, []);
    assert.strictEqual(memory.snapshot(), patchedSnapshot);

    const restored = titles.restorePatch({ extDir: FAKE_EXT, backupDir: FAKE_BACKUP, originalDir: FIXTURE });
    assert.deepStrictEqual(restored.restored, titles.PATCHED_FILES);
    assert.strictEqual(hashOfMemoryFile(memory, HOST), materials.baselineHashes[HOST]);
    assert.strictEqual(hashOfMemoryFile(memory, C014), materials.baselineHashes[C014]);
    assert.deepStrictEqual(memory.read(path.join(FAKE_EXT, HOST)), baselineHost);
    assert.deepStrictEqual(memory.read(path.join(FAKE_EXT, C014)), baselineC014);

    const baselineSnapshot = memory.snapshot();
    const restoredAgain = titles.restorePatch({ extDir: FAKE_EXT, backupDir: FAKE_BACKUP, originalDir: FIXTURE });
    assert.deepStrictEqual(restoredAgain.restored, []);
    assert.strictEqual(memory.snapshot(), baselineSnapshot);
  });
});

test("apply refuses original/foreign/package-mismatch state before any write", () => {
  withMemoryFs((memory) => {
    seedState(memory, "original");
    let before = memory.snapshot();
    assert.throws(
      () => titles.applyPatch({ extDir: FAKE_EXT, backupDir: FAKE_BACKUP, originalDir: FIXTURE }),
      /not in the accepted pre-title baseline \(original\)/
    );
    assert.strictEqual(memory.snapshot(), before);
    assert.strictEqual(fs.existsSync(FAKE_BACKUP), false);

    seedState(memory, "baseline");
    memory.seed(path.join(FAKE_EXT, C014), "foreign bytes");
    before = memory.snapshot();
    assert.throws(
      () => titles.applyPatch({ extDir: FAKE_EXT, backupDir: FAKE_BACKUP, originalDir: FIXTURE }),
      /not in the accepted pre-title baseline \(foreign\)/
    );
    assert.strictEqual(memory.snapshot(), before, "preflight must not partially patch the host");
    assert.strictEqual(fs.existsSync(FAKE_BACKUP), false);

    seedState(memory, "baseline");
    const pkg = JSON.parse(fixtureText("package.json"));
    pkg.description = `${pkg.description || ""} harmless test change`;
    memory.seed(path.join(FAKE_EXT, "package.json"), JSON.stringify(pkg, null, 2));
    before = memory.snapshot();
    assert.throws(
      () => titles.applyPatch({ extDir: FAKE_EXT, backupDir: FAKE_BACKUP, originalDir: FIXTURE }),
      /package\.json does not match the supported original hash/
    );
    assert.strictEqual(memory.snapshot(), before);
    assert.strictEqual(fs.existsSync(FAKE_BACKUP), false);
  });
});

test("restore refuses foreign current bytes and corrupt backups before any write", () => {
  withMemoryFs((memory) => {
    seedState(memory, "baseline");
    titles.applyPatch({ extDir: FAKE_EXT, backupDir: FAKE_BACKUP, originalDir: FIXTURE });

    memory.seed(path.join(FAKE_EXT, HOST), "foreign bytes");
    assert.throws(
      () => titles.restorePatch({ extDir: FAKE_EXT, backupDir: FAKE_BACKUP, originalDir: FIXTURE }),
      /neither pre-title baseline nor title-patched/
    );
    assert.strictEqual(hashOfMemoryFile(memory, HOST), titles.sha256("foreign bytes"));
    assert.strictEqual(hashOfMemoryFile(memory, C014), materials.titleHashes[C014]);

    seedState(memory, "baseline");
    titles.applyPatch({ extDir: FAKE_EXT, backupDir: FAKE_BACKUP, originalDir: FIXTURE });
    memory.seed(titles.backupFilePath(FAKE_BACKUP, C014), "corrupted");
    assert.throws(
      () => titles.restorePatch({ extDir: FAKE_EXT, backupDir: FAKE_BACKUP, originalDir: FIXTURE }),
      /pre-title backup bytes do not match/
    );
    // The preflight refuses before writing either file; host stays patched.
    assert.strictEqual(hashOfMemoryFile(memory, HOST), materials.titleHashes[HOST]);
    assert.strictEqual(hashOfMemoryFile(memory, C014), materials.titleHashes[C014]);
  });
});

test("apply rolls back an already-written file and preserves the history baseline", () => {
  withMemoryFs((memory) => {
    seedState(memory, "baseline");
    const baselineHost = memory.read(path.join(FAKE_EXT, HOST));
    const baselineC014 = memory.read(path.join(FAKE_EXT, C014));
    const target = path.join(FAKE_EXT, C014);
    const shimRename = fs.renameSync;
    let injected = false;
    fs.renameSync = function (from, to) {
      if (!injected && path.resolve(to) === path.resolve(target)) {
        injected = true;
        const e = new Error("injected rename failure");
        e.code = "EIO";
        throw e;
      }
      return shimRename(from, to);
    };
    try {
      assert.throws(
        () => titles.applyPatch({ extDir: FAKE_EXT, backupDir: FAKE_BACKUP, originalDir: FIXTURE }),
        /apply failed/
      );
    } finally {
      fs.renameSync = shimRename;
    }
    assert.deepStrictEqual(memory.read(path.join(FAKE_EXT, HOST)), baselineHost);
    assert.deepStrictEqual(memory.read(path.join(FAKE_EXT, C014)), baselineC014);
    assert.deepStrictEqual(memory.read(titles.backupFilePath(FAKE_BACKUP, HOST)), baselineHost);
    assert.deepStrictEqual(memory.read(titles.backupFilePath(FAKE_BACKUP, C014)), baselineC014);
  });
});

test("restore rolls back already-restored files to the title-patched bytes", () => {
  withMemoryFs((memory) => {
    seedState(memory, "baseline");
    titles.applyPatch({ extDir: FAKE_EXT, backupDir: FAKE_BACKUP, originalDir: FIXTURE });
    const patchedHost = memory.read(path.join(FAKE_EXT, HOST));
    const patchedC014 = memory.read(path.join(FAKE_EXT, C014));
    const target = path.join(FAKE_EXT, C014);
    const shimRename = fs.renameSync;
    let injected = false;
    fs.renameSync = function (from, to) {
      if (!injected && path.resolve(to) === path.resolve(target)) {
        injected = true;
        const e = new Error("injected restore rename failure");
        e.code = "EIO";
        throw e;
      }
      return shimRename(from, to);
    };
    try {
      assert.throws(
        () => titles.restorePatch({ extDir: FAKE_EXT, backupDir: FAKE_BACKUP, originalDir: FIXTURE }),
        /restore failed/
      );
    } finally {
      fs.renameSync = shimRename;
    }
    assert.deepStrictEqual(memory.read(path.join(FAKE_EXT, HOST)), patchedHost);
    assert.deepStrictEqual(memory.read(path.join(FAKE_EXT, C014)), patchedC014);
  });
});

test("CLI check on the verified original fixture is read-only and exits non-zero", () => {
  const cli = spawnSync(
    process.execPath,
    [
      SCRIPT_PATH,
      "check",
      "--extension",
      FIXTURE,
      "--backup",
      path.join(FAKE_ROOT, "unused-backup"),
      "--original-dir",
      FIXTURE,
    ],
    { encoding: "utf8" }
  );
  assert.strictEqual(cli.status, 1, cli.stderr);
  const result = JSON.parse(cli.stdout);
  assert.strictEqual(result.status, "original");
  assert.strictEqual(result.files[HOST], "original");
  assert.strictEqual(result.files[C014], "original");
});
