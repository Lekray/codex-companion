"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const patcher = require("../../scripts/patchOfficialHistory.cjs");

const ROOT = path.resolve(__dirname, "..", "..");
const ORIG_DIR = path.join(ROOT, ".artifacts", "openai-project-history", "original");
const MANIFEST_PATH = path.join(ROOT, ".artifacts", "openai-project-history", "original-manifest.json");
const MANIFEST = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const SCRIPT_PATH = path.join(ROOT, "scripts", "patchOfficialHistory.cjs");
const SCRATCH = path.join(ROOT, ".artifacts", "openai-project-history", "unit");

function makeTempExt() {
  const dir = path.join(SCRATCH, "ext-" + process.pid + "-" + Math.random().toString(16).slice(2));
  for (const file of ["package.json", ...patcher.PATCHED_FILES]) {
    const src = path.join(ORIG_DIR, file);
    const dest = path.join(dir, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  return dir;
}

function makeTempBackup() {
  const dir = path.join(SCRATCH, "backup-" + process.pid + "-" + Math.random().toString(16).slice(2));
  return dir;
}

function bytes(file) {
  return fs.readFileSync(file);
}

function runCheckCli(extDir, backupDir) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [
        SCRIPT_PATH,
        "check",
        "--extension",
        extDir,
        "--backup",
        backupDir,
        "--manifest",
        MANIFEST_PATH,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    return { code: 0, result: JSON.parse(stdout) };
  } catch (e) {
    return { code: typeof e.status === "number" ? e.status : 1, result: JSON.parse(e.stdout || "{}") };
  }
}

// ---------------------------------------------------------------------------
// Path normalization and matching (pure core)
// ---------------------------------------------------------------------------

test("norm: null/empty/relative/drive-relative rejected", () => {
  const c = patcher.evaluateCore();
  assert.strictEqual(c.__companionNormPath(null), null);
  assert.strictEqual(c.__companionNormPath(undefined), null);
  assert.strictEqual(c.__companionNormPath(""), null);
  assert.strictEqual(c.__companionNormPath("foo/bar"), null);
  assert.strictEqual(c.__companionNormPath("./foo"), null);
  assert.strictEqual(c.__companionNormPath("C:foo"), null); // drive-relative
});

test("norm: windows drive slash/case/trailing slash", () => {
  const c = patcher.evaluateCore();
  assert.strictEqual(c.__companionNormPath("C:\\Foo\\Bar"), "c:/foo/bar");
  assert.strictEqual(c.__companionNormPath("c:/foo/bar"), "c:/foo/bar");
  assert.strictEqual(c.__companionNormPath("C:/foo/"), "c:/foo");
  assert.strictEqual(c.__companionNormPath("C:\\"), "c:/");
  assert.strictEqual(c.__companionNormPath("c:/"), "c:/");
});

test("norm: dot segments resolved lexically", () => {
  const c = patcher.evaluateCore();
  assert.strictEqual(c.__companionNormPath("C:/foo/../bar"), "c:/bar");
  assert.strictEqual(c.__companionNormPath("C:/foo/./bar"), "c:/foo/bar");
  assert.strictEqual(c.__companionNormPath("/a/../../b"), "/b");
  assert.strictEqual(c.__companionNormPath("C:/a/b/../../c"), "c:/c");
});

test("norm: UNC and extended \\\\?\\ prefixes", () => {
  const c = patcher.evaluateCore();
  assert.strictEqual(c.__companionNormPath("\\\\server\\share"), "//server/share");
  assert.strictEqual(c.__companionNormPath("//server/share/"), "//server/share");
  assert.strictEqual(c.__companionNormPath("\\\\?\\C:\\foo\\bar"), "c:/foo/bar");
  assert.strictEqual(c.__companionNormPath("\\\\?\\UNC\\server\\share\\x"), "//server/share/x");
});

test("norm: POSIX/WSL paths are case-sensitive", () => {
  const c = patcher.evaluateCore();
  assert.strictEqual(c.__companionNormPath("/Home/User"), "/Home/User");
  assert.strictEqual(c.__companionNormPath("/home/user"), "/home/user");
  assert.notStrictEqual(c.__companionNormPath("/Home/User"), c.__companionNormPath("/home/user"));
});

test("match: root == cwd or nested after separator, no sibling prefix", () => {
  const c = patcher.evaluateCore();
  // sibling prefix rejection
  assert.strictEqual(c.__companionCwdMatchesRoots("C:/foo-extra", ["C:/foo"]), false);
  assert.strictEqual(c.__companionCwdMatchesRoots("C:/foobar", ["C:/foo"]), false);
  // nested and exact
  assert.strictEqual(c.__companionCwdMatchesRoots("C:/foo", ["C:/foo"]), true);
  assert.strictEqual(c.__companionCwdMatchesRoots("C:/foo/bar/baz", ["C:/foo"]), true);
  // case + slashes
  assert.strictEqual(c.__companionCwdMatchesRoots("c:/FOO/bar", ["C:\\foo"]), true);
  // drive root contains everything on the drive
  assert.strictEqual(c.__companionCwdMatchesRoots("C:/foobar", ["C:/"]), true);
  // UNC
  assert.strictEqual(c.__companionCwdMatchesRoots("\\\\server\\share\\proj\\x", ["\\\\server\\share"]), true);
  assert.strictEqual(c.__companionCwdMatchesRoots("\\\\server\\share2\\x", ["\\\\server\\share"]), false);
  // POSIX case-sensitive
  assert.strictEqual(c.__companionCwdMatchesRoots("/home/user/x", ["/home/user"]), true);
  assert.strictEqual(c.__companionCwdMatchesRoots("/home/user/x", ["/Home/User"]), false);
  // no roots / no match
  assert.strictEqual(c.__companionCwdMatchesRoots("C:/x", []), false);
  assert.strictEqual(c.__companionCwdMatchesRoots(null, ["C:/x"]), false);
  assert.strictEqual(c.__companionCwdMatchesRoots("C:rel", ["C:/x"]), false);
});

test("match: multi-root union", () => {
  const c = patcher.evaluateCore();
  const roots = ["C:/ws", "D:/other"];
  assert.strictEqual(c.__companionCwdMatchesRoots("C:/ws/a", roots), true);
  assert.strictEqual(c.__companionCwdMatchesRoots("D:/other/b", roots), true);
  assert.strictEqual(c.__companionCwdMatchesRoots("E:/elsewhere", roots), false);
});

test("filter rows: list direct rows and search {thread,snippet} rows", () => {
  const c = patcher.evaluateCore();
  const list = [
    { id: "a", cwd: "C:/ws" },
    { id: "b", cwd: "C:/ws/nested" },
    { id: "c", cwd: "C:/ws-extra" },
    { id: "d", cwd: "D:/other" },
    { id: "e", cwd: null },
  ];
  assert.deepStrictEqual(
    c.__companionFilterRows(list, ["C:/ws"]).map((r) => r.id),
    ["a", "b"]
  );
  const search = [
    { thread: { id: "a", cwd: "C:/ws" }, snippet: "s1" },
    { thread: { id: "c", cwd: "C:/ws-extra" }, snippet: "s2" },
    { thread: { id: "e", cwd: null }, snippet: "s3" },
  ];
  assert.deepStrictEqual(
    c.__companionFilterRows(search, ["C:/ws"]).map((r) => r.thread.id),
    ["a"]
  );
  // no roots => fail closed
  assert.deepStrictEqual(c.__companionFilterRows(list, []), []);
  // null roots => no scoping (pass-through)
  assert.deepStrictEqual(c.__companionFilterRows(list, null), list);
});

// ---------------------------------------------------------------------------
// Host glue (list/search filtering + scope metadata) evaluated in a sandbox
// ---------------------------------------------------------------------------

function evaluateHostGlue(crFn) {
  const factory = new Function(
    "cR",
    patcher.loadCoreSource() +
      patcher.HOST_GLUE +
      "\nreturn { __companionFilterHistoryResult: __companionFilterHistoryResult, __companionIsHistoryMethod: __companionIsHistoryMethod, __companionHistoryRoots: __companionHistoryRoots };"
  );
  return factory(crFn);
}

test("host filter: preserves metadata/cursor/errors and attaches scope", () => {
  const h = evaluateHostGlue(() => ["C:/ws"]);
  const listResult = {
    data: [
      { id: "a", cwd: "C:/ws" },
      { id: "c", cwd: "C:/other" },
    ],
    nextCursor: "cursor-1",
    someField: "keep",
  };
  const out = h.__companionFilterHistoryResult("thread/list", listResult);
  assert.deepStrictEqual(out.data, [{ id: "a", cwd: "C:/ws" }]);
  assert.strictEqual(out.nextCursor, "cursor-1");
  assert.strictEqual(out.someField, "keep");
  assert.deepStrictEqual(out.__companionScope.roots, ["C:/ws"]);
  assert.deepStrictEqual(out.__companionScope.normalized, ["c:/ws"]);
  // original untouched
  assert.strictEqual(listResult.data.length, 2);

  // search rows preserved
  const searchResult = {
    data: [
      { thread: { id: "a", cwd: "C:/ws" }, snippet: "x" },
      { thread: { id: "b", cwd: "C:/other" }, snippet: "y" },
    ],
    nextCursor: "cursor-2",
  };
  const searchOut = h.__companionFilterHistoryResult("thread/search", searchResult);
  assert.deepStrictEqual(searchOut.data.map((r) => r.thread.id), ["a"]);
  assert.strictEqual(searchOut.nextCursor, "cursor-2");
  // scope metadata only attached to thread/list
  assert.strictEqual(searchOut.__companionScope, undefined);
});

test("host filter: fail closed on no roots ([] and nextCursor null)", () => {
  const h = evaluateHostGlue(() => []);
  const out = h.__companionFilterHistoryResult("thread/list", {
    data: [{ id: "a", cwd: "C:/ws" }],
    nextCursor: "cursor-1",
    other: "keep",
  });
  assert.deepStrictEqual(out.data, []);
  assert.strictEqual(out.nextCursor, null);
  assert.strictEqual(out.other, "keep");
  assert.deepStrictEqual(out.__companionScope.roots, []);
});

test("host filter: errors and non-list results pass through unchanged", () => {
  const h = evaluateHostGlue(() => ["C:/ws"]);
  const err = { error: { code: -1 } };
  assert.deepStrictEqual(h.__companionFilterHistoryResult("thread/list", err), err);
  assert.strictEqual(h.__companionFilterHistoryResult("thread/list", undefined), undefined);
  const noData = { foo: 1 };
  assert.deepStrictEqual(h.__companionFilterHistoryResult("thread/list", noData), noData);
  assert.strictEqual(h.__companionIsHistoryMethod("thread/list"), true);
  assert.strictEqual(h.__companionIsHistoryMethod("thread/search"), true);
  assert.strictEqual(h.__companionIsHistoryMethod("thread/read"), false);
});

// ---------------------------------------------------------------------------
// Generated deliverMcpResponseToOrigin wiring (actual patched host source)
// ---------------------------------------------------------------------------

function extractGeneratedDeliveryMethod() {
  const orig = fs.readFileSync(path.join(ORIG_DIR, "out/extension.js"), "utf8");
  const patched = patcher.generatePatchedText("out/extension.js", orig);
  const start = patched.indexOf("deliverMcpResponseToOrigin(e){");
  assert.notStrictEqual(start, -1, "generated host must contain deliverMcpResponseToOrigin(e)");
  const end = patched.indexOf("async ensureRestoredConversationTabsResolved", start);
  assert.ok(end > start, "delivery method must end before ensureRestoredConversationTabsResolved");
  return patched.slice(start, end);
}

function makeDeliveryContext(crFn) {
  const methodSource = extractGeneratedDeliveryMethod();
  const factory = new Function(
    "cR",
    patcher.loadCoreSource() + patcher.HOST_GLUE + "\nreturn ({" + methodSource + "});"
  );
  const proto = factory(crFn);
  const sent = [];
  const warnings = [];
  const ctx = {
    pendingMcpRequests: new Map(),
    __companionHistoryRequests: new Map(),
    logger: {
      warning(message, meta) {
        warnings.push({ message, meta });
      },
      error() {},
    },
    chunkedMessageSender: {
      send(webview, message) {
        sent.push({ webview, message });
      },
    },
    deliverMcpResponseToOrigin: proto.deliverMcpResponseToOrigin,
  };
  return { ctx, sent, warnings };
}

test("generated delivery: filters list result, attaches scope, clears side map", () => {
  const { ctx, sent, warnings } = makeDeliveryContext(() => ["C:/ws"]);
  const webview = { webviewId: "wv-1" };
  ctx.pendingMcpRequests.set("7", webview);
  ctx.__companionHistoryRequests.set("7", { method: "thread/list", webview });
  const result = {
    data: [
      { id: "a", cwd: "C:/ws" },
      { id: "b", cwd: "C:/other" },
    ],
    nextCursor: "cursor-1",
    keep: "yes",
  };

  ctx.deliverMcpResponseToOrigin({ id: 7, result, error: undefined });

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].webview, webview);
  const msg = sent[0].message;
  assert.strictEqual(msg.type, "mcp-response");
  assert.strictEqual(msg.hostId, "local");
  assert.strictEqual(msg.message.id, 7);
  assert.deepStrictEqual(msg.message.result.data.map((r) => r.id), ["a"]);
  assert.strictEqual(msg.message.result.nextCursor, "cursor-1");
  assert.strictEqual(msg.message.result.keep, "yes");
  assert.deepStrictEqual(msg.message.result.__companionScope.roots, ["C:/ws"]);
  assert.deepStrictEqual(msg.message.result.__companionScope.normalized, ["c:/ws"]);
  assert.strictEqual(ctx.pendingMcpRequests.has("7"), false);
  assert.strictEqual(ctx.__companionHistoryRequests.has("7"), false);
  assert.deepStrictEqual(warnings, []);
});

