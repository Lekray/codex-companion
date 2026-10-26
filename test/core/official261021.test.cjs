"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ADAPTER = process.env.COMPANION_ADAPTER_261021
  ? path.resolve(process.env.COMPANION_ADAPTER_261021)
  : path.join(__dirname, "..", "..", "scripts", "official261021.cjs");

const adapter = require(ADAPTER);
const { createEngine } = require("../../scripts/companionPatchEngine.cjs");

const INSTALLED =
  process.env.COMPANION_OFFICIAL_261021 ||
  path.resolve(__dirname, "../../.artifacts/fixes-0210/originals");

const hasInstalled = fs.existsSync(path.join(INSTALLED, "package.json"));

test("SUPPORTED_VERSION and identity constants", () => {
  assert.equal(adapter.SUPPORTED_VERSION, "26.1021.22027");
  assert.equal(adapter.PUBLISHER, "openai");
  assert.equal(adapter.NAME, "chatgpt");
  assert.equal(adapter.MANIFEST_SCHEMA, 3);
});

test("FILES is exactly the eleven pinned originals", () => {
  assert.equal(adapter.FILES.length, 11);
  assert.deepEqual(adapter.FILES, [
    "package.json",
    "out/extension.js",
    "webview/assets/src-622b307a9baf.js",
    "webview/assets/initialize-app-host-services.extension-f722db488e05.js",
    "webview/assets/local-conversation-page-e49199d4fdb5.js",
    "webview/assets/message-bus-4113ba7287d7.js",
    "webview/assets/use-model-settings-aafcff4b111c.js",
    "webview/assets/composer-content-8ab21f1a1982.js",
    "webview/assets/composer-scope-f0dbf0e746b6.js",
    "webview/assets/bookmarked-thread-user-message-navigation-36a0dadf9f5d.js",
    "webview/assets/app-initial-13f932cb2f13.js",
  ]);
  for (const rel of adapter.FILES) {
    assert.match(adapter.ORIGINAL_HASHES[rel], /^[0-9a-f]{64}$/);
    assert.equal(adapter.ORIGINAL_HASHES[rel], adapter.ORIGINAL_HASHES[rel].toLowerCase());
  }
});

test("STAGES and FEATURES match the required nine feature IDs", () => {
  assert.deepEqual(adapter.STAGES, ["original", "history", "titles", "workflow", "drafts"]);
  assert.deepEqual(
    adapter.FEATURES.map((f) => f.id),
    [
      "project-history",
      "startup-watchdog",
      "native-tab-titles",
      "project-model",
      "tab-status",
      "workflow-notifications",
      "independent-drafts",
      "webview-recovery",
      "preload-index",
    ]
  );
  for (const feature of adapter.FEATURES) {
    assert.ok(adapter.STAGES.includes(feature.stage));
    assert.ok(Array.isArray(feature.files));
    for (const file of feature.files) assert.ok(adapter.FILES.includes(file));
  }
  assert.deepEqual(
    adapter.FEATURES.find((f) => f.id === "webview-recovery"),
    { id: "webview-recovery", stage: "drafts", files: [adapter.RECOVERY_FILE] }
  );
  assert.deepEqual(
    adapter.FEATURES.find((f) => f.id === "preload-index"),
    { id: "preload-index", stage: "drafts", files: [adapter.PRELOAD_FILE] }
  );
});

test("the preload index transform is pinned to the new official target", () => {
  const preload = require("../../scripts/officialPreloadIndex.cjs");
  assert.equal(adapter.PRELOAD_FILE, preload.FILE);
  assert.equal(adapter.PRELOAD_FILE, "webview/assets/app-initial-13f932cb2f13.js");
  assert.equal(adapter.ORIGINAL_HASHES[adapter.PRELOAD_FILE], preload.ORIGINAL_HASH);
});

test("transformStage rejects unknown file and unknown stage", () => {
  assert.throws(() => adapter.transformStage("not-a-file.js", "x", "original"), /unknown file/);
  assert.throws(() => adapter.transformStage(adapter.HOST, "x", "nope"), /unknown stage/);
  assert.throws(() => adapter.transformStage(adapter.HOST, null, "history"), /text must be a string/);
});

test("transformStage original is a no-op and deterministic", () => {
  const text = "some text";
  assert.equal(adapter.transformStage(adapter.HOST, text, "original"), text);
});

