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
  path.resolve(__dirname, "../../.artifacts/composer-recovery/originals");

const INTEGRATION_ROOT = path.resolve(__dirname, "../../.artifacts/composer-recovery/integration");

const PRIOR_FILES = [
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
  "webview/assets/local-conversation-thread-a37d62aef644.js",
];

const PRIOR_ORIGINALS = {
  "package.json": "35198adfbce5e74047dfe4ce9a5b1e987e745415ef6e1cdc5a9fef2b759dc520",
  "out/extension.js": "a9cc6736cd2c2d22f6cf43fc5763d5f8a873e4f741f522b44a600b1926f4e627",
  "webview/assets/src-622b307a9baf.js": "e4a82a9ee669473490d25c1f2b6f7b60abc4a1b193acb1f9c0a92e074dc81eb5",
  "webview/assets/initialize-app-host-services.extension-f722db488e05.js": "7d62f3e00516acd50693610d449cdc92e25a4599a18ab2e9353f8ab537777d1c",
  "webview/assets/local-conversation-page-e49199d4fdb5.js": "c3c836af38901935a6b1d8fe41dbcd0419c602a35b4d099338d862ab8c8e069a",
  "webview/assets/message-bus-4113ba7287d7.js": "9536ce9674179537acc6ecb09a74a01af08b203f4eb812851ea05182311c3ff0",
  "webview/assets/use-model-settings-aafcff4b111c.js": "23d2322fe24ae6d151e2fef55108942be50ca8b38aacd52e5102143bb2d1b47e",
  "webview/assets/composer-content-8ab21f1a1982.js": "a4fbed28d7fbc35c755690023da6eba1ca656719bd2823a95684e47cfbdd3d01",
  "webview/assets/composer-scope-f0dbf0e746b6.js": "02fe29bd8b1da9a86c6c39a95f69af9b60a8c76c37535ecd5e0b92fbc45243fd",
  "webview/assets/bookmarked-thread-user-message-navigation-36a0dadf9f5d.js": "6295d2141f11872bb070e03049e326a7cc340bd6ffdb3761f5a80bea88ba186b",
  "webview/assets/app-initial-13f932cb2f13.js": "9852ece5b9a25906b654fa8cccd77873105fe1b88556b141fc35dc4062511629",
  "webview/assets/local-conversation-thread-a37d62aef644.js": "2fcd72651c746aed39703185eecc59e285479db3a7a5710e326c2810da1ed563",
};

const PRIOR_DRAFTS = {
  "package.json": "35198adfbce5e74047dfe4ce9a5b1e987e745415ef6e1cdc5a9fef2b759dc520",
  "out/extension.js": "948a5583504f716a9a5efefe8a617111ea9228f60400f349726a9c5d325a9bda",
  "webview/assets/src-622b307a9baf.js": "aa54b2c189367a50541a7ea27b3cfe05d5c476588d657f63543ce8eac681fdb2",
  "webview/assets/initialize-app-host-services.extension-f722db488e05.js": "b7591760d7d1ca8ab64644151f2997617ac77d0ba9ccc139dd3881b59fe1f73c",
  "webview/assets/local-conversation-page-e49199d4fdb5.js": "4a5b4d7414669edf6a57420f1ea3186fba9f505c0d4bc9491e528acf9f0bbcd1",
  "webview/assets/message-bus-4113ba7287d7.js": "aae9bcfd81a37be141675a79ea670572fb8b7e041c2debddfacadc657c500db8",
  "webview/assets/use-model-settings-aafcff4b111c.js": "4ed17b3232091dd85537be18301ab1bd3e9d7711b9524cc2444de7a201053f74",
  "webview/assets/composer-content-8ab21f1a1982.js": "a3b91dee9230ab94d1518c90dc63e83d5284dba4b468ba0a58c2f68bb8c49cdc",
  "webview/assets/composer-scope-f0dbf0e746b6.js": "79227c2014dd9a11ed1d2ab8ed6428723626245bea2791cc7b6af02b5d57507d",
  "webview/assets/bookmarked-thread-user-message-navigation-36a0dadf9f5d.js": "dc3e4c4bb1abf3b8b85ad2565e390eb4067a2f322becf038a1c9792ac03e3285",
  "webview/assets/app-initial-13f932cb2f13.js": "3753642aab9026fe1fdf361530612b6a3864ec7c084e68778c6f7f003e7c549e",
  "webview/assets/local-conversation-thread-a37d62aef644.js": "670ec720c734332d68050319cc047bd853dd6ddbea0edeab10effe0db6d81ed4",
};

const hasInstalled = fs.existsSync(path.join(INSTALLED, "package.json"));

test("SUPPORTED_VERSION and identity constants", () => {
  assert.equal(adapter.SUPPORTED_VERSION, "26.1021.22027");
  assert.equal(adapter.PUBLISHER, "openai");
  assert.equal(adapter.NAME, "chatgpt");
  assert.equal(adapter.MANIFEST_SCHEMA, 3);
});