test("generated delivery: preserves error payload and clears side map", () => {
  const { ctx, sent } = makeDeliveryContext(() => ["C:/ws"]);
  const webview = { webviewId: "wv-2" };
  ctx.pendingMcpRequests.set("8", webview);
  ctx.__companionHistoryRequests.set("8", { method: "thread/search", webview });
  const error = { code: -32000, message: "boom" };

  ctx.deliverMcpResponseToOrigin({ id: 8, result: undefined, error });

  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(sent[0].message.message.error, error);
  assert.strictEqual(sent[0].message.message.result, undefined);
  assert.strictEqual(ctx.pendingMcpRequests.has("8"), false);
  assert.strictEqual(ctx.__companionHistoryRequests.has("8"), false);
});

test("generated delivery: unknown id warns without send; non-history result unchanged", () => {
  const { ctx, sent, warnings } = makeDeliveryContext(() => ["C:/ws"]);
  ctx.deliverMcpResponseToOrigin({ id: 999, result: { data: [{ id: "a" }] } });
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0].message, /unknown request id/);

  const webview = { webviewId: "wv-3" };
  ctx.pendingMcpRequests.set("10", webview);
  const result = { data: [{ id: "b", cwd: "C:/other" }], nextCursor: "c" };
  ctx.deliverMcpResponseToOrigin({ id: 10, result });

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].webview, webview);
  assert.deepStrictEqual(sent[0].message.message.result, result);
  assert.strictEqual(sent[0].message.message.result.__companionScope, undefined);
  assert.strictEqual(ctx.pendingMcpRequests.has("10"), false);
  assert.strictEqual(ctx.__companionHistoryRequests.size, 0);
});