test("per-stage unaffected files are returned unchanged", () => {
  const sentinel = "UNCHANGED-SENTINEL";
  assert.equal(adapter.transformStage(adapter.COMPOSER_SCOPE, sentinel, "history"), sentinel);
  assert.equal(adapter.transformStage(adapter.COMPOSER_SCOPE, sentinel, "titles"), sentinel);
  assert.equal(adapter.transformStage(adapter.COMPOSER_SCOPE, sentinel, "workflow"), sentinel);
  assert.equal(adapter.transformStage(adapter.HOST, sentinel, "drafts"), sentinel);
  assert.equal(adapter.transformStage(adapter.MODEL_SETTINGS, sentinel, "history"), sentinel);
  assert.equal(adapter.transformStage(adapter.MESSAGE_BUS, sentinel, "history"), sentinel);
  assert.equal(adapter.transformStage(adapter.RECOVERY_FILE, sentinel, "history"), sentinel);
  assert.equal(adapter.transformStage(adapter.RECOVERY_FILE, sentinel, "titles"), sentinel);
  assert.equal(adapter.transformStage(adapter.RECOVERY_FILE, sentinel, "workflow"), sentinel);
  assert.equal(adapter.transformStage(adapter.PRELOAD_FILE, sentinel, "history"), sentinel);
  assert.equal(adapter.transformStage(adapter.PRELOAD_FILE, sentinel, "titles"), sentinel);
  assert.equal(adapter.transformStage(adapter.PRELOAD_FILE, sentinel, "workflow"), sentinel);
});

test("status runtime aliases are rewritten for the new host", () => {
  const core = adapter.statusCoreSource();
  const v2At = core.indexOf("function __companionWorkflowStateKey()");
  assert.ok(v2At > 0);
  const runtime = core.slice(v2At);
  assert.ok(runtime.includes("Be.commands"));
  assert.ok(runtime.includes("Be.workspace"));
  assert.ok(runtime.includes("typeof fv === \"function\""));
  assert.ok(runtime.includes("typeof jje === \"function\""));
  assert.doesNotMatch(runtime, /\bje\b/);
  assert.doesNotMatch(runtime, /\bcR\b/);
  assert.doesNotMatch(runtime, /\bTKe\b/);
});

test("status core injects the frozen question-history globals before V2", () => {
  const core = adapter.statusCoreSource();
  const projected = core.indexOf("__companionQuestionProject");
  const candidates = core.indexOf("__companionQuestionCandidates");
  const create = core.indexOf("__companionCreateQuestionHistory");
  const v2At = core.indexOf("function __companionWorkflowStateKey()");
  assert.ok(projected >= 0, "question projection helper is missing");
  assert.ok(candidates > projected, "question candidates helper is missing");
  assert.ok(create > candidates, "question history factory is missing");
  assert.ok(v2At > create, "question history must precede the V2 runtime");
  assert.ok(core.includes("__companionCreateQuestionHistory({"));
  assert.ok(core.includes("history.receive(record, result, null)"));
  assert.ok(core.includes("history.disposeWebview(webview)"));
});

test("model runtime roots alias is rewritten for the new host", () => {
  const core = adapter.modelCoreSource();
  assert.ok(core.includes("roots = fv()"));
  assert.doesNotMatch(core, /\bcR\b/);
});

test("buildManifest verifies pinned hashes and emits schema:3", { skip: !hasInstalled }, () => {
  const manifest = adapter.buildManifest(INSTALLED);
  assert.equal(manifest.schema, 3);
  assert.equal(manifest.officialVersion, "26.1021.22027");
  assert.equal(manifest.publisher, "openai");
  assert.equal(manifest.name, "chatgpt");
  assert.deepEqual(manifest.files, adapter.FILES);
  for (const stage of adapter.STAGES) {
    assert.ok(manifest.stages[stage]);
    for (const rel of adapter.FILES) {
      assert.match(manifest.stages[stage][rel], /^[0-9a-f]{64}$/);
    }
  }
  assert.equal(manifest.stages.original["package.json"], adapter.ORIGINAL_HASHES["package.json"]);
  assert.equal(manifest.stages.original[adapter.HOST], adapter.ORIGINAL_HASHES[adapter.HOST]);
  const attestation = adapter.buildAttestation(manifest);
  assert.equal(attestation.schema, 3);
  assert.equal(attestation.officialVersion, "26.1021.22027");
  assert.deepEqual(attestation.features, adapter.FEATURES.map((f) => f.id));
  assert.deepEqual(attestation.files, manifest.stages.drafts);
});

