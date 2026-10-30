"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const adapter = require("../../scripts/official261021.cjs");

function harness(options = {}) {
  const handlers = new Map(), store = options.store || new Map(), writes = [];
  let fail = false, blocker = null;
  const context = {
    extension: { packageJSON: { version: options.version || "26.1021.22027" } },
    subscriptions: [],
    workspaceState: {
      get: key => store.get(key),
      update: async (key, value) => {
        if (blocker && key.endsWith("windowNames")) await blocker;
        if (fail && key.endsWith("windowNames")) throw Error("storage unavailable");
        writes.push({ key, value });
        store.set(key, JSON.parse(JSON.stringify(value)));
      }
    }
  };
  const provider = {
    editorPanels: new Map(), subscriptions: [],
    isPanelAlive(panel) { return this.editorPanels.has(panel); },
    findPanelByWebview(view) { return Array.from(this.editorPanels.keys()).find(p => p.webview === view); }
  };
  const vscode = {
    workspace: { name: options.project, workspaceFolders: options.folders || [], isTrusted: options.trusted !== false },
    env: { remoteName: options.remote },
    commands: { registerCommand: (id, handler) => { handlers.set(id, handler); return { dispose() {} }; } }
  };
  const sandbox = vm.createContext({ je: vscode, process: { platform: options.platform || "win32" },
    cR: () => [], console });
  for (const name of ["officialTabStatusV2.js", "officialWindowNames.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../../resources", name), "utf8"), sandbox);
  }
  const workflow = sandbox.__companionWorkflowInstall(provider, context);
  const names = sandbox.__companionWindowNamesInstall(provider, context);
  function panel(uri, route = "/") {
    const value = { title: "Codex", webview: {}, active: false };
    const documentUri = uri == null ? null : { toString: () => uri };
    provider.editorPanels.set(value, { initialRoute: route, __companionDocumentUri: documentUri });
    sandbox.__companionWindowNamesRegister(provider, value, documentUri);
    return value;
  }
  function report(panel, title, thread = "thread-a") {
    const rec = provider.editorPanels.get(panel);
    Object.assign(rec, { __companionTitleText: title, __companionTitleActive: title != null,
      __companionTitleThreadId: title == null ? null : thread, __companionTitleRoute: title == null ? null : "/local/" + thread });
    sandbox.__companionWorkflowBindTitle(provider, panel.webview);
  }
  const windows = () => handlers.get("chatgpt.companion.v1.getWindowNames")();
  const rename = (panel, title, instanceId = workflow.instanceId) => handlers.get("chatgpt.companion.v1.renameWindow")({
    instanceId, panelId: provider.editorPanels.get(panel).__companionWorkflowPanelId, title
  });
  return { provider, workflow, names, sandbox, store, writes, panel, report, windows, rename, handlers,
    failStorage: value => { fail = value; }, block: value => { blocker = value; },
    settle: async () => { if (names) await names.pending; } };
}

test("project names initialize immediately, collapse whitespace and stay pinned across conversations", async () => {
  const f = harness({ project: "  My \n Workspace   " });
  const a = f.panel("codex:/panel?id=a"), b = f.panel("codex:/panel?id=b");
  assert.equal(a.title, "My Workspace"); assert.equal(b.title, "My Workspace");
  f.report(a, "First chat"); f.report(a, "Second chat", "thread-b");
  assert.equal(a.title, "My Workspace"); assert.equal(b.title, "My Workspace");
  assert.equal(f.windows().windows[0].title, "My Workspace");
  const state = f.sandbox.__companionWorkflowTabs(f.workflow);
  assert.equal(state[0].title, "My Workspace");
  await f.settle();
  assert(f.writes.filter(w => w.key.endsWith("windowNames")).every(w => Object.keys(w.value.windows).every(uri => uri.startsWith("codex:/"))));
});