// ---------------------------------------------------------------------------
// Browser glue (fail-closed scope, hostId guard)
// ---------------------------------------------------------------------------

function evaluateBrowserGlue() {
  const factory = new Function(
    patcher.loadCoreSource() +
      patcher.BROWSER_GLUE +
      "\nreturn { setResult: __companionBrowserSetScopeFromResult, setMsg: __companionBrowserSetScopeFromMessage, roots: __companionBrowserRoots, filter: __companionBrowserFilterRows, shouldSurface: __companionShouldSurface };"
  );
  return factory();
}

test("browser glue: undefined scope fails closed, non-local host unaffected", () => {
  const g = evaluateBrowserGlue();
  // no scope yet => fail closed for local
  assert.strictEqual(g.shouldSurface("C:/ws/x", "local"), false);
  assert.deepStrictEqual(g.filter([{ id: "a", cwd: "C:/ws" }], "local"), []);
  // non-local host never scoped
  assert.strictEqual(g.shouldSurface("C:/whatever", "cloud"), true);
  assert.deepStrictEqual(g.filter([{ id: "a", cwd: "C:/ws" }], "cloud"), [{ id: "a", cwd: "C:/ws" }]);
});

test("browser glue: scope set from message and from result metadata", () => {
  const g = evaluateBrowserGlue();
  g.setMsg({ hostId: "local", roots: ["C:/ws", "D:/other"] });
  assert.strictEqual(g.shouldSurface("C:/ws/sub", "local"), true);
  assert.strictEqual(g.shouldSurface("D:/other/sub", "local"), true);
  assert.strictEqual(g.shouldSurface("E:/else", "local"), false);
  assert.deepStrictEqual(g.filter([{ id: "a", cwd: "C:/ws/sub" }, { id: "b", cwd: "E:/else" }], "local").map((r) => r.id), ["a"]);

  // overwrite from list result metadata
  g.setResult({ __companionScope: { roots: ["E:/only"] } }, "local");
  assert.strictEqual(g.shouldSurface("E:/only/x", "local"), true);
  assert.strictEqual(g.shouldSurface("C:/ws/x", "local"), false);
});