test("FILES is exactly the thirteen pinned originals", () => {
  assert.equal(adapter.FILES.length, 13);
  assert.deepEqual(adapter.FILES, [
    ...PRIOR_FILES,
    "webview/assets/thread-composer-content-lazy-720f6fb84454.js",
  ]);
  for (const rel of adapter.FILES) {
    assert.match(adapter.ORIGINAL_HASHES[rel], /^[0-9a-f]{64}$/);
    assert.equal(adapter.ORIGINAL_HASHES[rel], adapter.ORIGINAL_HASHES[rel].toLowerCase());
  }
});

test("STAGES and FEATURES match the required eleven feature IDs", () => {
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
      "autoscroll",
      "composer-recovery",
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
  assert.deepEqual(
    adapter.FEATURES.find((f) => f.id === "autoscroll"),
    { id: "autoscroll", stage: "drafts", files: [adapter.AUTOSCROLL_FILE] }
  );
});

test("the preload index transform is pinned to the new official target", () => {
  const preload = require("../../scripts/officialPreloadIndex.cjs");
  assert.equal(adapter.PRELOAD_FILE, preload.FILE);
  assert.equal(adapter.PRELOAD_FILE, "webview/assets/app-initial-13f932cb2f13.js");
  assert.equal(adapter.ORIGINAL_HASHES[adapter.PRELOAD_FILE], preload.ORIGINAL_HASH);
});

