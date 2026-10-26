"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const titles = require("../../scripts/patchOfficialTitles.cjs");
const status = require("../../scripts/officialStatusTransform.cjs");

const ROOT = path.resolve(__dirname, "..", "..");
const FIXTURE = path.join(ROOT, ".artifacts", "openai-project-history", "original");
const HOST = status.HOST_FILE;
const C014 = status.C014_FILE;

const materials = titles.buildMaterials(FIXTURE);
const BASE_HOST = materials.titleTexts[HOST];
const BASE_C014 = materials.titleTexts[C014];
const PATCHED_HOST = status.applyStatusTransforms(HOST, BASE_HOST);

// ---------------------------------------------------------------------------
// Core runtime harness
// ---------------------------------------------------------------------------

function createVscode() {
  const handlers = new Map();
  const calls = [];
  const foldersHandlers = [];
  return {
    handlers,
    calls,
    foldersHandlers,
    commands: {
      registerCommand(id, handler) {
        handlers.set(id, handler);
        return {
          dispose() {
            handlers.delete(id);
          },
        };
      },
      executeCommand(id, arg) {
        calls.push({ id, arg });
        return Promise.resolve();
      },
    },
    workspace: {
      onDidChangeWorkspaceFolders(handler) {
        if (typeof handler === "function") foldersHandlers.push(handler);
        return { dispose() {} };
      },
    },
  };
}

function createContext(options = {}) {
  const store = new Map();
  const subscriptions = [];
  const pendingGets = [];
  return {
    store,
    subscriptions,
    pendingGets,
    resolvePendingGets() {
      for (const resolve of pendingGets.splice(0)) resolve();
    },
    workspaceState: {
      get(key) {
        // ExtensionContext.workspaceState is a real synchronous Memento.
        if (options.asyncRestore) {
          return new Promise((resolve) => {
            pendingGets.push(() => resolve(store.get(key)));
          });
        }
        return store.get(key);
      },
      update(key, value) {
        store.set(key, JSON.parse(JSON.stringify(value)));
        return Promise.resolve();
      },
    },
  };
}

function evaluateCore({ je, roots, model }) {
  const source = fs.readFileSync(path.join(ROOT, "resources", "officialTabStatusV2.js"), "utf8");
  // The frozen pure assembler is injected before V2 in the real adapter. Read
  // it at test runtime only; this worker never loads or inspects it.
  const questionHistory = fs.readFileSync(
    path.join(ROOT, "resources", "officialQuestionHistory.js"),
    "utf8"
  );
  const modelSource =
    model === undefined
      ? ""
      : "function __companionWorkflowGetProjectModel(provider){return " + JSON.stringify(model) + ";}";
  const factory = new Function(
    "je",
    "cR",
    "TKe",
    questionHistory +
      "\n" +
      source +
      "\n" +
      modelSource +
      "\nreturn {" +
      "install:__companionWorkflowInstall," +
      "notify:__companionWorkflowNotification," +
      "request:__companionWorkflowRequest," +
      "bind:__companionWorkflowBindTitle," +
      "trackRead:__companionWorkflowTrackRead," +
      "readResponse:__companionWorkflowReadResponse," +
      "forgetRead:__companionWorkflowForgetRead," +
      "forgetWebviewReads:__companionWorkflowForgetWebviewReads," +
      "stateKey:__companionWorkflowStateKey};"
  );
  const rootsProvider = typeof roots === "function" ? roots : () => roots.slice();
  return factory(je, rootsProvider, (value) => (value.length > 30 ? value.slice(0, 30) + "\u2026" : value));
}

function createHarness(options = {}) {
  const je = createVscode();
  const context = createContext(options);
  let roots = (options.roots || ["C:\\Project"]).slice();
  if (options.saved !== undefined) {
    context.store.set("codexCompanion.official.v1.status", JSON.parse(JSON.stringify(options.saved)));
  }
  const api = evaluateCore({ je, roots: () => roots.slice(), model: options.model });
  return {
    je,
    context,
    api,
    get roots() {
      return roots;
    },
    setRoots(next) {
      roots = next.slice();
    },
    resolveRestore: () => context.resolvePendingGets(),
  };
}

function makeProvider() {
  const editorPanels = new Map();
  const webviews = new Map();
  const provider = {
    editorPanels,
    subscriptions: [],
    diffPanel: undefined,
    planSummaryPanel: undefined,
    settingsPanel: undefined,
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
      editorPanels.set(panel, {
        ready: true,
        pendingMessages: [],
        initialRoute: "/local/unknown",
        __companionTitleSeen: false,
        __companionTitleActive: false,
      });
      webviews.set(panel, webview);
      return panel;
    },
    report(panel, webview, threadId, title, route) {
      const rec = editorPanels.get(panel);
      rec.__companionTitleSeen = true;
      rec.__companionTitleActive = true;
      rec.__companionTitleThreadId = threadId;
      rec.__companionTitleRoute = route || "/local/" + threadId;
      rec.__companionTitleText = title;
      panel.title = title;
      return rec;
    },
    reset(panel, webview) {
      const rec = editorPanels.get(panel);
      rec.__companionTitleActive = false;
      rec.__companionTitleThreadId = null;
      rec.__companionTitleRoute = null;
      rec.__companionTitleText = null;
      panel.title = "Codex";
      return rec;
    },
  };
  return provider;
}

function bind(api, provider, panel, webview, threadId, title, route) {
  provider.report(panel, webview, threadId, title, route);
  api.bind(provider, webview);
}

function events(je) {
  return je.calls.filter((call) => call.id === "codexCompanion.official.v1.event").map((call) => call.arg);
}

function statusEvents(je, statusValue) {
  return events(je).filter((event) => event.tab.status === statusValue);
}

function started(turnId, startedAt) {
  return { method: "turn/started", params: { threadId: "t1", turn: { id: turnId, startedAt } } };
}

function completed(turnId, startedAt, terminalStatus) {
  return {
    method: "turn/completed",
    params: { threadId: "t1", turn: { id: turnId, startedAt, status: terminalStatus } },
  };
}

function questionAgentMessage(itemId) {
  return {
    id: itemId,
    type: "agentMessage",
    text: "Which option should I use?",
    phase: null,
    memoryCitation: null,
    delivery: "async",
    questions: [
      {
        title: "Which option should I use?",
        options: ["Option A", "Option B"],
      },
    ],
  };
}

function questionItem(method, turnId, itemId) {
  return {
    method,
    params: { threadId: "t1", turnId, item: questionAgentMessage(itemId) },
  };
}

function userMessageItem(method, turnId, itemId) {
  const digits = String(itemId).replace(/^(answer|prompt)/, "") || "1";
  const questionItemId = JSON.stringify([
    "request_user_input_async",
    "question" + digits,
    0,
  ]);
  const envelope =
    "<send_user_message_question_reply>" +
    JSON.stringify({ questionItemId, question: "Q", answer: "A" }) +
    "</send_user_message_question_reply>";
  return {
    method,
    params: {
      threadId: "t1",
      turnId,
      item: {
        id: itemId,
        type: "userMessage",
        clientId: null,
        content: [{ type: "text", text: envelope, text_elements: [] }],
      },
    },
  };
}

function plainUserMessageItem(method, turnId, itemId, text) {
  return {
    method,
    params: {
      threadId: "t1",
      turnId,
      item: {
        id: itemId,
        type: "userMessage",
        clientId: null,
        content: [{ type: "text", text: text || "ordinary input", text_elements: [] }],
      },
    },
  };
}