// ---------------------------------------------------------------------------
// Patch generation from original bytes + syntax checks of all touched JS
// ---------------------------------------------------------------------------

test("generatePatchedText: deterministic, differs from original, matches manifest-derived digest", () => {
  for (const file of patcher.PATCHED_FILES) {
    const orig = fs.readFileSync(path.join(ORIG_DIR, file), "utf8");
    const p1 = patcher.generatePatchedText(file, orig);
    const p2 = patcher.generatePatchedText(file, orig);
    assert.strictEqual(patcher.sha256(p1), patcher.sha256(p2), `${file}: non-deterministic`);
    assert.notStrictEqual(patcher.sha256(p1), patcher.sha256(orig), `${file}: patch is no-op`);
  }
});

test("generatePatchedText composes the startup fix without changing the accepted history patch", () => {
  const candidateDir = path.join(ROOT, ".artifacts", "openai-project-history", "candidate-backup");
  const saved = JSON.parse(fs.readFileSync(path.join(candidateDir, "manifest.json"), "utf8"));
  const savedByFile = new Map(saved.files.map((entry) => [entry.file, entry]));

  // Both webview bundles stay byte-identical to the accepted history-only patch.
  for (const file of [
    "webview/assets/app-initial-97d3534ad35f.js",
    "webview/assets/app-initial-c014f9ee4429.js",
  ]) {
    const orig = fs.readFileSync(path.join(ORIG_DIR, file), "utf8");
    assert.strictEqual(
      patcher.sha256(patcher.generatePatchedText(file, orig)),
      savedByFile.get(file).patchedSha,
      `${file}: generated output changed`
    );
  }

  const origHost = fs.readFileSync(path.join(ORIG_DIR, "out/extension.js"), "utf8");
  const host = patcher.generatePatchedText("out/extension.js", origHost);
  assert.strictEqual(
    patcher.sha256(host),
    "421AFD3D7BE99C5C5B4F1FC92C2314F3BD15FD3D2CF4EC2D710132048A72B335",
    "new generated host digest changed unexpectedly"
  );
  assert.notStrictEqual(patcher.sha256(host), savedByFile.get("out/extension.js").patchedSha);

  // Only the two startup anchors changed: reversing them yields the accepted host byte-for-byte.
  const oldZf =
    'var ZF=class{constructor(e){this.onTimeout=e}timeout;disposed=!1;receivedWebviewMessage=!1;start(){if(this.disposed||this.timeout!=null)return;let e=Date.now();this.timeout=setTimeout(()=>{this.timeout=void 0,this.onTimeout({elapsedMs:Date.now()-e,receivedWebviewMessage:this.receivedWebviewMessage,timeoutMs:3e4})},3e4)}markMessageReceived(){this.receivedWebviewMessage=!0}handleStartupPhase(e){e==="renderer_ready"&&this.dispose()}dispose(){this.disposed=!0,this.timeout!=null&&(clearTimeout(this.timeout),this.timeout=void 0)}};';
  const oldPush =
    'this.subscriptions.push(a,n(()=>{s.dispose(),this.chunkedMessageSender.dispose(e)})),e.html=await this.getWebviewContent(e),s.start()';
  const newPush =
    'let b=__companionBindStartupVisibility(s,r==="panel"?this.findPanelByWebview(e):void 0);b&&this.subscriptions.push(b),this.subscriptions.push(a,n(()=>{s.dispose(),b?.dispose(),this.chunkedMessageSender.dispose(e)})),e.html=await this.getWebviewContent(e),s.start()';
  const savedHost = fs.readFileSync(
    path.join(ROOT, ".artifacts", "openai-project-history", "candidate", "out", "extension.js"),
    "utf8"
  );
  let reverted = host.replace(patcher.loadStartupWatchdogSource() + "var ZF=__companionStartupWatchdog;", oldZf);
  reverted = reverted.replace(newPush, oldPush);
  assert.strictEqual(reverted, savedHost, "host changes must be limited to the startup fix");

  // History seams remain present in the composed host.
  for (const seam of [
    "__companionHistoryRoots",
    "__companionFilterHistoryResult",
    "__companionHistoryRequests",
    "companion-history-scope-changed",
  ]) {
    assert.ok(host.includes(seam), `generated host lost history seam ${seam}`);
  }
});