test("full stage chain is incremental and deterministic", { skip: !hasInstalled }, () => {
  const host = fs.readFileSync(path.join(INSTALLED, adapter.HOST), "utf8");
  const history = adapter.transformStage(adapter.HOST, host, "history");
  assert.ok(history.includes("__companionStartupWatchdog"));
  assert.ok(history.includes("__companionHistoryRoots"));
  assert.ok(history.includes("companion-history-scope-changed"));

  const titles = adapter.transformStage(adapter.HOST, history, "titles");
  assert.ok(titles.includes('case"companion-tab-title"'));
  assert.ok(titles.includes("__companionApplyCompanionTabTitle"));
  assert.ok(titles.includes("__companionShouldApplyPreviewTitle"));

  const workflow = adapter.transformStage(adapter.HOST, titles, "workflow");
  assert.ok(workflow.includes("__companionWorkflowRuntime"));
  assert.ok(workflow.includes("__companionWorkflowNotification"));
  assert.ok(workflow.includes("__companionWorkflowRequest"));
  assert.ok(workflow.includes("__companionWorkflowInstall"));
  assert.ok(workflow.includes("companion-project-model-request"));
  assert.ok(workflow.includes("companion-project-model-selected"));
  assert.ok(workflow.includes("__companionWorkflowGetProjectModel"));
  assert.ok(workflow.includes("__companionWorkflowTrackRead(this,e,r.request)"));
  assert.ok(workflow.includes("__companionWorkflowReadResponse(this,n,{id:r"));
  assert.ok(workflow.includes("__companionWorkflowForgetRead(this,String(r.requestId))"));
  assert.ok(workflow.includes("__companionWorkflowForgetRead(this,ye)"));
  assert.ok(workflow.includes("__companionWorkflowForgetWebviewReads(this,e)"));
  assert.ok(workflow.includes('__companionIsHistoryMethod(m){return m==="thread/list"||m==="thread/search"}'));

  const workflow2 = adapter.transformStage(adapter.HOST, titles, "workflow");
  assert.equal(workflow, workflow2);
});

test("workflow hydration observes only the existing thread/read request/response", { skip: !hasInstalled }, () => {
  const host = fs.readFileSync(path.join(INSTALLED, adapter.HOST), "utf8");
  const history = adapter.transformStage(adapter.HOST, host, "history");
  const titles = adapter.transformStage(adapter.HOST, history, "titles");
  const workflow = adapter.transformStage(adapter.HOST, titles, "workflow");
  for (const marker of [
    "__companionWorkflowTrackRead(this,e,r.request)",
    "__companionWorkflowReadResponse(this,n,{id:r",
    "__companionWorkflowForgetRead(this,String(r.requestId))",
    "__companionWorkflowForgetRead(this,ye)",
    "__companionWorkflowForgetWebviewReads(this,e)",
  ]) {
    assert.equal(workflow.split(marker).length - 1, 1, marker);
  }
  assert.ok(
    workflow.includes('method === "thread/read" ||') &&
      workflow.includes('method === "thread/resume" ||') &&
      workflow.includes('method === "thread/turns/list" ||') &&
      workflow.includes('method === "thread/items/list"')
  );
  assert.ok(workflow.includes("runtime.history.track(record)"));
  assert.ok(workflow.includes("runtime.history.receive(record, result, null)"));
  assert.ok(workflow.includes("function __companionWorkflowSetStatusSilent"));
  assert.ok(workflow.includes("live: live !== false"));
  assert.ok(workflow.includes("thread.liveEpoch = (thread.liveEpoch || 0) + 1"));
});

test("draft stage scopes the native home key", { skip: !hasInstalled }, () => {
  const scope = fs.readFileSync(path.join(INSTALLED, adapter.COMPOSER_SCOPE), "utf8");
  const drafts = adapter.transformStage(adapter.COMPOSER_SCOPE, scope, "drafts");
  assert.ok(drafts.includes("__companionDraftIsolation.scopeKey"));
  assert.ok(drafts.includes("companion-draft-isolation-v1"));
});

test("draft stage applies the pinned webview recovery transform only to its target", { skip: !hasInstalled }, () => {
  const recovery = require("../../scripts/officialWebviewRecovery.cjs");
  const source = fs.readFileSync(path.join(INSTALLED, adapter.RECOVERY_FILE), "utf8");
  const drafts = adapter.transformStage(adapter.RECOVERY_FILE, source, "drafts");
  assert.equal(drafts, recovery.transform(source));
  assert.equal(adapter.sha256(drafts), recovery.PATCHED_HASH);
  assert.ok(drafts.includes("propagateLoadError:!1"));
});