test("fallback uses only the single folder, then stock Codex; automatic title accepts first collapsed 42 characters", async () => {
  assert.equal(harness({ folders: [{ name: " My  Folder " }] }).panel().title, "My Folder");
  assert.equal(harness({ folders: [{ name: "A" }, { name: "B" }] }).panel().title, "Codex");
  const f = harness(), p = f.panel("codex:/panel?id=1");
  f.report(p, "  First\n " + "a".repeat(60));
  const first = "First " + "a".repeat(35) + "…";
  assert.equal(p.title, first); assert.equal(Array.from(first).length, 42);
  f.report(p, "Later title"); assert.equal(p.title, first);
  await f.settle();
});

test("manual names keep internal whitespace and full length; explicit Codex blocks auto naming", async () => {
  const f = harness(), p = f.panel("codex:/panel?id=manual");
  await f.settle();
  const title = "A  manual\n name " + "x".repeat(80);
  assert.equal(await f.rename(p, " " + title + " "), true); assert.equal(p.title, title);
  f.report(p, "Generated chat name"); assert.equal(p.title, title);
  assert.equal(await f.rename(p, " Codex "), true);
  f.report(p, "Should not rename"); assert.equal(p.title, "Codex");
  assert.equal(await f.rename(p, "   "), false);
  assert.equal(await f.rename(p, null), false);
  assert.equal(p.title, "Codex");
});

test("duplicate panels share thread status but retain separate names; route reset clears old status", async () => {
  const f = harness({ project: "Project" }), a = f.panel("codex:/a"), b = f.panel("codex:/b");
  await f.settle(); await f.rename(a, "Window A"); await f.rename(b, "Window B");
  f.report(a, "Chat A"); f.report(b, "Chat A");
  f.workflow.threads["thread-a"].status = "waiting";
  f.sandbox.__companionWorkflowRefreshThreadTitles(f.provider, "thread-a");
  assert.equal(a.title, "[?] Window A"); assert.equal(b.title, "[?] Window B");
  f.report(a, null); assert.equal(a.title, "Window A");
  f.report(a, "Another chat", "thread-b"); assert.equal(a.title, "Window A");
  for (const [status, marker] of [["running", "[~]"], ["done", "[V]"], ["error", "[!]"], ["idle", ""]]) {
    f.workflow.threads["thread-b"].status = status;
    f.sandbox.__companionWorkflowRefreshThreadTitles(f.provider, "thread-b");
    assert.equal(a.title, (marker ? marker + " " : "") + "Window A");
  }
});

test("exact document URI persists over close/reopen and cold restart including query and fragment", async () => {
  const f = harness(), uri = "codex:/chat?panel=1#unique", p = f.panel(uri);
  await f.settle(); await f.rename(p, "Persistent window");
  f.provider.editorPanels.delete(p);
  assert.equal(f.panel(uri).title, "Persistent window");
  const cold = harness({ store: f.store, project: "Other" });
  const restored = cold.panel(uri);
  assert.equal(restored.title, "Persistent window");
  cold.report(restored, "New thread title"); assert.equal(restored.title, "Persistent window");
  assert.equal(cold.panel("codex:/chat?panel=2#unique").title, "Other");
  assert.equal(cold.windows().windows[0].uri, uri);
  const auto = harness(), stock = auto.panel("codex:/stock"); await auto.settle();
  const restoredStock = harness({ store: auto.store }).panel("codex:/stock");
  assert.equal(restoredStock.title, "Codex");
});

test("failed storage preserves old title and userNamed; renames serialize and increment sequence only on success", async () => {
  const f = harness({ project: "Old" }), p = f.panel("codex:/save"); await f.settle();
  f.failStorage(true);
  assert.equal(await f.rename(p, "Rejected"), false); assert.equal(p.title, "Old");
  assert.equal(f.provider.editorPanels.get(p).__companionWindowName.userNamed, false);
  assert.equal(f.workflow.sequence, 0);
  f.failStorage(false);
  let release; f.block(new Promise(resolve => { release = resolve; }));
  const first = f.rename(p, "First"), second = f.rename(p, "Second");
  await Promise.resolve(); assert.equal(p.title, "Old");
  release(); assert.equal(await first, true); assert.equal(await second, true);
  assert.equal(p.title, "Second"); assert.equal(f.workflow.sequence, 2);
  const cold = harness({ store: f.store }); assert.equal(cold.panel("codex:/save").title, "Second");
});