test("manifest version and hashes cannot be overridden by the caller", () => {
  const extDir = makeTempExt();
  const backupDir = makeTempBackup();
  const badVersion = JSON.parse(JSON.stringify(MANIFEST));
  badVersion.version = "0.0.0-unknown";
  assert.throws(
    () => patcher.checkPatch({ extDir, backupDir, manifest: badVersion }),
    /unsupported manifest version/
  );

  const badHash = JSON.parse(JSON.stringify(MANIFEST));
  badHash.files.find((f) => f.file === "package.json").sha256 = "0".repeat(64);
  assert.throws(
    () => patcher.checkPatch({ extDir, backupDir, manifest: badHash }),
    /does not match the supported original hash/
  );
});

test("generatePatchedText: unknown file refuses", () => {
  assert.throws(() => patcher.generatePatchedText("package.json", "{}"), /not a patched file/);
});

test("patched JS is syntactically valid (host CJS + browser ESM)", () => {
  for (const file of patcher.PATCHED_FILES) {
    const orig = fs.readFileSync(path.join(ORIG_DIR, file), "utf8");
    const patched = patcher.generatePatchedText(file, orig);
    if (file === "out/extension.js") {
      const tmp = path.join(SCRATCH, "syntax-check-extension.js");
      fs.writeFileSync(tmp, patched);
      try {
        execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
      } finally {
        fs.unlinkSync(tmp);
      }
    } else {
      execFileSync(process.execPath, ["--input-type=module", "--check"], { input: patched, stdio: "pipe" });
    }
  }
});

// ---------------------------------------------------------------------------
// Patcher lifecycle: apply / check / restore / refusal / rollback
// ---------------------------------------------------------------------------