function steeringMessageItem(method, turnId, itemId, status, questionItemId) {
  const envelope =
    "<send_user_message_question_reply>" +
    JSON.stringify({ questionItemId, question: "Q", answer: "A" }) +
    "</send_user_message_question_reply>";
  return {
    method,
    params: {
      threadId: "t1",
      turnId,
      item: {
        id: itemId,
        type: "steeringUserMessage",
        status,
        input: [{ type: "text", text: envelope }],
      },
    },
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

function savedText(context, api) {
  const saved = context.store.get(api.stateKey());
  return saved == null ? "" : JSON.stringify(saved);
}

// ---------------------------------------------------------------------------
// Generated seams
// ---------------------------------------------------------------------------

test("status transform only changes the host seams and leaves c014 byte-identical", () => {
  assert.ok(PATCHED_HOST.includes("function __companionWorkflowInstall"));
  assert.ok(PATCHED_HOST.includes("__companionWorkflowInstall(Pe,t),wt=new lL("));
  assert.ok(
    PATCHED_HOST.includes(
      'try{__companionWorkflowNotification(this,F)}catch(_e){}this.broadcastToAllViews({type:"mcp-notification"'
    )
  );
  assert.ok(
    PATCHED_HOST.includes(
      'try{__companionWorkflowRequest(this,F)}catch(_e){}this.broadcastToAllViews({type:"mcp-request"'
    )
  );
  assert.ok(PATCHED_HOST.includes("__companionApplyCompanionTabTitle(this,e,r);try{__companionWorkflowBindTitle(this,e)}"));
  assert.strictEqual(PATCHED_HOST.split("function __companionWorkflowInstall").length - 1, 1);
  assert.strictEqual(status.applyStatusTransforms(C014, BASE_C014), BASE_C014);
});

test("status transform is deterministic, reversible and syntax-valid", () => {
  assert.strictEqual(status.applyStatusTransforms(HOST, BASE_HOST), PATCHED_HOST);

  let reverted = PATCHED_HOST;
  reverted = reverted.replace(status.INSTALL_REPLACEMENT, status.INSTALL_ANCHOR);
  reverted = reverted.replace(status.REQUEST_REPLACEMENT, status.REQUEST_ANCHOR);
  reverted = reverted.replace(status.NOTIFICATION_REPLACEMENT, status.NOTIFICATION_ANCHOR);
  reverted = reverted.replace(status.TITLE_BIND_REPLACEMENT, status.TITLE_BIND_ANCHOR);
  reverted = reverted.replace(
    status.STATUS_CORE_ANCHOR + "\n" + status.loadStatusCoreSource(),
    status.STATUS_CORE_ANCHOR
  );
  assert.strictEqual(reverted, BASE_HOST);

  execFileSync(process.execPath, ["--check"], { input: PATCHED_HOST, stdio: ["pipe", "pipe", "pipe"] });
  execFileSync(process.execPath, ["--input-type=module", "--check"], {
    input: BASE_C014,
    stdio: ["pipe", "pipe", "pipe"],
  });
});

test("status transform refuses missing/duplicate/old baselines", () => {
  assert.throws(
    () => status.applyStatusTransforms(HOST, materials.baselineTexts[HOST]),
    /title baseline is missing/
  );
  assert.throws(() => status.applyStatusTransforms(HOST, PATCHED_HOST), /already present/);
  assert.throws(
    () => status.applyStatusTransforms(HOST, BASE_HOST + BASE_HOST.slice(BASE_HOST.indexOf(status.NOTIFICATION_ANCHOR), BASE_HOST.indexOf(status.NOTIFICATION_ANCHOR) + status.NOTIFICATION_ANCHOR.length)),
    /not unique/
  );
  assert.throws(() => status.applyStatusTransforms("package.json", "{}"), /not a status target/);
});

// ---------------------------------------------------------------------------
// Status graph and titles
// ---------------------------------------------------------------------------

test("working -> done emits exactly once and idle after done keeps [V]", () => {
  const { je, context, api } = createHarness();
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  api.install(provider, context);
  bind(api, provider, panel, { id: "w1" }, "t1", "Alpha");

  api.notify(provider, started("turn1", 10));
  assert.strictEqual(panel.title, "[~] Alpha");
  assert.strictEqual(events(je).length, 1);

  api.notify(provider, started("turn1", 10));
  assert.strictEqual(events(je).length, 1);

  api.notify(provider, completed("turn1", 10, "completed"));
  assert.strictEqual(panel.title, "[V] Alpha");
  assert.strictEqual(statusEvents(je, "done").length, 1);
  assert.strictEqual(statusEvents(je, "done")[0].previousStatus, "running");
  assert.strictEqual(statusEvents(je, "done")[0].live, true);

  api.notify(provider, completed("turn1", 10, "completed"));
  api.notify(provider, { method: "thread/status/changed", params: { threadId: "t1", status: { type: "idle" } } });
  assert.strictEqual(statusEvents(je, "done").length, 1);
  assert.strictEqual(panel.title, "[V] Alpha");
});

test("idle before turn/completed keeps the turn observed and emits one running->done", () => {
  const { je, context, api } = createHarness();
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  api.install(provider, context);
  bind(api, provider, panel, { id: "w1" }, "t1", "Alpha");

  api.notify(provider, started("turn1", 10));
  api.notify(provider, { method: "thread/status/changed", params: { threadId: "t1", status: { type: "idle" } } });
  api.notify(provider, { method: "thread/status/changed", params: { threadId: "t1", status: { type: "idle" } } });
  assert.strictEqual(panel.title, "[~] Alpha");
  assert.strictEqual(statusEvents(je, "idle").length, 0);

  api.notify(provider, completed("turn1", 10, "completed"));
  assert.strictEqual(panel.title, "[V] Alpha");
  assert.strictEqual(statusEvents(je, "done").length, 1);
  assert.strictEqual(statusEvents(je, "done")[0].previousStatus, "running");
  assert.strictEqual(statusEvents(je, "done")[0].tab.turnId, "turn1");
  assert.match(statusEvents(je, "done")[0].eventId, /\|turn1\|/);
  assert.strictEqual(events(je).length, 2);

  api.notify(provider, completed("turn1", 10, "completed"));
  api.notify(provider, { method: "thread/status/changed", params: { threadId: "t1", status: { type: "idle" } } });
  assert.strictEqual(statusEvents(je, "done").length, 1);
  assert.strictEqual(events(je).length, 2);
  assert.strictEqual(panel.title, "[V] Alpha");
});

test("failed and interrupted turns are not successes", () => {
  const { je, context, api } = createHarness();
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  api.install(provider, context);
  bind(api, provider, panel, { id: "w1" }, "t1", "Alpha");

  api.notify(provider, started("turn1", 10));
  api.notify(provider, completed("turn1", 10, "failed"));
  assert.strictEqual(panel.title, "[!] Alpha");
  assert.strictEqual(statusEvents(je, "error").length, 1);
  assert.strictEqual(statusEvents(je, "error")[0].tab.turnId, "turn1");
  assert.strictEqual(statusEvents(je, "done").length, 0);

  api.notify(provider, started("turn2", 20));
  api.notify(provider, { method: "thread/status/changed", params: { threadId: "t1", status: { type: "idle" } } });
  assert.strictEqual(panel.title, "[~] Alpha");
  api.notify(provider, completed("turn2", 20, "interrupted"));
  assert.strictEqual(panel.title, "Alpha");
  assert.strictEqual(statusEvents(je, "idle").length, 1);
  assert.strictEqual(statusEvents(je, "idle")[0].tab.turnId, "turn2");
  assert.strictEqual(statusEvents(je, "done").length, 0);

  api.notify(provider, started("turn3", 30));
  api.notify(provider, completed("turn3", 30, "cancelled"));
  assert.strictEqual(panel.title, "Alpha");
  assert.strictEqual(statusEvents(je, "idle").length, 2);
  assert.strictEqual(statusEvents(je, "idle")[1].tab.turnId, "turn3");
  assert.strictEqual(statusEvents(je, "done").length, 0);
});

test("approval and user-input requests wait, then resolve back to running", () => {
  const { je, context, api } = createHarness();
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  api.install(provider, context);
  bind(api, provider, panel, { id: "w1" }, "t1", "Alpha");
  api.notify(provider, started("turn1", 10));

  api.request(provider, {
    id: "r1",
    method: "item/commandExecution/requestApproval",
    params: { threadId: "t1", turnId: "turn1" },
  });
  assert.strictEqual(panel.title, "[?] Alpha");
  assert.strictEqual(statusEvents(je, "waiting").length, 1);

  api.request(provider, {
    id: "r2",
    method: "item/tool/requestUserInput",
    params: { threadId: "t1", turnId: "turn1" },
  });
  assert.strictEqual(statusEvents(je, "waiting").length, 1);

  api.notify(provider, { method: "serverRequest/resolved", params: { threadId: "t1", requestId: "r1" } });
  assert.strictEqual(panel.title, "[?] Alpha");
  api.notify(provider, { method: "serverRequest/resolved", params: { threadId: "t1", requestId: "r2" } });
  assert.strictEqual(panel.title, "[~] Alpha");
  assert.strictEqual(statusEvents(je, "running").length, 2);
});

test("resolved accepts numeric ids and stale/duplicate resolves cannot clear newer pending work", () => {
  const { je, context, api } = createHarness();
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  api.install(provider, context);
  bind(api, provider, panel, { id: "w1" }, "t1", "Alpha");
  api.notify(provider, started("turn1", 10));

  api.request(provider, {
    id: 101,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "t1", turnId: "turn1" },
  });
  api.request(provider, {
    id: "r2",
    method: "item/tool/requestUserInput",
    params: { threadId: "t1", turnId: "turn1" },
  });
  assert.strictEqual(panel.title, "[?] Alpha");

  api.notify(provider, { method: "serverRequest/resolved", params: { threadId: "t1", requestId: 101 } });
  assert.strictEqual(panel.title, "[?] Alpha");
  api.notify(provider, { method: "serverRequest/resolved", params: { threadId: "t1", requestId: 101 } });
  assert.strictEqual(panel.title, "[?] Alpha");
  api.notify(provider, { method: "serverRequest/resolved", params: { threadId: "t1", requestId: "r2" } });
  assert.strictEqual(panel.title, "[~] Alpha");

  // A new turn clears old request index mappings; resolving the old request
  // must not drop the new turn's pending request.
  api.notify(provider, started("turn2", 20));
  api.request(provider, {
    id: "r3",
    method: "item/commandExecution/requestApproval",
    params: { threadId: "t1", turnId: "turn2" },
  });
  assert.strictEqual(panel.title, "[?] Alpha");
  api.notify(provider, { method: "serverRequest/resolved", params: { threadId: "t1", requestId: 101 } });
  assert.strictEqual(panel.title, "[?] Alpha");
  api.notify(provider, { method: "serverRequest/resolved", params: { threadId: "t1", requestId: "r3" } });
  assert.strictEqual(panel.title, "[~] Alpha");
});

test("thread/status activeFlags drive waiting but idle alone never completes", () => {
  const { je, context, api } = createHarness();
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  api.install(provider, context);
  bind(api, provider, panel, { id: "w1" }, "t1", "Alpha");

  api.notify(provider, {
    method: "thread/status/changed",
    params: { threadId: "t1", status: { type: "active", activeFlags: ["waitingOnApproval"] } },
  });
  assert.strictEqual(panel.title, "[?] Alpha");
  api.notify(provider, {
    method: "thread/status/changed",
    params: { threadId: "t1", status: { type: "active", activeFlags: [] } },
  });
  assert.strictEqual(panel.title, "[~] Alpha");
  api.notify(provider, { method: "thread/status/changed", params: { threadId: "t1", status: { type: "idle" } } });
  assert.strictEqual(panel.title, "Alpha");
  assert.strictEqual(statusEvents(je, "done").length, 0);
});

test("stale completion after a newer turn start is ignored", () => {
  const { je, context, api } = createHarness();
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  api.install(provider, context);
  bind(api, provider, panel, { id: "w1" }, "t1", "Alpha");

  api.notify(provider, started("turn1", 10));
  api.notify(provider, started("turn2", 20));
  api.notify(provider, completed("turn1", 10, "completed"));
  assert.strictEqual(panel.title, "[~] Alpha");
  assert.strictEqual(statusEvents(je, "done").length, 0);

  api.notify(provider, completed("turn2", 20, "completed"));
  assert.strictEqual(panel.title, "[V] Alpha");
  assert.strictEqual(statusEvents(je, "done").length, 1);
});

test("accepted terminals adopt the completed turn id in state and event id", () => {
  const { je, context, api } = createHarness();
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  api.install(provider, context);
  bind(api, provider, panel, { id: "w1" }, "t1", "Alpha");

  api.notify(provider, started("turn1", 10));
  api.notify(provider, completed("turn2", 20, "completed"));
  assert.strictEqual(panel.title, "[V] Alpha");
  assert.strictEqual(statusEvents(je, "done").length, 1);
  assert.strictEqual(statusEvents(je, "done")[0].tab.turnId, "turn2");
  assert.match(statusEvents(je, "done")[0].eventId, /\|turn2\|/);
});

test("a no-start hydrated thread accepts a terminal and adopts its turn id", () => {
  const roots = ["C:\\Project"];
  const saved = {
    version: 1,
    roots,
    threads: {
      t1: { status: "idle", turnId: "turn0", goalStatus: null, completedTurnId: null, updatedAt: 5 },
    },
  };
  const { je, context, api } = createHarness({ roots, saved });
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  api.install(provider, context);
  bind(api, provider, panel, { id: "w1" }, "t1", "Alpha");
  assert.strictEqual(panel.title, "Alpha");

  api.notify(provider, completed("turn2", 20, "completed"));
  assert.strictEqual(panel.title, "[V] Alpha");
  assert.strictEqual(statusEvents(je, "done").length, 1);
  assert.strictEqual(statusEvents(je, "done")[0].tab.turnId, "turn2");
  assert.match(statusEvents(je, "done")[0].eventId, /\|turn2\|/);
});

test("two views of one chat both retitle but emit one logical event", () => {
  const { je, context, api } = createHarness();
  const provider = makeProvider();
  const a = provider.add({ title: "Codex" }, { id: "a" });
  const b = provider.add({ title: "Codex" }, { id: "b" });
  api.install(provider, context);
  bind(api, provider, a, { id: "a" }, "t1", "Alpha");
  bind(api, provider, b, { id: "b" }, "t1", "Alpha");

  api.notify(provider, started("turn1", 10));
  assert.strictEqual(a.title, "[~] Alpha");
  assert.strictEqual(b.title, "[~] Alpha");
  api.notify(provider, completed("turn1", 10, "completed"));
  assert.strictEqual(a.title, "[V] Alpha");
  assert.strictEqual(b.title, "[V] Alpha");
  assert.strictEqual(statusEvents(je, "done").length, 1);

  const state = je.handlers.get("chatgpt.companion.v1.getState")();
  assert.strictEqual(state.tabs.length, 2);
  assert.strictEqual(state.tabs[0].threadId, "t1");
  assert.strictEqual(state.tabs[1].threadId, "t1");
  assert.notStrictEqual(state.tabs[0].panelId, state.tabs[1].panelId);
});

test("unbound completions bind silently and are never replayed as live events", () => {
  const { je, context, api } = createHarness();
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  api.install(provider, context);

  api.notify(provider, started("turn1", 10));
  api.notify(provider, completed("turn1", 10, "completed"));
  assert.strictEqual(events(je).length, 0);
  assert.strictEqual(panel.title, "Codex");

  bind(api, provider, panel, { id: "w1" }, "t1", "Alpha");
  assert.strictEqual(panel.title, "[V] Alpha");
  assert.strictEqual(events(je).length, 0);
  assert.strictEqual(je.handlers.get("chatgpt.companion.v1.getState")().tabs[0].status, "done");

  // Only transitions observed while a panel is bound become live events.
  api.notify(provider, started("turn2", 20));
  assert.strictEqual(panel.title, "[~] Alpha");
  assert.strictEqual(events(je).length, 1);
  api.notify(provider, completed("turn2", 20, "completed"));
  assert.strictEqual(panel.title, "[V] Alpha");
  assert.strictEqual(statusEvents(je, "done").length, 1);
  assert.strictEqual(events(je).length, 2);
});

test("a missing event sink never breaks status tracking or getState", () => {
  const { je, context, api } = createHarness();
  je.commands.executeCommand = (id) => {
    if (id === "codexCompanion.official.v1.event") throw new Error("command not found");
    return Promise.resolve();
  };
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  api.install(provider, context);
  bind(api, provider, panel, { id: "w1" }, "t1", "Alpha");
  api.notify(provider, started("turn1", 10));
  api.notify(provider, completed("turn1", 10, "completed"));
  assert.strictEqual(panel.title, "[V] Alpha");
  assert.strictEqual(je.handlers.get("chatgpt.companion.v1.getState")().tabs[0].status, "done");
});

test("rename while marked keeps the marker; switching chats drops the old status", () => {
  const { je, context, api } = createHarness();
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  api.install(provider, context);
  bind(api, provider, panel, { id: "w1" }, "t1", "Alpha");
  api.notify(provider, started("turn1", 10));

  provider.report(panel, { id: "w1" }, "t1", "Renamed");
  api.bind(provider, { id: "w1" });
  assert.strictEqual(panel.title, "[~] Renamed");

  provider.report(panel, { id: "w1" }, "t2", "Beta");
  api.bind(provider, { id: "w1" });
  assert.strictEqual(panel.title, "Beta");
  api.notify(provider, completed("turn1", 10, "completed"));
  assert.strictEqual(panel.title, "Beta");
  assert.strictEqual(events(je).filter((event) => event.tab.threadId === "t1" && event.tab.status === "done").length, 0);

  provider.reset(panel, { id: "w1" });
  api.bind(provider, { id: "w1" });
  assert.strictEqual(panel.title, "Codex");
  assert.strictEqual(je.handlers.get("chatgpt.companion.v1.getState")().tabs[0].threadId, null);
});

test("sync Memento restore composes titles; stale running/waiting become idle", async () => {
  const roots = ["C:\\Project"];
  const saved = {
    version: 1,
    roots,
    threads: {
      t1: { status: "done", turnId: "turn1", goalStatus: null, completedTurnId: "turn1", updatedAt: 10 },
      t2: { status: "running", turnId: "turn2", goalStatus: null, completedTurnId: null, updatedAt: 11 },
      t3: { status: "waiting", turnId: "turn3", goalStatus: null, completedTurnId: null, updatedAt: 12 },
      t4: { status: "error", turnId: "turn4", goalStatus: null, completedTurnId: null, updatedAt: 13 },
    },
  };
  const { je, context, api } = createHarness({ roots, saved });
  const provider = makeProvider();
  const a = provider.add({ title: "Codex" }, { id: "a" });
  const b = provider.add({ title: "Codex" }, { id: "b" });
  const c = provider.add({ title: "Codex" }, { id: "c" });
  const d = provider.add({ title: "Codex" }, { id: "d" });
  api.install(provider, context);
  await flush();
  bind(api, provider, a, { id: "a" }, "t1", "Alpha");
  bind(api, provider, b, { id: "b" }, "t2", "Beta");
  bind(api, provider, c, { id: "c" }, "t3", "Gamma");
  bind(api, provider, d, { id: "d" }, "t4", "Delta");
  assert.strictEqual(a.title, "[V] Alpha");
  assert.strictEqual(b.title, "Beta");
  assert.strictEqual(c.title, "Gamma");
  assert.strictEqual(d.title, "[!] Delta");
  assert.strictEqual(events(je).length, 0);
  const tabs = je.handlers.get("chatgpt.companion.v1.getState")().tabs;
  assert.deepStrictEqual(
    tabs.map((tab) => [tab.status, tab.turnId]),
    [
      ["done", "turn1"],
      ["idle", "turn2"],
      ["idle", "turn3"],
      ["error", "turn4"],
    ]
  );

  // Foreign project roots must not be applied.
  const other = createHarness({ roots: ["C:\\Other"], saved });
  const foreignProvider = makeProvider();
  const foreign = foreignProvider.add({ title: "Codex" }, { id: "f" });
  other.api.install(foreignProvider, other.context);
  await flush();
  bind(other.api, foreignProvider, foreign, { id: "f" }, "t1", "Alpha");
  assert.strictEqual(foreign.title, "Alpha");
  assert.strictEqual(events(other.je).length, 0);
});

test("async restore cannot overwrite a newer native live turn", async () => {
  const roots = ["C:\\Project"];
  const saved = {
    version: 1,
    roots,
    threads: {
      t1: { status: "done", turnId: "turn0", goalStatus: null, completedTurnId: "turn0", updatedAt: 5 },
    },
  };
  const { je, context, api, resolveRestore } = createHarness({ roots, saved, asyncRestore: true });
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  api.install(provider, context);
  bind(api, provider, panel, { id: "w1" }, "t1", "Alpha");
  assert.strictEqual(panel.title, "Alpha");

  api.notify(provider, started("turn1", 10));
  assert.strictEqual(panel.title, "[~] Alpha");
  assert.strictEqual(events(je).length, 1);

  resolveRestore();
  await flush();
  assert.strictEqual(panel.title, "[~] Alpha");
  const tab = je.handlers.get("chatgpt.companion.v1.getState")().tabs[0];
  assert.strictEqual(tab.status, "running");
  assert.strictEqual(tab.turnId, "turn1");
  assert.strictEqual(events(je).length, 1);

  api.notify(provider, completed("turn1", 10, "completed"));
  assert.strictEqual(panel.title, "[V] Alpha");
  assert.strictEqual(statusEvents(je, "done").length, 1);
});

test("getState/focusTab accept only known tabs and command disposables clean up", () => {
  const { je, context, api } = createHarness({ model: { model: "gpt-5.1-codex", effort: "high" } });
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex", reveal() {} }, { id: "w1" });
  let revealed = 0;
  panel.reveal = () => {
    revealed += 1;
  };
  api.install(provider, context);
  bind(api, provider, panel, { id: "w1" }, "t1", "Alpha");

  const state = je.handlers.get("chatgpt.companion.v1.getState")();
  assert.strictEqual(state.apiVersion, 1);
  assert.deepStrictEqual(state.capabilities, { statuses: true, projectModel: true });
  assert.deepStrictEqual(state.projectModel, { model: "gpt-5.1-codex", effort: "high" });
  assert.strictEqual(state.tabs[0].title, "Alpha");
  assert.strictEqual(state.tabs[0].route, "/local/t1");

  const focus = je.handlers.get("chatgpt.companion.v1.focusTab");
  assert.strictEqual(focus({ panelId: state.tabs[0].panelId, threadId: "t1" }), true);
  assert.strictEqual(revealed, 1);
  assert.strictEqual(focus({ threadId: "t2" }), false);
  assert.strictEqual(focus({ panelId: "nope" }), false);
  assert.strictEqual(focus({}), false);

  for (const disposable of context.subscriptions) disposable.dispose();
  assert.strictEqual(je.handlers.size, 0);
});

test("active goals suppress done until the goal completes once", () => {
  const { je, context, api } = createHarness();
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  api.install(provider, context);
  bind(api, provider, panel, { id: "w1" }, "t1", "Alpha");
  api.notify(provider, started("turn1", 10));
  api.notify(provider, {
    method: "thread/goal/updated",
    params: { threadId: "t1", goal: { status: "active", updatedAt: 10 } },
  });
  api.notify(provider, completed("turn1", 10, "completed"));
  assert.strictEqual(panel.title, "[~] Alpha");
  assert.strictEqual(statusEvents(je, "done").length, 0);

  api.notify(provider, {
    method: "thread/goal/updated",
    params: { threadId: "t1", goal: { status: "complete", updatedAt: 11 } },
  });
  assert.strictEqual(panel.title, "[V] Alpha");
  assert.strictEqual(statusEvents(je, "done").length, 1);
  api.notify(provider, {
    method: "thread/goal/updated",
    params: { threadId: "t1", goal: { status: "complete", updatedAt: 12 } },
  });
  assert.strictEqual(statusEvents(je, "done").length, 1);
});

// ---------------------------------------------------------------------------
// Async questions (agentMessage.questions) and pending precedence
// ---------------------------------------------------------------------------

test("async question start/completed is deduped and waits through flags, idle and successful terminal", () => {
  const { je, context, api } = createHarness();
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  api.install(provider, context);
  bind(api, provider, panel, { id: "w1" }, "t1", "Alpha");

  api.notify(provider, started("turn1", 10));
  api.notify(provider, questionItem("item/started", "turn1", "question1"));
  assert.strictEqual(panel.title, "[?] Alpha");
  assert.strictEqual(statusEvents(je, "waiting").length, 1);

  api.notify(provider, questionItem("item/started", "turn1", "question1"));
  api.notify(provider, questionItem("item/completed", "turn1", "question1"));
  assert.strictEqual(statusEvents(je, "waiting").length, 1);
  assert.strictEqual(statusEvents(je, "done").length, 0);

  api.notify(provider, {
    method: "thread/status/changed",
    params: { threadId: "t1", status: { type: "active", activeFlags: [] } },
  });
  assert.strictEqual(panel.title, "[?] Alpha");
  api.notify(provider, {
    method: "thread/status/changed",
    params: { threadId: "t1", status: { type: "idle" } },
  });
  assert.strictEqual(panel.title, "[?] Alpha");

  api.notify(provider, completed("turn1", 10, "completed"));
  assert.strictEqual(panel.title, "[?] Alpha");
  assert.strictEqual(statusEvents(je, "waiting").length, 1);
  assert.strictEqual(statusEvents(je, "done").length, 0);
  assert.strictEqual(je.handlers.get("chatgpt.companion.v1.getState")().tabs[0].status, "waiting");

  const runtime = provider.__companionWorkflowRuntime;
  assert.strictEqual(runtime.threads.t1.pendingCount, 0);
  assert.strictEqual(runtime.threads.t1.asyncQuestionCount, 1);
  const saved = JSON.stringify(context.store.get(api.stateKey()));
  assert.ok(!saved.includes("Which option should I use?"));
  assert.ok(!saved.includes("Option A"));
  assert.ok(!saved.includes("questions"));
});

test("completed-first async question survives goal clearing and a user response removes the card once", () => {
  const { je, context, api } = createHarness();
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  api.install(provider, context);
  bind(api, provider, panel, { id: "w1" }, "t1", "Alpha");

  api.notify(provider, started("turn1", 10));
  api.notify(provider, questionItem("item/completed", "turn1", "question1"));
  assert.strictEqual(panel.title, "[?] Alpha");
  api.notify(provider, completed("turn1", 10, "completed"));
  assert.strictEqual(panel.title, "[?] Alpha");
  assert.strictEqual(statusEvents(je, "done").length, 0);

  api.notify(provider, {
    method: "serverRequest/resolved",
    params: { threadId: "t1", requestId: "unrelated" },
  });
  api.notify(provider, { method: "thread/goal/cleared", params: { threadId: "t1" } });
  assert.strictEqual(panel.title, "[?] Alpha");
  assert.strictEqual(statusEvents(je, "done").length, 0);

  api.notify(provider, userMessageItem("item/started", "turn1", "answer1"));
  assert.strictEqual(panel.title, "[V] Alpha");
  assert.strictEqual(statusEvents(je, "done").length, 1);
  assert.strictEqual(statusEvents(je, "waiting").length, 1);

  api.notify(provider, questionItem("item/completed", "turn1", "question1"));
  assert.strictEqual(panel.title, "[V] Alpha");
  assert.strictEqual(statusEvents(je, "done").length, 1);
  assert.strictEqual(statusEvents(je, "waiting").length, 1);
});

test("a user message seen before its question cannot clear that question on a late completion", () => {
  const { je, context, api } = createHarness();
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  api.install(provider, context);
  bind(api, provider, panel, { id: "w1" }, "t1", "Alpha");

  api.notify(provider, started("turn1", 10));
  api.notify(provider, plainUserMessageItem("item/started", "turn1", "prompt1", "Original prompt"));
  api.notify(provider, questionItem("item/started", "turn1", "question1"));
  assert.strictEqual(panel.title, "[?] Alpha");

  api.notify(provider, plainUserMessageItem("item/completed", "turn1", "prompt1", "Original prompt"));
  assert.strictEqual(panel.title, "[?] Alpha");
  api.notify(provider, questionItem("item/completed", "turn1", "question1"));
  assert.strictEqual(panel.title, "[?] Alpha");

  api.notify(provider, { method: "thread/status/changed", params: { threadId: "t1", status: { type: "idle" } } });
  assert.strictEqual(panel.title, "[?] Alpha");
  api.notify(provider, userMessageItem("item/started", "turn1", "answer1"));
  assert.strictEqual(panel.title, "[~] Alpha");
  assert.strictEqual(statusEvents(je, "done").length, 0);
});

test("stale question items from an older turn are ignored and a new turn clears the card", () => {
  const { je, context, api } = createHarness();
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  api.install(provider, context);
  bind(api, provider, panel, { id: "w1" }, "t1", "Alpha");

  api.notify(provider, started("turn1", 10));
  api.notify(provider, questionItem("item/started", "turn1", "question1"));
  assert.strictEqual(panel.title, "[?] Alpha");

  api.notify(provider, started("turn2", 20));
  assert.strictEqual(panel.title, "[~] Alpha");
  api.notify(provider, questionItem("item/completed", "turn1", "question1"));
  api.notify(provider, userMessageItem("item/started", "turn1", "answer1"));
  assert.strictEqual(panel.title, "[~] Alpha");

  api.notify(provider, questionItem("item/started", "turn2", "question2"));
  assert.strictEqual(panel.title, "[?] Alpha");
  api.notify(provider, userMessageItem("item/started", "turn2", "answer2"));
  assert.strictEqual(panel.title, "[~] Alpha");

  const runtime = provider.__companionWorkflowRuntime;
  assert.strictEqual(runtime.threads.t1.asyncQuestionCount, 0);
  assert.strictEqual(runtime.threads.t1.turnId, "turn2");
  assert.strictEqual(statusEvents(je, "done").length, 0);
});

test("failed and interrupted terminals settle async questions and duplicates cannot resurrect them", () => {
  const { je, context, api } = createHarness();
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  api.install(provider, context);
  bind(api, provider, panel, { id: "w1" }, "t1", "Alpha");

  api.notify(provider, started("turn1", 10));
  api.notify(provider, questionItem("item/started", "turn1", "question1"));
  assert.strictEqual(panel.title, "[?] Alpha");
  api.notify(provider, completed("turn1", 10, "failed"));
  assert.strictEqual(panel.title, "[!] Alpha");
  assert.strictEqual(statusEvents(je, "error").length, 1);
  const waitingBeforeDuplicates = statusEvents(je, "waiting").length;
  api.notify(provider, questionItem("item/started", "turn1", "question1"));
  api.notify(provider, questionItem("item/completed", "turn1", "question1"));
  assert.strictEqual(panel.title, "[!] Alpha");
  assert.strictEqual(statusEvents(je, "waiting").length, waitingBeforeDuplicates);

  api.notify(provider, started("turn2", 20));
  api.notify(provider, questionItem("item/started", "turn2", "question2"));
  assert.strictEqual(panel.title, "[?] Alpha");
  api.notify(provider, completed("turn2", 20, "interrupted"));
  assert.strictEqual(panel.title, "Alpha");
  assert.strictEqual(statusEvents(je, "idle").length, 1);
  api.notify(provider, questionItem("item/completed", "turn2", "question2"));
  assert.strictEqual(panel.title, "Alpha");
  assert.strictEqual(statusEvents(je, "idle").length, 1);
});

test("sync pending survives empty active flags and idle, and an async answer leaves it pending", () => {
  const { je, context, api } = createHarness();
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  api.install(provider, context);
  bind(api, provider, panel, { id: "w1" }, "t1", "Alpha");

  api.notify(provider, started("turn1", 10));
  api.request(provider, {
    id: "r1",
    method: "item/tool/requestUserInput",
    params: { threadId: "t1", turnId: "turn1" },
  });
  assert.strictEqual(panel.title, "[?] Alpha");

  api.notify(provider, {
    method: "thread/status/changed",
    params: { threadId: "t1", status: { type: "active", activeFlags: [] } },
  });
  assert.strictEqual(panel.title, "[?] Alpha");
  api.notify(provider, {
    method: "thread/status/changed",
    params: { threadId: "t1", status: { type: "idle" } },
  });
  assert.strictEqual(panel.title, "[?] Alpha");

  api.notify(provider, questionItem("item/started", "turn1", "question1"));
  api.notify(provider, userMessageItem("item/started", "turn1", "answer1"));
  assert.strictEqual(panel.title, "[?] Alpha");
  const runtime = provider.__companionWorkflowRuntime;
  assert.strictEqual(runtime.threads.t1.pendingCount, 1);
  assert.strictEqual(runtime.threads.t1.asyncQuestionCount, 0);

  api.notify(provider, {
    method: "serverRequest/resolved",
    params: { threadId: "t1", requestId: "r1" },
  });
  assert.strictEqual(panel.title, "[~] Alpha");
  assert.strictEqual(statusEvents(je, "waiting").length, 1);
});

test("successful terminal clears sync pending while an async card keeps waiting", () => {
  const { je, context, api } = createHarness();
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  api.install(provider, context);
  bind(api, provider, panel, { id: "w1" }, "t1", "Alpha");

  api.notify(provider, started("turn1", 10));
  api.request(provider, {
    id: "r1",
    method: "item/commandExecution/requestApproval",
    params: { threadId: "t1", turnId: "turn1" },
  });
  api.notify(provider, questionItem("item/started", "turn1", "question1"));
  assert.strictEqual(panel.title, "[?] Alpha");

  api.notify(provider, completed("turn1", 10, "completed"));
  assert.strictEqual(panel.title, "[?] Alpha");
  assert.strictEqual(statusEvents(je, "done").length, 0);
  const runtime = provider.__companionWorkflowRuntime;
  assert.strictEqual(runtime.threads.t1.pendingCount, 0);
  assert.strictEqual(runtime.threads.t1.asyncQuestionCount, 1);

  api.notify(provider, {
    method: "serverRequest/resolved",
    params: { threadId: "t1", requestId: "r1" },
  });
  assert.strictEqual(panel.title, "[?] Alpha");

  api.notify(provider, userMessageItem("item/started", "turn1", "answer1"));
  assert.strictEqual(panel.title, "[V] Alpha");
  assert.strictEqual(statusEvents(je, "done").length, 1);
});

test("free-text agent messages and empty question arrays are not guessed as questions", () => {
  const { je, context, api } = createHarness();
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  api.install(provider, context);
  bind(api, provider, panel, { id: "w1" }, "t1", "Alpha");

  api.notify(provider, started("turn1", 10));
  api.notify(provider, {
    method: "item/started",
    params: {
      threadId: "t1",
      turnId: "turn1",
      item: { id: "message1", type: "agentMessage", text: "Which option? 1) A 2) B" },
    },
  });
  api.notify(provider, {
    method: "item/completed",
    params: {
      threadId: "t1",
      turnId: "turn1",
      item: { id: "message2", type: "agentMessage", text: "No question", questions: [] },
    },
  });
  assert.strictEqual(panel.title, "[~] Alpha");
  assert.strictEqual(statusEvents(je, "waiting").length, 0);

  api.notify(provider, completed("turn1", 10, "completed"));
  assert.strictEqual(panel.title, "[V] Alpha");
  assert.strictEqual(statusEvents(je, "done").length, 1);
  assert.strictEqual(statusEvents(je, "waiting").length, 0);
});

// ---------------------------------------------------------------------------
// Host-only hydration from observed thread/read
// ---------------------------------------------------------------------------

function readRequest(id, threadId, includeTurns) {
  return { id, method: "thread/read", params: { threadId, includeTurns } };
}

function readThread(threadId, status, turns) {
  const thread = { id: threadId, hostId: "local", status };
  if (turns !== undefined) thread.turns = turns;
  return thread;
}

function readResponse(id, thread) {
  return { id, result: thread == null ? null : { thread }, error: null };
}

function tracked(api, provider, webview, id, threadId, includeTurns) {
  return api.trackRead(provider, webview, readRequest(id, threadId, includeTurns));
}

function snapshotEvents(je) {
  return events(je).filter((event) => event.live === false);
}

function hydrationHarness(options) {
  const h = createHarness(options);
  h.provider = makeProvider();
  h.webview = { id: "w1" };
  h.panel = h.provider.add({ title: "Codex" }, h.webview);
  h.api.install(h.provider, h.context);
  bind(h.api, h.provider, h.panel, h.webview, "t1", "Alpha");
  h.read = (id, status, turns) => {
    tracked(h.api, h.provider, h.webview, id, "t1", true);
    return h.api.readResponse(h.provider, h.webview, readResponse(id, readThread("t1", status, turns)));
  };
  return h;
}

test("a newer concurrent read can still apply after the older read finishes", () => {
  const h = hydrationHarness();
  tracked(h.api, h.provider, h.webview, "old", "t1", false);
  tracked(h.api, h.provider, h.webview, "new", "t1", false);
  assert.strictEqual(h.api.readResponse(h.provider, h.webview, readResponse("old", readThread("t1", {type:"active",activeFlags:[]}))), true);
  assert.strictEqual(h.api.readResponse(h.provider, h.webview, readResponse("new", readThread("t1", {type:"active",activeFlags:["waitingOnApproval"]}))), true);
  assert.strictEqual(h.panel.title, "[?] Alpha");
  assert(events(h.je).every(event => event.live === false));
});

test("a terminal observed before a read also rejects the same turn's stale active snapshot", () => {
  for (const runtimeType of ["active", "idle"]) {
    const h = hydrationHarness();
    h.api.notify(h.provider, started("turn1", 10));
    h.api.notify(h.provider, completed("turn1", 10, "completed"));
    assert.strictEqual(h.read("stale",{type:runtimeType,activeFlags:[]},[{id:"turn1",status:"inProgress",startedAt:10,items:[]}]),false);
    assert.strictEqual(h.panel.title,"[V] Alpha");
  }
});

test("a persisted completed turn also wins a stale inProgress read after restart", () => {
  const h=hydrationHarness({saved:{version:1,roots:["C:\\Project"],threads:{t1:{status:"done",turnId:"turn1",completedTurnId:"turn1",updatedAt:10}}}});
  assert.strictEqual(h.panel.title,"[V] Alpha");
  assert.strictEqual(h.read("unloaded-restart",{type:"idle"},[{id:"turn1",status:"completed",startedAt:10,itemsView:"notLoaded",items:[]}]),false);
  assert.strictEqual(h.panel.title,"[V] Alpha");
  assert.strictEqual(h.read("stale-restart",{type:"active",activeFlags:[]},[{id:"turn1",status:"inProgress",startedAt:10,items:[]}]),false);
  assert.strictEqual(h.panel.title,"[V] Alpha");
});

test("hydration respects an unfinished goal and ignores malformed or unloaded history", () => {
  const h=hydrationHarness();
  h.api.notify(h.provider,{method:"thread/goal/updated",params:{threadId:"t1",goal:{status:"active"}}});
  assert.strictEqual(h.read("goal",{type:"idle"},[{id:"turn1",status:"completed",startedAt:10,items:[]}]),true);
  assert.strictEqual(h.panel.title,"[~] Alpha");
  assert.strictEqual(h.provider.__companionWorkflowRuntime.threads.t1.doneEmittedFor,null);
  assert.strictEqual(h.read("bad-tail",{type:"idle"},[{id:"turn1",status:"completed",startedAt:10},{}]),false);
  const unknown=hydrationHarness();
  unknown.read("unloaded",{type:"idle"},[{id:"turn1",status:"completed",startedAt:10,itemsView:"notLoaded",items:[]}]);
  assert.strictEqual(unknown.panel.title,"Alpha");
  assert.strictEqual(statusEvents(h.je,"done").length,0);
});

test("hydration matches individual question replies and ignores unrelated or rejected input", () => {
  const h=hydrationHarness();
  const question={id:"m1",type:"agentMessage",questions:[{title:"One"},{title:"Two"}]};
  const reply=index=>({id:"r"+index,type:"userMessage",content:[{type:"text",text:"<send_user_message_question_reply>"+JSON.stringify({questionItemId:JSON.stringify(["request_user_input_async","m1",index]),question:"Q",answer:"A"})+"</send_user_message_question_reply>"}]});
  const turn=items=>[{id:"turn1",status:"inProgress",startedAt:10,items}];
  h.read("one",{type:"idle"},turn([question,reply(0)]));assert.strictEqual(h.panel.title,"[?] Alpha");
  h.read("unrelated",{type:"idle"},turn([question,{id:"u",type:"userMessage",content:[{type:"text",text:"unrelated"}]},{...reply(1),type:"steeringUserMessage",status:"rejected",input:reply(1).content}]));
  assert.strictEqual(h.panel.title,"[?] Alpha");
  const wrapped=reply(1);wrapped.content[0].text="Editor context\n## My request:\n"+wrapped.content[0].text;
  h.read("both",{type:"idle"},turn([question,reply(0),wrapped]));assert.strictEqual(h.panel.title,"[~] Alpha");
  assert(!savedText(h.context,h.api).includes("questionItemId"));
});

test("includeTurns:false restores active flags and systemError but never turn status", () => {
  const { je, context, api } = createHarness();
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  const webview = { id: "w1" };
  api.install(provider, context);
  bind(api, provider, panel, webview, "t1", "Alpha");

  const info = tracked(api, provider, webview, "r1", "t1", false);
  assert.deepStrictEqual(
    { threadId: info.threadId, requestSeq: info.requestSeq, includeTurns: info.includeTurns },
    { threadId: "t1", requestSeq: 1, includeTurns: false }
  );
  assert.strictEqual(
    api.trackRead(provider, webview, { id: "list1", method: "thread/list", params: { threadId: "t1" } }),
    null
  );
  assert.strictEqual(
    api.trackRead(provider, webview, { id: "read-no-thread", method: "thread/read", params: {} }),
    null
  );
  assert.strictEqual(
    api.readResponse(provider, webview, readResponse("r1", readThread("t1", { type: "active", activeFlags: [] }))),
    true
  );
  assert.strictEqual(panel.title, "[~] Alpha");
  assert.strictEqual(events(je).length, 1);
  assert.strictEqual(events(je)[0].live, false);
  assert.strictEqual(events(je)[0].tab.status, "running");
  assert.strictEqual(provider.__companionWorkflowRuntime.threads.t1.pendingCount, 0);

  tracked(api, provider, webview, "r2", "t1", false);
  assert.strictEqual(
    api.readResponse(
      provider,
      webview,
      readResponse("r2", readThread("t1", { type: "active", activeFlags: ["waitingOnUserInput"] }))
    ),
    true
  );
  assert.strictEqual(panel.title, "[?] Alpha");
  assert.strictEqual(snapshotEvents(je).length, 2);

  tracked(api, provider, webview, "r3", "t1", false);
  assert.strictEqual(
    api.readResponse(provider, webview, readResponse("r3", readThread("t1", { type: "systemError" }))),
    true
  );
  assert.strictEqual(panel.title, "[!] Alpha");
  assert.strictEqual(snapshotEvents(je).length, 3);

  const before = events(je).length;
  tracked(api, provider, webview, "r4", "t1", false);
  assert.strictEqual(
    api.readResponse(
      provider,
      webview,
      readResponse("r4", readThread("t1", { type: "idle" }, [{ id: "turn9", status: "completed", startedAt: 9 }]))
    ),
    false
  );
  assert.strictEqual(panel.title, "[!] Alpha");
  assert.strictEqual(events(je).length, before);
  assert.strictEqual(provider.__companionWorkflowRuntime.readCount, 0);
});

test("full turns hydrate inProgress, completed, failed and interrupted", () => {
  const { je, context, api } = createHarness();
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  const webview = { id: "w1" };
  api.install(provider, context);
  bind(api, provider, panel, webview, "t1", "Alpha");
  const runtime = provider.__companionWorkflowRuntime;

  tracked(api, provider, webview, "r1", "t1", true);
  assert.strictEqual(
    api.readResponse(
      provider,
      webview,
      readResponse("r1", readThread("t1", { type: "idle" }, [{ id: "turn1", status: "inProgress", startedAt: 10 }]))
    ),
    true
  );
  assert.strictEqual(panel.title, "[~] Alpha");
  assert.strictEqual(runtime.threads.t1.turnActive, true);
  assert.strictEqual(runtime.threads.t1.turnId, "turn1");

  tracked(api, provider, webview, "r2", "t1", true);
  assert.strictEqual(
    api.readResponse(
      provider,
      webview,
      readResponse("r2", readThread("t1", { type: "idle" }, [{ id: "turn1", status: "completed", startedAt: 10, items: [] }]))
    ),
    true
  );
  assert.strictEqual(panel.title, "[V] Alpha");
  assert.strictEqual(runtime.threads.t1.doneEmittedFor, "turn1");
  const snapshotDone = snapshotEvents(je).filter((event) => event.tab.status === "done");
  assert.strictEqual(snapshotDone.length, 1);
  assert.strictEqual(
    events(je).filter((event) => event.live !== false && event.tab.status === "done").length,
    0,
    "hydration never publishes a live done"
  );

  // A late duplicate terminal for the hydrated turn must stay silent.
  const beforeDuplicate = events(je).length;
  api.notify(provider, completed("turn1", 10, "completed"));
  assert.strictEqual(panel.title, "[V] Alpha");
  assert.strictEqual(events(je).length, beforeDuplicate);

  tracked(api, provider, webview, "r3", "t1", true);
  assert.strictEqual(
    api.readResponse(
      provider,
      webview,
      readResponse("r3", readThread("t1", { type: "idle" }, [{ id: "turn2", status: "failed", startedAt: 20, items: [] }]))
    ),
    true
  );
  assert.strictEqual(panel.title, "[!] Alpha");

  tracked(api, provider, webview, "r4", "t1", true);
  assert.strictEqual(
    api.readResponse(
      provider,
      webview,
      readResponse("r4", readThread("t1", { type: "idle" }, [{ id: "turn3", status: "interrupted", startedAt: 30, items: [] }]))
    ),
    true
  );
  assert.strictEqual(panel.title, "Alpha");
  assert.strictEqual(runtime.threads.t1.turnActive, false);

  tracked(api, provider, webview, "r5", "t1", true);
  assert.strictEqual(
    api.readResponse(
      provider,
      webview,
      readResponse("r5", readThread("t1", { type: "idle" }, [{ id: "turn4", status: "cancelled", startedAt: 40, items: [] }]))
    ),
    true
  );
  assert.strictEqual(panel.title, "Alpha");
});

test("in-progress questions wait, later user messages settle, completed questions never become done", () => {
  const { je, context, api } = createHarness();
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  const webview = { id: "w1" };
  api.install(provider, context);
  bind(api, provider, panel, webview, "t1", "Alpha");
  const runtime = provider.__companionWorkflowRuntime;
  const question = {
    id: "m1",
    type: "agentMessage",
    text: "Which option should I use?",
    questions: [{ title: "Which option should I use?", options: ["Option A", "Option B"] }],
  };
  const answer = {
    id: "a1",
    type: "userMessage",
    content: [{ type: "text", text: "<send_user_message_question_reply>\n" + JSON.stringify({questionItemId: JSON.stringify(["request_user_input_async", "m1", 0]),question:"Which option should I use?",answer:"Option A"}) + "\n</send_user_message_question_reply>" }],
  };

  tracked(api, provider, webview, "r1", "t1", true);
  assert.strictEqual(
    api.readResponse(
      provider,
      webview,
      readResponse("r1", readThread("t1", { type: "idle" }, [
        { id: "turn1", status: "inProgress", startedAt: 10, items: [question] },
      ]))
    ),
    true
  );
  assert.strictEqual(panel.title, "[?] Alpha");
  assert.strictEqual(runtime.threads.t1.asyncQuestionCount, 1);
  assert.strictEqual(runtime.threads.t1.pendingCount, 0);
  assert.ok(!savedText(context, api).includes("Which option should I use?"));
  assert.ok(!savedText(context, api).includes("Option A"));
  assert.ok(!savedText(context, api).includes("questions"));

  tracked(api, provider, webview, "r2", "t1", true);
  assert.strictEqual(
    api.readResponse(
      provider,
      webview,
      readResponse("r2", readThread("t1", { type: "idle" }, [
        { id: "turn1", status: "inProgress", startedAt: 10, items: [question, answer] },
      ]))
    ),
    true
  );
  assert.strictEqual(panel.title, "[~] Alpha");
  assert.strictEqual(runtime.threads.t1.asyncQuestionCount, 0);
  assert.strictEqual(Object.keys(runtime.requests).length, 0);

  // A prompt before the question does not settle it.
  tracked(api, provider, webview, "r3", "t1", true);
  assert.strictEqual(
    api.readResponse(
      provider,
      webview,
      readResponse("r3", readThread("t1", { type: "idle" }, [
        {
          id: "turn2",
          status: "inProgress",
          startedAt: 20,
          items: [
            { id: "p1", type: "userMessage", content: [{ type: "text", text: "Do the thing" }] },
            { id: "m2", type: "agentMessage", questions: [{ title: "Q", options: ["A"] }] },
          ],
        },
      ]))
    ),
    true
  );
  assert.strictEqual(panel.title, "[?] Alpha");

  // Completed with an unresolved question: conservative non-done.
  tracked(api, provider, webview, "r4", "t1", true);
  assert.strictEqual(
    api.readResponse(
      provider,
      webview,
      readResponse("r4", readThread("t1", { type: "idle" }, [
        { id: "turn2", status: "completed", startedAt: 20, items: [question] },
      ]))
    ),
    true
  );
  assert.strictEqual(panel.title, "[?] Alpha");
  assert.strictEqual(runtime.threads.t1.completedTurnId, "turn2");
  assert.strictEqual(runtime.threads.t1.questionClosedTurnId, "turn2");
  assert.strictEqual(runtime.threads.t1.doneEmittedFor, null);
  assert.strictEqual(statusEvents(je, "done").length, 0);

  // Completed with a later answer: done is safe.
  tracked(api, provider, webview, "r5", "t1", true);
  assert.strictEqual(
    api.readResponse(
      provider,
      webview,
      readResponse("r5", readThread("t1", { type: "idle" }, [
        { id: "turn2", status: "completed", startedAt: 20, items: [question, answer] },
      ]))
    ),
    true
  );
  assert.strictEqual(panel.title, "[V] Alpha");
  assert.strictEqual(runtime.threads.t1.doneEmittedFor, "turn2");
});

test("out-of-order reads apply newest first and drop the stale response", () => {
  const { je, context, api } = createHarness();
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  const webview = { id: "w1" };
  api.install(provider, context);
  bind(api, provider, panel, webview, "t1", "Alpha");

  tracked(api, provider, webview, "r1", "t1", true);
  tracked(api, provider, webview, "r2", "t1", true);
  assert.strictEqual(
    api.readResponse(
      provider,
      webview,
      readResponse("r2", readThread("t1", { type: "idle" }, [{ id: "turn2", status: "completed", startedAt: 20, items: [] }]))
    ),
    true
  );
  assert.strictEqual(panel.title, "[V] Alpha");
  const before = events(je).length;
  assert.strictEqual(
    api.readResponse(
      provider,
      webview,
      readResponse("r1", readThread("t1", { type: "idle" }, [{ id: "turn1", status: "inProgress", startedAt: 10 }]))
    ),
    false
  );
  assert.strictEqual(panel.title, "[V] Alpha");
  assert.strictEqual(events(je).length, before);
});

test("live events during a read invalidate it, including same-status repeats and terminals", () => {
  const { je, context, api } = createHarness();
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  const webview = { id: "w1" };
  api.install(provider, context);
  bind(api, provider, panel, webview, "t1", "Alpha");

  api.notify(provider, started("turn1", 10));
  tracked(api, provider, webview, "r1", "t1", true);
  // Same-status live event: no new publish, but a new epoch.
  api.notify(provider, started("turn1", 10));
  assert.strictEqual(
    api.readResponse(
      provider,
      webview,
      readResponse("r1", readThread("t1", { type: "idle" }, [{ id: "turn1", status: "completed", startedAt: 10 }]))
    ),
    false
  );
  assert.strictEqual(panel.title, "[~] Alpha");
  assert.strictEqual(statusEvents(je, "done").length, 0);

  tracked(api, provider, webview, "r2", "t1", true);
  api.notify(provider, completed("turn1", 10, "completed"));
  assert.strictEqual(panel.title, "[V] Alpha");
  const before = events(je).length;
  assert.strictEqual(
    api.readResponse(
      provider,
      webview,
      readResponse("r2", readThread("t1", { type: "idle" }, [{ id: "turn1", status: "completed", startedAt: 10 }]))
    ),
    false
  );
  assert.strictEqual(events(je).length, before);
  assert.strictEqual(statusEvents(je, "done").length, 1);
});

test("cross-thread, cross-webview, malformed and non-local snapshots are ignored", () => {
  const { je, context, api } = createHarness();
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  const other = provider.add({ title: "Other" }, { id: "w2" });
  const webview = { id: "w1" };
  const otherView = { id: "w2" };
  api.install(provider, context);
  bind(api, provider, panel, webview, "t1", "Alpha");
  bind(api, provider, other, otherView, "t2", "Beta");
  const runtime = provider.__companionWorkflowRuntime;

  tracked(api, provider, webview, "r1", "t1", true);
  assert.strictEqual(
    api.readResponse(
      provider,
      webview,
      readResponse("r1", readThread("t2", { type: "idle" }, [{ id: "turn2", status: "completed", startedAt: 20 }]))
    ),
    false
  );
  assert.strictEqual(runtime.readCount, 0);
  assert.strictEqual(panel.title, "Alpha");

  tracked(api, provider, webview, "r2", "t1", true);
  assert.strictEqual(
    api.readResponse(
      provider,
      otherView,
      readResponse("r2", readThread("t1", { type: "idle" }, [{ id: "turn1", status: "completed", startedAt: 10 }]))
    ),
    false
  );
  assert.strictEqual(runtime.readCount, 0);
  assert.strictEqual(panel.title, "Alpha");

  tracked(api, provider, webview, "r3", "t1", true);
  assert.strictEqual(api.readResponse(provider, webview, { id: "r3", result: {}, error: null }), false);
  tracked(api, provider, webview, "r4", "t1", true);
  assert.strictEqual(
    api.readResponse(
      provider,
      webview,
      readResponse("r4", Object.assign(readThread("t1", { type: "idle" }, []), { hostId: "remote" }))
    ),
    false
  );
  assert.strictEqual(panel.title, "Alpha");
  assert.strictEqual(events(je).length, 0);
  assert.strictEqual(runtime.readCount, 0);
});

test("notLoaded, unknown, absent turns and unknown turn statuses invent nothing", () => {
  const { je, context, api } = createHarness();
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  const webview = { id: "w1" };
  api.install(provider, context);
  bind(api, provider, panel, webview, "t1", "Alpha");

  const cases = [
    { type: "notLoaded" },
    { type: "mystery" },
    {},
  ];
  let index = 0;
  for (const status of cases) {
    tracked(api, provider, webview, "f" + index, "t1", true);
    assert.strictEqual(
      api.readResponse(provider, webview, readResponse("f" + index, readThread("t1", status, []))),
      false
    );
    index += 1;
  }
  const idleCases = [
    undefined,
    [],
    [{ id: "turn1", status: "mystery", startedAt: 10 }],
    [{ id: null, status: "completed", startedAt: 10 }],
  ];
  for (const turns of idleCases) {
    tracked(api, provider, webview, "f" + index, "t1", true);
    assert.strictEqual(
      api.readResponse(provider, webview, readResponse("f" + index, readThread("t1", { type: "idle" }, turns))),
      false
    );
    index += 1;
  }
  // Malformed response objects are ignored without throwing.
  tracked(api, provider, webview, "bad1", "t1", true);
  assert.strictEqual(api.readResponse(provider, webview, { id: "bad1", result: null, error: null }), false);
  tracked(api, provider, webview, "bad2", "t1", true);
  assert.strictEqual(api.readResponse(provider, webview, { id: "bad2", result: { thread: null }, error: null }), false);
  assert.strictEqual(panel.title, "Alpha");
  assert.strictEqual(events(je).length, 0);
});

test("tracking is bounded and cleaned on response, error, abandon and disposal", () => {
  const { je, context, api } = createHarness();
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  const webview = { id: "w1" };
  api.install(provider, context);
  bind(api, provider, panel, webview, "t1", "Alpha");
  const runtime = provider.__companionWorkflowRuntime;

  for (let i = 0; i < 100; i += 1) tracked(api, provider, webview, "bulk" + i, "t1", true);
  assert.ok(runtime.readCount <= 64);
  assert.ok(Object.keys(runtime.reads).length <= 64);
  assert.strictEqual(runtime.reads.bulk0, undefined);
  assert.notStrictEqual(runtime.reads.bulk99, undefined);

  tracked(api, provider, webview, "clean1", "t1", true);
  assert.strictEqual(api.forgetRead(provider, "clean1"), true);
  assert.strictEqual(api.readResponse(provider, webview, readResponse("clean1", readThread("t1", { type: "systemError" }))), false);

  tracked(api, provider, webview, "clean2", "t1", true);
  assert.strictEqual(api.readResponse(provider, webview, { id: "clean2", result: null, error: { message: "boom" } }), false);
  assert.strictEqual(runtime.reads.clean2, undefined);

  tracked(api, provider, webview, "clean3", "t1", true);
  assert.strictEqual(api.forgetWebviewReads(provider, webview) >= 1, true);
  assert.strictEqual(runtime.reads.clean3, undefined);

  tracked(api, provider, webview, "clean4", "t1", true);
  for (const disposable of provider.subscriptions) disposable.dispose();
  for (const disposable of context.subscriptions) disposable.dispose();
  assert.strictEqual(runtime.reads.clean4, undefined);
  assert.strictEqual(runtime.readCount, 0);
});

test("async persisted restore cannot overwrite a hydrated live status", async () => {
  const roots = ["C:\\Project"];
  const saved = {
    version: 1,
    roots,
    threads: {
      t1: { status: "done", turnId: "turn0", goalStatus: null, completedTurnId: "turn0", updatedAt: 5 },
    },
  };
  const { je, context, api, resolveRestore } = createHarness({ roots, saved, asyncRestore: true });
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  const webview = { id: "w1" };
  api.install(provider, context);
  bind(api, provider, panel, webview, "t1", "Alpha");

  tracked(api, provider, webview, "r1", "t1", false);
  assert.strictEqual(
    api.readResponse(
      provider,
      webview,
      readResponse("r1", readThread("t1", { type: "active", activeFlags: ["waitingOnApproval"] }))
    ),
    true
  );
  assert.strictEqual(panel.title, "[?] Alpha");

  resolveRestore();
  await flush();
  assert.strictEqual(panel.title, "[?] Alpha");
  const runtime = provider.__companionWorkflowRuntime;
  assert.strictEqual(runtime.threads.t1.status, "waiting");
  assert.strictEqual(runtime.threads.t1.turnId, null);
  assert.strictEqual(runtime.threads.t1.completedTurnId, null);
  assert.strictEqual(je.handlers.get("chatgpt.companion.v1.getState")().tabs[0].status, "waiting");
});

// ---------------------------------------------------------------------------
// Resume / paginated question history (existing native traffic only)
// ---------------------------------------------------------------------------

function nativeQuestionItem(itemId, count) {
  const questions = [];
  for (let i = 0; i < count; i += 1) {
    questions.push({ title: "Question " + i, options: ["A", "B"] });
  }
  return {
    id: itemId,
    type: "agentMessage",
    text: "Which option?",
    phase: null,
    memoryCitation: null,
    delivery: "async",
    questions,
  };
}

function nativePromptItem(itemId, text) {
  return {
    id: itemId,
    type: "userMessage",
    clientId: null,
    content: [{ type: "text", text: text || "Do the thing" }],
  };
}

function nativeReplyItem(itemId, questionItemId, index, answer) {
  const envelope =
    "<send_user_message_question_reply>" +
    JSON.stringify({
      questionItemId: JSON.stringify(["request_user_input_async", questionItemId, index]),
      question: "Question " + index,
      answer: answer || "A",
    }) +
    "</send_user_message_question_reply>";
  return {
    id: itemId,
    type: "userMessage",
    clientId: null,
    content: [{ type: "text", text: envelope }],
  };
}

function turnPage(items, nextCursor, options) {
  const page = {
    data: [
      {
        id: (options && options.turnId) || "rollout-3",
        status: (options && options.status) || "completed",
        startedAt: options && "startedAt" in options ? options.startedAt : null,
        itemsView: "full",
        itemsCount: items.length,
        items,
      },
    ],
    backwardsCursor: "backwards",
  };
  if (!(options && options.omitNextCursor)) {
    page.nextCursor = nextCursor === undefined ? null : nextCursor;
  }
  return page;
}

function resumeResponse(id, page, turns) {
  return {
    id,
    result: {
      thread: { id: "t1", hostId: "local", status: { type: "idle" }, turns: turns || [] },
      initialTurnsPage: page,
    },
    error: null,
  };
}

function historyHarness(options = {}) {
  const h = createHarness(options);
  h.provider = makeProvider();
  h.webview = { id: "w1" };
  h.panel = h.provider.add({ title: "Codex" }, h.webview);
  h.api.install(h.provider, h.context);
  bind(h.api, h.provider, h.panel, h.webview, "t1", "Alpha");
  h.runtime = h.provider.__companionWorkflowRuntime;
  h.track = (request) => h.api.trackRead(h.provider, h.webview, request);
  h.respond = (response) => h.api.readResponse(h.provider, h.webview, response);
  h.resume = (id, page, turns) => {
    h.track({
      id,
      method: "thread/resume",
      params: {
        threadId: "t1",
        excludeTurns: true,
        initialTurnsPage: { limit: 5, itemsView: "full", sortDirection: "desc" },
      },
    });
    return h.respond(resumeResponse(id, page, turns));
  };
  return h;
}

test("invalid cursors/directions survive sanitization as invalid rather than becoming latest roots",()=>{
 for(const bad of [{cursor:{type:"unknown",itemId:"x"}},{cursor:100},{sortDirection:"unknown"}]){
  const h=historyHarness();h.track({id:"bad",method:"thread/turns/list",params:{threadId:"t1",cursor:null,itemsView:"full",sortDirection:"desc",...bad}});
  assert.strictEqual(h.respond({id:"bad",result:turnPage([nativeQuestionItem("q",1)]),error:null}),false);
  assert.strictEqual(h.panel.title,"Alpha");
 }
});

test("load-only native idle during resume does not discard complete cold question evidence",()=>{
 for(const status of ["idle","done"]){
  const h=historyHarness({saved:{version:1,roots:["C:\\Project"],threads:{t1:{status,turnId:"rollout-3",completedTurnId:status==="done"?"rollout-3":null,updatedAt:10}}}});
  h.track({id:"native",method:"thread/resume",params:{threadId:"t1",excludeTurns:true,initialTurnsPage:{itemsView:"full",sortDirection:"desc"}}});
  h.api.notify(h.provider,{method:"thread/status/changed",params:{threadId:"t1",status:{type:"idle"}}});
  assert.strictEqual(h.respond(resumeResponse("native",turnPage([nativeQuestionItem("q",2)]))),true);
  assert.strictEqual(h.panel.title,"[?] Alpha");
 }
});

test("new inProgress evidence retains known partial answers across reset and duplicate question events",()=>{
 const h=historyHarness({saved:{version:1,roots:["C:\\Project"],threads:{t1:{status:"idle",turnId:"old",completedTurnId:null,updatedAt:10}}}});
 const question=nativeQuestionItem("q",2);
 assert.strictEqual(h.resume("partial-new",turnPage([question,nativeReplyItem("a0","q",0)],null,{turnId:"new",status:"inProgress"})),true);
 h.api.notify(h.provider,{method:"item/completed",params:{threadId:"t1",turnId:"new",item:question}});
 h.api.notify(h.provider,{method:"item/started",params:{threadId:"t1",turnId:"new",item:nativeReplyItem("a1","q",1)}});
 assert.strictEqual(h.runtime.threads.t1.asyncQuestionCount,0);assert.strictEqual(h.panel.title,"[~] Alpha");
});

test("live terminal without a timestamp wins a different unorderable history turn",()=>{
 const h=historyHarness();h.api.notify(h.provider,started("live",null));h.api.notify(h.provider,completed("live",null,"completed"));
 assert.strictEqual(h.resume("stale-different",turnPage([nativeQuestionItem("q",1)],null,{turnId:"old",startedAt:10})),false);
 assert.strictEqual(h.panel.title,"[V] Alpha");
});

test("a later complete read prevents an old paged root from resurrecting an answered question",()=>{
 const h=historyHarness();h.track({id:"root-old",method:"thread/turns/list",params:{threadId:"t1",cursor:null,sortDirection:"desc",itemsView:"notLoaded"}});
 h.respond({id:"root-old",result:{data:[{id:"turn",status:"completed",startedAt:10,itemsView:"notLoaded",items:[]}],nextCursor:null}});
 h.track(readRequest("new-full","t1",true));assert.strictEqual(h.respond(readResponse("new-full",readThread("t1",{type:"idle"},[{id:"turn",status:"completed",startedAt:10,itemsView:"full",items:[]}]))),true);
 h.track({id:"items-old",method:"thread/items/list",params:{threadId:"t1",turnId:"turn",cursor:null,sortDirection:"desc"}});
 assert.strictEqual(h.respond({id:"items-old",result:{data:[{turnId:"turn",item:nativeQuestionItem("q",1)}],nextCursor:null}}),false);
 assert.strictEqual(h.panel.title,"[V] Alpha");
});

test("normal resume.initialTurnsPage with startedAt:null restores a cold waiting question", () => {
  const saved = {
    version: 1,
    roots: ["C:\\Project"],
    threads: {
      t1: { status: "waiting", turnId: "rollout-2", goalStatus: null, completedTurnId: null, updatedAt: 5 },
    },
  };
  const h = historyHarness({ saved });
  assert.strictEqual(h.panel.title, "Alpha");
  assert.strictEqual(
    h.resume("resume-1", turnPage([nativePromptItem("item-1"), nativeQuestionItem("q1", 1)])),
    true
  );
  assert.strictEqual(h.panel.title, "[?] Alpha");
  const thread = h.runtime.threads.t1;
  assert.strictEqual(thread.status, "waiting");
  assert.strictEqual(thread.turnId, "rollout-3");
  assert.strictEqual(thread.turnStartedAt, null);
  assert.strictEqual(thread.turnActive, false);
  assert.strictEqual(thread.completedTurnId, "rollout-3");
  assert.strictEqual(thread.questionClosedTurnId, "rollout-3");
  assert.strictEqual(thread.doneEmittedFor, null);
  assert.strictEqual(thread.asyncQuestionCount, 1);
  assert.strictEqual(thread.asyncQuestions["rollout-3|q1"].questionKeys.length, 1);
  const silent = snapshotEvents(h.je);
  assert.strictEqual(silent.length, 1);
  assert.strictEqual(silent[0].tab.status, "waiting");
  assert.strictEqual(events(h.je).filter((event) => event.live !== false).length, 0);
  const savedText = JSON.stringify(h.context.store.get(h.api.stateKey()));
  assert.ok(!savedText.includes("Which option"));
  assert.ok(!savedText.includes("Question 0"));
  assert.ok(!savedText.includes("questionKeys"));
  assert.ok(!savedText.includes("questions"));
});

test("proven complete resumed questions update silently: partial reply waits, final reply is silent done", () => {
  const h = historyHarness();
  assert.strictEqual(
    h.resume("resume-1", turnPage([
      nativeQuestionItem("q1", 2),
      nativeReplyItem("a0", "q1", 0),
    ])),
    true
  );
  assert.strictEqual(h.panel.title, "[?] Alpha");
  let thread = h.runtime.threads.t1;
  assert.strictEqual(thread.asyncQuestionCount, 1);
  assert.strictEqual(thread.asyncQuestions["rollout-3|q1"].questionKeys.length, 1);
  assert.strictEqual(thread.doneEmittedFor, null);
  assert.strictEqual(statusEvents(h.je, "done").length, 0);

  assert.strictEqual(
    h.resume("resume-2", turnPage([
      nativeQuestionItem("q1", 2),
      nativeReplyItem("a0", "q1", 0),
      nativeReplyItem("a1", "q1", 1),
    ])),
    true
  );
  thread = h.runtime.threads.t1;
  assert.strictEqual(h.panel.title, "[V] Alpha");
  assert.strictEqual(thread.asyncQuestionCount, 0);
  assert.strictEqual(thread.doneEmittedFor, "rollout-3");
  const done = statusEvents(h.je, "done");
  assert.strictEqual(done.length, 1);
  assert.strictEqual(done[0].live, false);
});

test("legacy resume without excludeTurns adopts a complete full-turn question snapshot", () => {
  const h = historyHarness();
  h.track({
    id: "legacy",
    method: "thread/resume",
    params: { threadId: "t1", excludeTurns: false },
  });
  assert.strictEqual(
    h.respond({
      id: "legacy",
      result: {
        thread: {
          id: "t1",
          hostId: "local",
          status: { type: "idle" },
          turns: [
            {
              id: "turn-legacy",
              status: "completed",
              startedAt: 10,
              itemsView: "full",
              items: [nativeQuestionItem("q1", 1)],
            },
          ],
        },
      },
      error: null,
    }),
    true
  );
  assert.strictEqual(h.panel.title, "[?] Alpha");
  assert.strictEqual(h.runtime.threads.t1.completedTurnId, "turn-legacy");
  assert.strictEqual(h.runtime.threads.t1.questionClosedTurnId, "turn-legacy");
  assert.strictEqual(h.runtime.threads.t1.doneEmittedFor, null);
  assert.strictEqual(statusEvents(h.je, "done").length, 0);
});

test("read records keep only sanitized pagination params, never request content", () => {
  const h = historyHarness();
  h.track({
    id: "sanitize",
    method: "thread/resume",
    params: {
      threadId: "t1",
      excludeTurns: true,
      initialTurnsPage: {
        limit: 5,
        itemsView: "full",
        sortDirection: "desc",
        cursor: null,
        content: "SECRET CONTENT",
      },
      content: "SECRET CONTENT",
      config: { sandbox: "SECRET CONFIG" },
    },
  });
  const record = h.runtime.reads.sanitize;
  assert.ok(record);
  assert.deepStrictEqual(Object.keys(record.params.initialTurnsPage).sort(), [
    "cursor",
    "itemsView",
    "limit",
    "sort",
    "sortDirection",
  ]);
  assert.strictEqual(record.params.initialTurnsPage.cursor, null);
  assert.strictEqual(record.params.excludeTurns, true);
  const serialized = JSON.stringify(record);
  assert.ok(!serialized.includes("SECRET"));
  assert.ok(!serialized.includes("content"));
  assert.ok(!serialized.includes("config"));
});

test("live partial question replies settle only exact keys, ignore ordinary/rejected input and emit one done", () => {
  const { je, context, api } = createHarness();
  const provider = makeProvider();
  const panel = provider.add({ title: "Codex" }, { id: "w1" });
  api.install(provider, context);
  bind(api, provider, panel, { id: "w1" }, "t1", "Alpha");

  api.notify(provider, started("turn1", 10));
  api.notify(provider, {
    method: "item/started",
    params: { threadId: "t1", turnId: "turn1", item: nativeQuestionItem("q1", 2) },
  });
  api.notify(provider, completed("turn1", 10, "completed"));
  assert.strictEqual(panel.title, "[?] Alpha");

  api.notify(provider, {
    method: "item/started",
    params: { threadId: "t1", turnId: "turn1", item: nativeReplyItem("a0", "q1", 0) },
  });
  assert.strictEqual(panel.title, "[?] Alpha");
  assert.strictEqual(provider.__companionWorkflowRuntime.threads.t1.asyncQuestions["turn1|q1"].questionKeys.length, 1);

  api.notify(provider, {
    method: "item/completed",
    params: { threadId: "t1", turnId: "turn1", item: nativeQuestionItem("q1", 2) },
  });
  api.notify(provider, plainUserMessageItem("item/started", "turn1", "ordinary", "chat about something else"));
  api.notify(provider, steeringMessageItem(
    "item/started",
    "turn1",
    "steer-rejected",
    "rejected",
    JSON.stringify(["request_user_input_async", "q1", 1])
  ));
  assert.strictEqual(panel.title, "[?] Alpha");
  assert.strictEqual(statusEvents(je, "done").length, 0);

  // Pending and accepted versions share an item id. The pending one must not
  // dedupe the later accepted reply.
  const acceptedKey = JSON.stringify(["request_user_input_async", "q1", 1]);
  api.notify(provider, steeringMessageItem("item/started", "turn1", "steer-ok", "pending", acceptedKey));
  assert.strictEqual(panel.title, "[?] Alpha");
  api.notify(provider, steeringMessageItem("item/started", "turn1", "steer-ok", "accepted", acceptedKey));
  assert.strictEqual(panel.title, "[V] Alpha");
  assert.strictEqual(statusEvents(je, "done").length, 1);
  assert.strictEqual(statusEvents(je, "done")[0].live, true);
});

test("paginated turns/list + two/three item pages complete only with an explicit null cursor", () => {
  const h = historyHarness();
  h.track({
    id: "roots-1",
    method: "thread/turns/list",
    params: { threadId: "t1", itemsView: "notLoaded", sortDirection: "desc" },
  });
  assert.strictEqual(
    h.respond({
      id: "roots-1",
      result: {
        data: [{ id: "turn9", status: "completed", startedAt: null, itemsView: "notLoaded" }],
        nextCursor: "older-turns",
      },
      error: null,
    }),
    false
  );
  h.track({
    id: "items-1",
    method: "thread/items/list",
    params: { threadId: "t1", turnId: "turn9", cursor: null, sortDirection: "desc", itemsView: "full" },
  });
  assert.strictEqual(
    h.respond({
      id: "items-1",
      result: { data: [{ turnId: "turn9", item: nativeQuestionItem("q1", 2) }], nextCursor: "p2" },
      error: null,
    }),
    false
  );
  assert.strictEqual(h.panel.title, "Alpha");
  h.track({
    id: "items-2",
    method: "thread/items/list",
    params: { threadId: "t1", turnId: "turn9", cursor: "p2", sortDirection: "desc", itemsView: "full" },
  });
  assert.strictEqual(
    h.respond({
      id: "items-2",
      result: { data: [{ turnId: "turn9", item: nativeReplyItem("a0", "q1", 0) }], nextCursor: "p3" },
      error: null,
    }),
    false
  );
  assert.strictEqual(h.panel.title, "Alpha");
  assert.strictEqual(h.runtime.threads.t1.asyncQuestionCount, 0);
  h.track({
    id: "items-3",
    method: "thread/items/list",
    params: { threadId: "t1", turnId: "turn9", cursor: "p3", sortDirection: "desc", itemsView: "full" },
  });
  assert.strictEqual(
    h.respond({
      id: "items-3",
      result: {
        data: [{ turnId: "turn9", item: nativeReplyItem("a1", "q1", 1) }],
        nextCursor: null,
      },
      error: null,
    }),
    true
  );
  assert.strictEqual(h.panel.title, "[V] Alpha");
  assert.strictEqual(h.runtime.threads.t1.asyncQuestionCount, 0);
  assert.strictEqual(h.runtime.threads.t1.doneEmittedFor, "turn9");
  assert.strictEqual(statusEvents(h.je, "done").length, 1);
});

test("missing nextCursor and cursor cycles never invent waiting or done", () => {
  const missing = historyHarness();
  missing.track({
    id: "roots",
    method: "thread/turns/list",
    params: { threadId: "t1", itemsView: "notLoaded", sortDirection: "desc" },
  });
  missing.respond({
    id: "roots",
    result: {
      data: [{ id: "turn9", status: "completed", startedAt: null, itemsView: "notLoaded" }],
      nextCursor: "older",
    },
    error: null,
  });
  missing.track({
    id: "i1",
    method: "thread/items/list",
    params: { threadId: "t1", turnId: "turn9", cursor: null, sortDirection: "desc", itemsView: "full" },
  });
  missing.respond({
    id: "i1",
    result: { data: [{ turnId: "turn9", item: nativeQuestionItem("q1", 1) }], nextCursor: "p2" },
    error: null,
  });
  missing.track({
    id: "i2",
    method: "thread/items/list",
    params: { threadId: "t1", turnId: "turn9", cursor: "p2", sortDirection: "desc", itemsView: "full" },
  });
  assert.strictEqual(
    missing.respond({
      id: "i2",
      result: { data: [{ turnId: "turn9", item: nativeReplyItem("a0", "q1", 0) }] },
      error: null,
    }),
    false
  );
  assert.strictEqual(missing.panel.title, "Alpha");
  assert.strictEqual(events(missing.je).length, 0);

  const cycle = historyHarness();
  cycle.track({
    id: "roots",
    method: "thread/turns/list",
    params: { threadId: "t1", itemsView: "notLoaded", sortDirection: "desc" },
  });
  cycle.respond({
    id: "roots",
    result: {
      data: [{ id: "turn9", status: "completed", startedAt: null, itemsView: "notLoaded" }],
      nextCursor: "older",
    },
    error: null,
  });
  for (const [id, cursor, next] of [["c1", null, "p2"], ["c2", "p2", "p2"]]) {
    cycle.track({
      id,
      method: "thread/items/list",
      params: { threadId: "t1", turnId: "turn9", cursor, sortDirection: "desc", itemsView: "full" },
    });
    cycle.respond({
      id,
      result: { data: [{ turnId: "turn9", item: nativeQuestionItem("q1", 1) }], nextCursor: next },
      error: null,
    });
  }
  assert.strictEqual(cycle.panel.title, "Alpha");
  assert.strictEqual(events(cycle.je).length, 0);
});

test("older roots, live epochs, newer turns and live terminals cannot be regressed by history", () => {
  const root = historyHarness();
  root.track({
    id: "old",
    method: "thread/resume",
    params: { threadId: "t1", excludeTurns: true, initialTurnsPage: { limit: 5, itemsView: "full", sortDirection: "desc" } },
  });
  root.track({
    id: "new",
    method: "thread/resume",
    params: { threadId: "t1", excludeTurns: true, initialTurnsPage: { limit: 5, itemsView: "full", sortDirection: "desc" } },
  });
  assert.strictEqual(root.respond(resumeResponse("new", turnPage([nativeQuestionItem("q1", 1), nativeReplyItem("a0", "q1", 0)]))), true);
  assert.strictEqual(root.panel.title, "[V] Alpha");
  assert.strictEqual(root.respond(resumeResponse("old", turnPage([nativeQuestionItem("q1", 1)]))), false);
  assert.strictEqual(root.panel.title, "[V] Alpha");

  const epoch = historyHarness();
  epoch.track({
    id: "epoch",
    method: "thread/resume",
    params: { threadId: "t1", excludeTurns: true, initialTurnsPage: { limit: 5, itemsView: "full", sortDirection: "desc" } },
  });
  epoch.api.notify(epoch.provider, started("turn1", 10));
  assert.strictEqual(epoch.respond(resumeResponse("epoch", turnPage([nativeQuestionItem("q1", 1)]))), false);
  assert.strictEqual(epoch.panel.title, "[~] Alpha");

  const newer = historyHarness();
  newer.api.notify(newer.provider, started("turn2", 20));
  newer.track({
    id: "old-turn",
    method: "thread/resume",
    params: { threadId: "t1", excludeTurns: true, initialTurnsPage: { limit: 5, itemsView: "full", sortDirection: "desc" } },
  });
  assert.strictEqual(
    newer.respond(resumeResponse("old-turn", turnPage([nativeQuestionItem("q1", 1)], null, { turnId: "turn1", startedAt: 10 }))),
    false
  );
  assert.strictEqual(newer.panel.title, "[~] Alpha");

  const live = historyHarness();
  live.api.notify(live.provider, started("turn1", 10));
  live.api.notify(live.provider, completed("turn1", 10, "completed"));
  assert.strictEqual(live.panel.title, "[V] Alpha");
  live.track({
    id: "stale-terminal",
    method: "thread/resume",
    params: { threadId: "t1", excludeTurns: true, initialTurnsPage: { limit: 5, itemsView: "full", sortDirection: "desc" } },
  });
  assert.strictEqual(
    live.respond(resumeResponse("stale-terminal", turnPage([nativeQuestionItem("q1", 1)], null, { turnId: "turn1", startedAt: 10 }))),
    false
  );
  assert.strictEqual(live.panel.title, "[V] Alpha");
  assert.strictEqual(statusEvents(live.je, "done").length, 1);
});

test("roots change and webview disposal clear pending history assembly", () => {
  const h = historyHarness();
  h.track({
    id: "roots-read",
    method: "thread/resume",
    params: { threadId: "t1", excludeTurns: true, initialTurnsPage: { limit: 5, itemsView: "full", sortDirection: "desc" } },
  });
  assert.strictEqual(h.runtime.readCount, 1);
  assert.ok(h.je.foldersHandlers.length > 0);
  h.setRoots(["C:\\Other"]);
  h.je.foldersHandlers[0]();
  assert.strictEqual(h.runtime.readCount, 0);
  assert.strictEqual(h.respond(resumeResponse("roots-read", turnPage([nativeQuestionItem("q1", 1)]))), false);
  assert.strictEqual(h.panel.title, "Alpha");

  const disposed = historyHarness();
  disposed.track({
    id: "view-read",
    method: "thread/resume",
    params: { threadId: "t1", excludeTurns: true, initialTurnsPage: { limit: 5, itemsView: "full", sortDirection: "desc" } },
  });
  assert.strictEqual(disposed.api.forgetWebviewReads(disposed.provider, disposed.webview), 1);
  assert.strictEqual(disposed.runtime.readCount, 0);
  assert.strictEqual(disposed.respond(resumeResponse("view-read", turnPage([nativeQuestionItem("q1", 1)]))), false);
  assert.strictEqual(disposed.panel.title, "Alpha");
});

test("async persisted restore cannot overwrite resumed complete question evidence", async () => {
  const saved = {
    version: 1,
    roots: ["C:\\Project"],
    threads: {
      t1: { status: "done", turnId: "rollout-2", goalStatus: null, completedTurnId: "rollout-2", updatedAt: 5 },
    },
  };
  const h = historyHarness({ saved, asyncRestore: true });
  assert.strictEqual(
    h.resume("resume-async", turnPage([nativeQuestionItem("q1", 1)])),
    true
  );
  assert.strictEqual(h.panel.title, "[?] Alpha");
  h.resolveRestore();
  await flush();
  assert.strictEqual(h.panel.title, "[?] Alpha");
  assert.strictEqual(h.runtime.threads.t1.status, "waiting");
  assert.strictEqual(h.runtime.threads.t1.completedTurnId, "rollout-3");
  assert.strictEqual(h.runtime.threads.t1.questionClosedTurnId, "rollout-3");
  assert.strictEqual(events(h.je).filter((event) => event.live !== false).length, 0);
});