test("the autoscroll transform is pinned to the twelfth official target", () => {
  const autoscroll = require("../../scripts/officialAutoscroll.cjs");
  assert.equal(adapter.AUTOSCROLL_FILE, autoscroll.FILE);
  assert.equal(adapter.AUTOSCROLL_FILE, "webview/assets/local-conversation-thread-a37d62aef644.js");
  assert.equal(adapter.ORIGINAL_HASHES[adapter.AUTOSCROLL_FILE], autoscroll.ORIGINAL_HASH);
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
  assert.equal(adapter.transformStage(adapter.AUTOSCROLL_FILE, sentinel, "history"), sentinel);
  assert.equal(adapter.transformStage(adapter.AUTOSCROLL_FILE, sentinel, "titles"), sentinel);
  assert.equal(adapter.transformStage(adapter.AUTOSCROLL_FILE, sentinel, "workflow"), sentinel);
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

test("draft stage applies the pinned autoscroll transform only to its target", { skip: !hasInstalled }, () => {
  const autoscroll = require("../../scripts/officialAutoscroll.cjs");
  const source = fs.readFileSync(path.join(INSTALLED, adapter.AUTOSCROLL_FILE), "utf8");
  const drafts = adapter.transformStage(adapter.AUTOSCROLL_FILE, source, "drafts");
  assert.equal(drafts, autoscroll.transform(source));
  assert.equal(adapter.sha256(drafts), autoscroll.PATCHED_HASH);
  assert.ok(drafts.includes("getLastScrollDistanceFromBottomPx"));
});

test("the prior twelve originals and final drafts hashes stay byte-identical", { skip: !hasInstalled }, () => {
  assert.deepEqual(adapter.FILES.slice(0, 12), PRIOR_FILES);
  const manifest = adapter.buildManifest(INSTALLED);
  for (const rel of PRIOR_FILES) {
    assert.equal(manifest.stages.original[rel], PRIOR_ORIGINALS[rel], `original ${rel}`);
    assert.equal(manifest.stages.drafts[rel], PRIOR_DRAFTS[rel], `drafts ${rel}`);
  }
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
  const workDir = path.join(INTEGRATION_ROOT, "adapter-work", "test-generated");
  const report = adapter.verifyTransforms(INSTALLED, workDir);
  for (const rel of adapter.FILES) {
    assert.equal(report[rel].syntax, "ok");
    assert.match(report[rel].patchedSha, /^[0-9a-f]{64}$/);
  }
});

test("thirteen-target engine rejects missing and mixed preload targets without writing", { skip: !hasInstalled }, async (t) => {
  const preload = require("../../scripts/officialPreloadIndex.cjs");
  const fixtureRoot = path.join(INTEGRATION_ROOT, "engine-fixtures");
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
      path.join(process.env.LOCALAPPDATA, "codex-companion", "patches", adapter.SUPPORTED_VERSION, "chunks-v5"),
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

test("thirteen-target engine rejects missing and mixed autoscroll targets without writing", { skip: !hasInstalled }, async (t) => {
  const autoscroll = require("../../scripts/officialAutoscroll.cjs");
  const fixtureRoot = path.join(INTEGRATION_ROOT, "engine-autoscroll-fixtures");
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtureRoot, "engine-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const extDir = path.join(root, "extension");
  fs.cpSync(INSTALLED, extDir, { recursive: true });
  const backupDir = path.join(root, "backup");
  const engine = createEngine(adapter);
  const autoscrollPath = path.join(extDir, ...adapter.AUTOSCROLL_FILE.split("/"));
  const originalBytes = fs.readFileSync(path.join(INSTALLED, ...adapter.AUTOSCROLL_FILE.split("/")));
  const snapshot = () =>
    adapter.FILES.map((rel) => adapter.sha256(fs.readFileSync(path.join(extDir, ...rel.split("/")))));

  fs.rmSync(autoscrollPath);
  const missing = await engine.check({ extDir, backupDir });
  assert.equal(missing.code, "missing-file");
  assert.equal(missing.canInstall, false);
  assert.equal(missing.canRestore, false);
  assert.equal(missing.features.find((f) => f.id === "autoscroll").status, "unverified");

  fs.writeFileSync(autoscrollPath, autoscroll.transform(originalBytes.toString("utf8")));
  const mixed = await engine.check({ extDir, backupDir });
  assert.equal(mixed.state, "mixed");
  assert.equal(mixed.code, "mixed");
  assert.equal(mixed.canInstall, false);
  assert.equal(mixed.canRestore, false);
  assert.equal(fs.existsSync(backupDir), false);
  assert.deepEqual(snapshot(), adapter.FILES.map((rel) =>
    rel === adapter.AUTOSCROLL_FILE
      ? adapter.sha256(autoscroll.transform(originalBytes.toString("utf8")))
      : adapter.ORIGINAL_HASHES[rel]
  ));
});

test("thirteen-target engine rejects missing and mixed composer recovery targets without writing", { skip: !hasInstalled }, async (t) => {
  const composerRecovery = require("../../scripts/officialComposerRecovery.cjs");
  const fixtureRoot = path.join(INTEGRATION_ROOT, "engine-composer-recovery-fixtures");
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtureRoot, "engine-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const extDir = path.join(root, "extension");
  fs.cpSync(INSTALLED, extDir, { recursive: true });
  const backupDir = path.join(root, "backup");
  const engine = createEngine(adapter);
  const composerRecoveryPath = path.join(extDir, ...adapter.COMPOSER_RECOVERY_FILE.split("/"));
  const originalBytes = fs.readFileSync(path.join(INSTALLED, ...adapter.COMPOSER_RECOVERY_FILE.split("/")));
  const snapshot = () =>
    adapter.FILES.map((rel) => adapter.sha256(fs.readFileSync(path.join(extDir, ...rel.split("/")))));

  fs.rmSync(composerRecoveryPath);
  const missing = await engine.check({ extDir, backupDir });
  assert.equal(missing.code, "missing-file");
  assert.equal(missing.canInstall, false);
  assert.equal(missing.canRestore, false);
  assert.equal(missing.features.find((f) => f.id === "composer-recovery").status, "unverified");

  fs.writeFileSync(composerRecoveryPath, composerRecovery.transform(originalBytes.toString("utf8")));
  const mixed = await engine.check({ extDir, backupDir });
  assert.equal(mixed.state, "mixed");
  assert.equal(mixed.code, "mixed");
  assert.equal(mixed.canInstall, false);
  assert.equal(mixed.canRestore, false);
  assert.equal(fs.existsSync(backupDir), false);
  assert.deepEqual(snapshot(), adapter.FILES.map((rel) =>
    rel === adapter.COMPOSER_RECOVERY_FILE
      ? adapter.sha256(composerRecovery.transform(originalBytes.toString("utf8")))
      : adapter.ORIGINAL_HASHES[rel]
  ));
});

test("composer recovery is pinned and only participates in the final stage", { skip: !hasInstalled }, () => {
  const recovery = require("../../scripts/officialComposerRecovery.cjs");
  assert.equal(adapter.COMPOSER_RECOVERY_FILE, recovery.FILE);
  assert.equal(adapter.ORIGINAL_HASHES[recovery.FILE], recovery.ORIGINAL_HASH);
  assert.deepEqual(adapter.FEATURES.find(f => f.id === "composer-recovery"), {id: "composer-recovery", stage: "drafts", files: [recovery.FILE]});
  for (const stage of ["original", "history", "titles", "workflow"]) assert.equal(adapter.transformStage(recovery.FILE, "sentinel", stage), "sentinel");
  const original = fs.readFileSync(path.join(INSTALLED, recovery.FILE), "utf8");
  assert.equal(adapter.transformStage(recovery.FILE, original, "drafts"), recovery.transform(original));
  const prior = require("../../scripts/officialAutoscroll.cjs");
  assert.equal(adapter.sha256(adapter.applyAllStages(prior.FILE, fs.readFileSync(path.join(INSTALLED, prior.FILE), "utf8"))), prior.PATCHED_HASH);
});