test("apply then restore restores byte equality; idempotent on both", () => {
  const extDir = makeTempExt();
  const backupDir = makeTempBackup();
  const originals = Object.fromEntries(
    patcher.PATCHED_FILES.map((f) => [f, bytes(path.join(extDir, f))])
  );

  const originalCheck = patcher.checkPatch({ extDir, backupDir, manifest: MANIFEST });
  assert.strictEqual(originalCheck.status, "original");
  assert.strictEqual(originalCheck.packageJson, "original");

  const applied = patcher.applyPatch({ extDir, backupDir, manifest: MANIFEST });
  assert.deepStrictEqual(applied.applied, patcher.PATCHED_FILES);
  for (const f of patcher.PATCHED_FILES) assert.strictEqual(applied.files[f], "patched");
  for (const f of patcher.PATCHED_FILES) {
    assert.notStrictEqual(patcher.sha256(bytes(path.join(extDir, f))), patcher.sha256(originals[f]));
  }

  // idempotent apply
  const applied2 = patcher.applyPatch({ extDir, backupDir, manifest: MANIFEST });
  assert.deepStrictEqual(applied2.applied, []);
  for (const f of patcher.PATCHED_FILES) assert.strictEqual(applied2.files[f], "patched");

  // check reports patched
  const check = patcher.checkPatch({ extDir, backupDir, manifest: MANIFEST });
  assert.strictEqual(check.identityOk, true);
  for (const f of patcher.PATCHED_FILES) assert.strictEqual(check.files[f], "patched");

  // restore byte equality
  const restored = patcher.restorePatch({ extDir, backupDir, manifest: MANIFEST });
  assert.deepStrictEqual(restored.restored, patcher.PATCHED_FILES);
  for (const f of patcher.PATCHED_FILES) assert.strictEqual(restored.files[f], "original");
  for (const f of patcher.PATCHED_FILES) {
    assert.deepStrictEqual(bytes(path.join(extDir, f)), originals[f], `${f}: restore not byte-equal`);
  }

  // idempotent restore
  const restored2 = patcher.restorePatch({ extDir, backupDir, manifest: MANIFEST });
  assert.deepStrictEqual(restored2.restored, []);
  for (const f of patcher.PATCHED_FILES) assert.strictEqual(restored2.files[f], "original");
});