test("stale instances and closed panels cannot rename; changed trust and disposed runtime revoke access", async () => {
  const f = harness(), p = f.panel("codex:/stale"); await f.settle();
  assert.equal(await f.rename(p, "Bad", "previous-instance"), false);
  const id = f.windows().windows[0].panelId; f.provider.editorPanels.delete(p);
  const command = f.handlers.get("chatgpt.companion.v1.renameWindow");
  assert.equal(await command({ instanceId: f.workflow.instanceId, panelId: id, title: "Closed" }), false);
  const fresh = f.panel("codex:/fresh"); await f.settle();
  f.sandbox.je.workspace.isTrusted = false;
  assert.equal(await f.rename(fresh, "Untrusted"), false); assert.equal(f.windows().windows.length, 0);
  f.sandbox.je.workspace.isTrusted = true; f.workflow.disposed = true;
  assert.equal(await f.rename(fresh, "Disposed"), false); assert.equal(f.windows().windows.length, 0);
});

test("native title arriving during a pending manual save cannot overwrite the persisted manual name", async () => {
  const f = harness(), uri = "codex:/manual-race", p = f.panel(uri);
  await f.settle();
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  f.block(new Promise(resolve => { release = resolve; }));
  const update = f.names.context.workspaceState.update;
  f.names.context.workspaceState.update = (key, value) => {
    if (key.endsWith("windowNames")) started();
    return update(key, value);
  };
  const rename = f.rename(p, "Manual remains");
  await entered;
  f.report(p, "Native automatic title");
  assert.equal(p.title, "Native automatic title");
  release();
  assert.equal(await rename, true);
  await f.settle();
  assert.equal(p.title, "Manual remains");
  const persisted = f.store.get("codexCompanion.official.v1.windowNames").windows[uri];
  assert.equal(persisted.title, "Manual remains"); assert.equal(persisted.userNamed, true);
  f.provider.editorPanels.delete(p);
  assert.equal(f.panel(uri).title, "Manual remains");
  const cold = harness({ store: f.store }), restored = cold.panel(uri);
  cold.report(restored, "Later native title");
  assert.equal(restored.title, "Manual remains");
  assert.equal(cold.provider.editorPanels.get(restored).__companionWindowName.userNamed, true);
});

test("special panels are excluded before their owner currentPanel is assigned; transient panels do not acquire fake URI", async () => {
  const f = harness({ project: "Workspace" });
  const diff = f.panel(null, "/diff"), settings = f.panel(null, "/settings"), plan = f.panel(null, "/plan-summary");
  const transient = f.panel(); transient.active = true;
  assert.equal(diff.title, "Codex"); assert.equal(settings.title, "Codex"); assert.equal(plan.title, "Codex");
  const windows = f.windows().windows; assert.equal(windows.length, 1);
  assert.equal(windows[0].uri, null); assert.equal(windows[0].active, true);
  assert.equal(await f.rename(transient, "Session only"), true); await f.settle();
  assert.equal(f.writes.filter(w => w.key.endsWith("windowNames")).length, 0);
});

test("commands install only in trusted local Windows and exact supported official runtime", () => {
  for (const options of [{ trusted: false }, { remote: "wsl" }, { platform: "linux" }, { version: "26.1101" }]) {
    const f = harness(options); assert.equal(f.names, null);
  }
});

const hostFixture = path.join(__dirname, "../../.artifacts/composer-recovery/originals/out/extension.js");
test("modern adapter captures document URI before webview initialization and protects late native previews", { skip: !fs.existsSync(hostFixture) }, () => {
  const original = fs.readFileSync(hostFixture, "utf8");
  const transformed = adapter.applyAllStages(adapter.HOST, original);
  assert(transformed.includes("__companionWorkflowInstall($e,t),__companionWindowNamesInstall($e,t),"));
  assert(transformed.includes("__companionDocumentUri:e.uri}),__companionWindowNamesRegister(this,r,e.uri)"));
  assert(transformed.includes("__companionShouldApplyPreviewTitle(this,r)"));
  assert.equal(adapter.checkSyntaxCjs(transformed, adapter.HOST).ok, true);
});