test("draft stage applies the pinned preload index transform only to its target", { skip: !hasInstalled }, () => {
  const preload = require("../../scripts/officialPreloadIndex.cjs");
  const source = fs.readFileSync(path.join(INSTALLED, adapter.PRELOAD_FILE), "utf8");
  const drafts = adapter.transformStage(adapter.PRELOAD_FILE, source, "drafts");
  assert.equal(drafts, preload.transform(source));
  assert.equal(adapter.sha256(drafts), preload.PATCHED_HASH);
  assert.ok(drafts.includes("if(r?h.has(t):u.has(t))return;"));
});

test("missing anchor throws", { skip: !hasInstalled }, () => {
  const host = fs.readFileSync(path.join(INSTALLED, adapter.HOST), "utf8");
  const corrupted = host.replace(
    "receivedWebviewMessage=!1;start()",
    "receivedWebviewMessage=!1;start2()"
  );
  assert.throws(
    () => adapter.transformStage(adapter.HOST, corrupted, "history"),
    /anchor not found/
  );
});

test("duplicate anchor throws", { skip: !hasInstalled }, () => {
  const host = fs.readFileSync(path.join(INSTALLED, adapter.HOST), "utf8");
  const history = adapter.transformStage(adapter.HOST, host, "history");
  const needle = 'case"view-focused":{this.setFocusedViewForWebview(e);break}';
  const corrupted = history.replace(needle, needle + needle);
  assert.throws(
    () => adapter.transformStage(adapter.HOST, corrupted, "titles"),
    /anchor not unique/
  );
});

test("verifyTransforms syntax-checks every generated program", { skip: !hasInstalled }, () => {
  const workDir = path.join(__dirname, "..", "..", ".artifacts", "fixes-0210", "integration", "adapter-work", "test-generated");
  const report = adapter.verifyTransforms(INSTALLED, workDir);
  for (const rel of adapter.FILES) {
    assert.equal(report[rel].syntax, "ok");
    assert.match(report[rel].patchedSha, /^[0-9a-f]{64}$/);
  }
});

test("eleven-target engine rejects missing and mixed preload targets without writing", { skip: !hasInstalled }, async (t) => {
  const preload = require("../../scripts/officialPreloadIndex.cjs");
  const fixtureRoot = path.join(__dirname, "..", "..", ".artifacts", "fixes-0210", "integration", "engine-fixtures");
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtureRoot, "engine-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const extDir = path.join(root, "extension");
  fs.cpSync(INSTALLED, extDir, { recursive: true });
  const backupDir = path.join(root, "backup");
  const engine = createEngine(adapter);
  const preloadPath = path.join(extDir, ...adapter.PRELOAD_FILE.split("/"));
  const snapshot = () =>
    adapter.FILES.map((rel) => adapter.sha256(fs.readFileSync(path.join(extDir, ...rel.split("/")))));

  const original = await engine.check({ extDir, backupDir });
  assert.equal(original.state, "original");
  assert.equal(original.code, "original");
  assert.equal(original.canInstall, true);
  assert.equal(original.features.find((f) => f.id === "preload-index").status, "missing");

  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(root, "local-appdata");
  try {
    const fresh = await engine.check({ extDir });
    assert.equal(
      fresh.backup.path,
      path.join(process.env.LOCALAPPDATA, "codex-companion", "patches", adapter.SUPPORTED_VERSION, "chunks-v3"),
    );
  } finally {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
  }

  fs.rmSync(preloadPath);
  const missing = await engine.check({ extDir, backupDir });
  assert.equal(missing.code, "missing-file");
  assert.equal(missing.canInstall, false);
  assert.equal(missing.features.find((f) => f.id === "preload-index").status, "unverified");

  fs.writeFileSync(preloadPath, preload.transform(fs.readFileSync(path.join(INSTALLED, ...adapter.PRELOAD_FILE.split("/")), "utf8")));
  const mixed = await engine.check({ extDir, backupDir });
  assert.equal(mixed.state, "mixed");
  assert.equal(mixed.code, "mixed");
  assert.equal(mixed.canInstall, false);
  assert.equal(mixed.canRestore, false);
  assert.equal(fs.existsSync(backupDir), false);
  assert.deepEqual(snapshot(), adapter.FILES.map((rel) =>
    rel === adapter.PRELOAD_FILE
      ? adapter.sha256(preload.transform(fs.readFileSync(path.join(INSTALLED, ...rel.split("/")), "utf8")))
      : adapter.ORIGINAL_HASHES[rel]
  ));
});