test("apply refuses unknown version before any write", () => {
  const extDir = makeTempExt();
  const backupDir = makeTempBackup();
  const pkgPath = path.join(extDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.version = "0.0.0-unknown";
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

  assert.throws(() => patcher.applyPatch({ extDir, backupDir, manifest: MANIFEST }), /identity check failed/);
  assert.strictEqual(fs.existsSync(backupDir), false, "backup dir must not be created on refusal");
});

test("apply refuses modified (unknown hash) original before any write", () => {
  const extDir = makeTempExt();
  const backupDir = makeTempBackup();
  const target = path.join(extDir, patcher.PATCHED_FILES[0]);
  fs.appendFileSync(target, "\n// foreign modification\n");

  assert.throws(() => patcher.applyPatch({ extDir, backupDir, manifest: MANIFEST }), /not in original state/);
  assert.strictEqual(fs.existsSync(backupDir), false, "backup dir must not be created on refusal");
});

test("restore refuses foreign current bytes and corrupt backup", () => {
  // foreign current bytes
  {
    const extDir = makeTempExt();
    const backupDir = makeTempBackup();
    fs.appendFileSync(path.join(extDir, patcher.PATCHED_FILES[0]), "\n// foreign\n");
    assert.throws(() => patcher.restorePatch({ extDir, backupDir, manifest: MANIFEST }), /neither original nor expected-patched/);
  }
  // corrupt backup after apply
  {
    const extDir = makeTempExt();
    const backupDir = makeTempBackup();
    patcher.applyPatch({ extDir, backupDir, manifest: MANIFEST });
    const corruptTarget = path.join(backupDir, "files", patcher.PATCHED_FILES[1]);
    fs.writeFileSync(corruptTarget, "corrupted");
    // A corrupt backup makes the expected-patched digest underivable; restore must refuse.
    assert.throws(() => patcher.restorePatch({ extDir, backupDir, manifest: MANIFEST }), /refusing/);
  }
});

test("apply rolls back already-written files on mid-apply failure", () => {
  const extDir = makeTempExt();
  const backupDir = makeTempBackup();
  const originals = Object.fromEntries(
    patcher.PATCHED_FILES.map((f) => [f, bytes(path.join(extDir, f))])
  );

  const realRename = fs.renameSync;
  let secondBundleWriteCount = 0;
  fs.renameSync = function (from, to) {
    if (String(to).includes("app-initial-97d3534ad35f.js")) {
      secondBundleWriteCount += 1;
      if (secondBundleWriteCount === 2) {
        const e = new Error("injected rename failure");
        e.code = "EIO";
        throw e;
      }
    }
    return realRename(from, to);
  };

  try {
    assert.throws(() => patcher.applyPatch({ extDir, backupDir, manifest: MANIFEST }), /apply failed/);
  } finally {
    fs.renameSync = realRename;
  }

  // first file (extension.js) must have been rolled back to its original bytes
  assert.deepStrictEqual(
    bytes(path.join(extDir, patcher.PATCHED_FILES[0])),
    originals[patcher.PATCHED_FILES[0]],
    "extension.js must be rolled back to original"
  );
  // second file must be untouched (never written)
  assert.deepStrictEqual(bytes(path.join(extDir, patcher.PATCHED_FILES[1])), originals[patcher.PATCHED_FILES[1]]);
});

function rewritePackageWithHarmlessChange(extDir) {
  const pkgPath = path.join(extDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.description = `${pkg.description || ""} harmless test change`;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
  return pkg;
}

test("apply refuses package.json hash mismatch even when identity fields match", () => {
  const extDir = makeTempExt();
  const backupDir = makeTempBackup();
  const pkg = rewritePackageWithHarmlessChange(extDir);
  assert.strictEqual(pkg.publisher, patcher.PUBLISHER);
  assert.strictEqual(pkg.name, patcher.NAME);
  assert.strictEqual(pkg.version, patcher.SUPPORTED_VERSION);
  const before = Object.fromEntries(
    patcher.PATCHED_FILES.map((f) => [f, bytes(path.join(extDir, f))])
  );

  assert.throws(
    () => patcher.applyPatch({ extDir, backupDir, manifest: MANIFEST }),
    /package\.json does not match the supported original hash/
  );
  assert.strictEqual(fs.existsSync(backupDir), false, "backup dir must not be created on refusal");
  for (const f of patcher.PATCHED_FILES) {
    assert.deepStrictEqual(bytes(path.join(extDir, f)), before[f], `${f}: must not be written`);
  }
});

test("restore refuses package.json hash mismatch before writing", () => {
  const extDir = makeTempExt();
  const backupDir = makeTempBackup();
  patcher.applyPatch({ extDir, backupDir, manifest: MANIFEST });
  const before = Object.fromEntries(
    patcher.PATCHED_FILES.map((f) => [f, bytes(path.join(extDir, f))])
  );
  rewritePackageWithHarmlessChange(extDir);

  assert.throws(
    () => patcher.restorePatch({ extDir, backupDir, manifest: MANIFEST }),
    /package\.json does not match the supported original hash/
  );
  for (const f of patcher.PATCHED_FILES) {
    assert.deepStrictEqual(bytes(path.join(extDir, f)), before[f], `${f}: must remain patched`);
  }
});

test("check aggregates all files and CLI rejects foreign/missing/identity/package states", () => {
  // foreign last file (previously check looked only at the first file)
  {
    const extDir = makeTempExt();
    const backupDir = makeTempBackup();
    fs.appendFileSync(path.join(extDir, patcher.PATCHED_FILES[2]), "\n// foreign\n");
    const check = patcher.checkPatch({ extDir, backupDir, manifest: MANIFEST });
    assert.strictEqual(check.status, "foreign");
    assert.strictEqual(check.files[patcher.PATCHED_FILES[2]], "foreign");
    const cli = runCheckCli(extDir, backupDir);
    assert.strictEqual(cli.code, 1);
    assert.strictEqual(cli.result.status, "foreign");
  }

  // missing last file
  {
    const extDir = makeTempExt();
    const backupDir = makeTempBackup();
    fs.unlinkSync(path.join(extDir, patcher.PATCHED_FILES[2]));
    const check = patcher.checkPatch({ extDir, backupDir, manifest: MANIFEST });
    assert.strictEqual(check.status, "missing");
    assert.strictEqual(check.files[patcher.PATCHED_FILES[2]], "missing");
    const cli = runCheckCli(extDir, backupDir);
    assert.strictEqual(cli.code, 1);
    assert.strictEqual(cli.result.status, "missing");
  }

  // identity mismatch
  {
    const extDir = makeTempExt();
    const backupDir = makeTempBackup();
    const pkgPath = path.join(extDir, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    pkg.version = "0.0.0-unknown";
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    const check = patcher.checkPatch({ extDir, backupDir, manifest: MANIFEST });
    assert.strictEqual(check.status, "identity-error");
    const cli = runCheckCli(extDir, backupDir);
    assert.strictEqual(cli.code, 1);
    assert.strictEqual(cli.result.status, "identity-error");
  }

  // package.json hash mismatch with valid identity fields
  {
    const extDir = makeTempExt();
    const backupDir = makeTempBackup();
    rewritePackageWithHarmlessChange(extDir);
    const check = patcher.checkPatch({ extDir, backupDir, manifest: MANIFEST });
    assert.strictEqual(check.status, "package-json-mismatch");
    assert.strictEqual(check.packageJson, "mismatch");
    const cli = runCheckCli(extDir, backupDir);
    assert.strictEqual(cli.code, 1);
    assert.strictEqual(cli.result.status, "package-json-mismatch");
  }
});

test("check reports mixed original/patched state and CLI accepts it", () => {
  const extDir = makeTempExt();
  const backupDir = makeTempBackup();
  patcher.applyPatch({ extDir, backupDir, manifest: MANIFEST });
  fs.copyFileSync(
    path.join(ORIG_DIR, patcher.PATCHED_FILES[0]),
    path.join(extDir, patcher.PATCHED_FILES[0])
  );

  const check = patcher.checkPatch({ extDir, backupDir, manifest: MANIFEST });
  assert.strictEqual(check.status, "mixed");
  assert.strictEqual(check.files[patcher.PATCHED_FILES[0]], "original");
  assert.strictEqual(check.files[patcher.PATCHED_FILES[1]], "patched");
  assert.strictEqual(check.files[patcher.PATCHED_FILES[2]], "patched");

  const cli = runCheckCli(extDir, backupDir);
  assert.strictEqual(cli.code, 0);
  assert.strictEqual(cli.result.status, "mixed");
});

test("aggregateCheckStatus: unknown states are not success states", () => {
  const statuses = Object.fromEntries(patcher.PATCHED_FILES.map((f) => [f, "unexpected"]));
  assert.strictEqual(
    patcher.aggregateCheckStatus({ ok: true }, { status: "original" }, statuses),
    "unknown"
  );
  assert.strictEqual(patcher.CHECK_OK_STATUSES.has("unknown"), false);
});

test("restore preflights all files: foreign last file causes zero writes", () => {
  const extDir = makeTempExt();
  const backupDir = makeTempBackup();
  patcher.applyPatch({ extDir, backupDir, manifest: MANIFEST });
  const patched = Object.fromEntries(
    patcher.PATCHED_FILES.map((f) => [f, bytes(path.join(extDir, f))])
  );
  const lastPath = path.join(extDir, patcher.PATCHED_FILES[2]);
  fs.appendFileSync(lastPath, "\n// foreign\n");
  const foreignBytes = bytes(lastPath);

  assert.throws(
    () => patcher.restorePatch({ extDir, backupDir, manifest: MANIFEST }),
    /neither original nor expected-patched/
  );
  assert.deepStrictEqual(bytes(path.join(extDir, patcher.PATCHED_FILES[0])), patched[patcher.PATCHED_FILES[0]]);
  assert.deepStrictEqual(bytes(path.join(extDir, patcher.PATCHED_FILES[1])), patched[patcher.PATCHED_FILES[1]]);
  assert.deepStrictEqual(bytes(lastPath), foreignBytes);
});

test("restore preflights all backups: corrupt last backup causes zero writes", () => {
  const extDir = makeTempExt();
  const backupDir = makeTempBackup();
  patcher.applyPatch({ extDir, backupDir, manifest: MANIFEST });
  const patched = Object.fromEntries(
    patcher.PATCHED_FILES.map((f) => [f, bytes(path.join(extDir, f))])
  );
  fs.writeFileSync(path.join(backupDir, "files", patcher.PATCHED_FILES[2]), "corrupted");

  assert.throws(
    () => patcher.restorePatch({ extDir, backupDir, manifest: MANIFEST }),
    /refusing/
  );
  for (const f of patcher.PATCHED_FILES) {
    assert.deepStrictEqual(bytes(path.join(extDir, f)), patched[f], `${f}: must remain patched`);
  }
});

test("restore rolls back already-restored files on mid-restore failure", () => {
  const extDir = makeTempExt();
  const backupDir = makeTempBackup();
  patcher.applyPatch({ extDir, backupDir, manifest: MANIFEST });
  const patched = Object.fromEntries(
    patcher.PATCHED_FILES.map((f) => [f, bytes(path.join(extDir, f))])
  );

  const realRename = fs.renameSync;
  const targetName = patcher.PATCHED_FILES[1];
  let injected = false;
  fs.renameSync = function (from, to) {
    if (!injected && String(to).includes(path.basename(targetName))) {
      injected = true;
      const e = new Error("injected restore rename failure");
      e.code = "EIO";
      throw e;
    }
    return realRename(from, to);
  };

  try {
    assert.throws(() => patcher.restorePatch({ extDir, backupDir, manifest: MANIFEST }), /restore failed/);
  } finally {
    fs.renameSync = realRename;
  }

  for (const f of patcher.PATCHED_FILES) {
    assert.deepStrictEqual(bytes(path.join(extDir, f)), patched[f], `${f}: rollback must restore patched bytes`);
  }
  const check = patcher.checkPatch({ extDir, backupDir, manifest: MANIFEST });
  assert.strictEqual(check.status, "patched");
});
