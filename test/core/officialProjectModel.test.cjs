"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const titles = require("../../scripts/patchOfficialTitles.cjs");
const model = require("../../scripts/officialModelTransform.cjs");

const ROOT = path.resolve(__dirname, "..", "..");
const FIXTURE = path.join(ROOT, ".artifacts", "openai-project-history", "original");
const HOST = "out/extension.js";
const C014 = "webview/assets/app-initial-c014f9ee4429.js";

const materials = (() => {
  const t = titles.buildMaterials(FIXTURE);
  return {
    titles: t,
    baselineHost: t.titleTexts[HOST],
    baselineC014: t.titleTexts[C014],
    host: model.applyModelTransforms(HOST, t.titleTexts[HOST]),
    c014: model.applyModelTransforms(C014, t.titleTexts[C014]),
  };
})();

// ---------------------------------------------------------------------------
// Fake infrastructure
// ---------------------------------------------------------------------------

function makeMemento(initial) {
  const store = initial ? JSON.parse(JSON.stringify(initial)) : {};
  const calls = { get: [], update: [] };
  return {
    store,
    calls,
    get(key) {
      calls.get.push(String(key));
      return store[String(key)];
    },
    update(key, value) {
      calls.update.push({ key: String(key), value: JSON.parse(JSON.stringify(value)) });
      store[String(key)] = JSON.parse(JSON.stringify(value));
      return Promise.resolve();
    },
  };
}

function makeHost({ roots = ["C:/projA"], memento = null, panels = [] } = {}) {
  const outgoing = [];
  const panelMap = new Map();
  for (const [panel, webview] of panels) panelMap.set(panel, webview);
  const provider = {
    __companionWorkflowContext: memento ? { workspaceState: memento } : null,
    editorPanels: new Map(),
    findPanelByWebview(webview) {
      for (const [panel, candidate] of panelMap) {
        if (candidate === webview) return panel;
        if (candidate && webview && candidate.id !== undefined && candidate.id === webview.id) return panel;
      }
      return undefined;
    },
    isPanelAlive(panel) {
      return panelMap.has(panel);
    },
    postMessageToWebview(webview, message) {
      outgoing.push({ webview, message });
    },
  };
  return { provider, outgoing, panelMap };
}

function fakeNorm(roots) {
  if (!Array.isArray(roots)) return [];
  const out = [];
  for (const r of roots) {
    if (typeof r !== "string" || r.length === 0) continue;
    const n = r.replace(/\\/g, "/").toLowerCase();
    if (!/^[a-z]:\//.test(n) && !/^\//.test(n)) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

function evaluateHostHelpers(coreSource) {
  const core = coreSource === undefined ? model.loadModelCoreSource() : coreSource;
  return new Function(
    "cR",
    "__companionNormalizedRoots",
    "__companionIsSpecializedPanel",
    core +
      "\n" +
      model.MODEL_HOST_GLUE +
      "\nreturn {__companionModelHandleRequest:__companionModelHandleRequest,__companionModelHandleSelected:__companionModelHandleSelected,__companionModelIsLocalChatPanel:__companionModelIsLocalChatPanel,__companionWorkflowGetProjectModel:__companionWorkflowGetProjectModel,__companionModelWrite:__companionModelWrite,__companionModelProjectKey:__companionModelProjectKey,__companionModelValidatePair:__companionModelValidatePair,__companionModelNormalizeStored:__companionModelNormalizeStored};"
  );
}

function evaluateRendererGlue() {
  return new Function(
    model.MODEL_RENDERER_GLUE +
      "\nreturn {__companionModelWrapSelect:__companionModelWrapSelect,__companionModelWrapSet:__companionModelWrapSet,__companionModelResolveResult:__companionModelResolveResult};"
  )();
}

function makeRestoreI(applied) {
  return {
    modelSettings: { isLoading: false },
    setModelAndReasoningEffort(m, e, opts) {
      applied.push({ m, e, opts });
      return Promise.resolve(true);
    },
  };
}

// Executes the injected restore block exactly as emitted: the unconditional
// native catalog read followed by the request and apply effects. Re-render
// simulates dependency changes (catalog readiness, setter refresh).
function makeRestoreHarness(options = {}) {
  let n = options.n !== undefined ? options.n : null;
  let r = options.r !== undefined ? options.r : "local";
  let f = options.isDraft !== undefined ? options.isDraft : false;
  let T = options.locked !== undefined ? options.locked : false;
  let m = options.lockedEffort !== undefined ? options.lockedEffort : null;
  let catalog = options.catalog || { data: null, isLoading: false };
  const applied = options.applied || [];
  let i = options.i || makeRestoreI(applied);
  const dispatched = [];
  let handlers = [];
  const vm = {
    dispatchMessage(type, payload) {
      dispatched.push({ type, payload });
    },
    subscribe(type, handler) {
      handlers.push({ type, handler });
      return () => {
        handlers = handlers.filter((h) => h.handler !== handler);
      };
    },
  };
  const cell = {
    current:
      options.cellCurrent !== undefined
        ? options.cellCurrent
        : {
            conversationId: n,
            hostId: r,
            isAeonDraft: f,
            lockedEffort: m,
            setModelAndReasoningEffort: i.setModelAndReasoningEffort,
          },
  };
  const state = {
    current:
      options.stateCurrent !== undefined
        ? options.stateCurrent
        : {
            hostId: r,
            applied: false,
            userChose: false,
            reqId: null,
            retries: 0,
            pair: null,
            pendingChoices: 0,
            choiceSeq: 0,
            lastChoiceSeq: 0,
            applyPending: null,
          },
  };
  const rUCalls = [];
  let cleanups = null;

  function render(overrides = {}) {
    if (overrides.n !== undefined) n = overrides.n;
    if (overrides.r !== undefined) r = overrides.r;
    if (overrides.f !== undefined) f = overrides.f;
    if (overrides.T !== undefined) T = overrides.T;
    if (overrides.m !== undefined) m = overrides.m;
    if (overrides.i !== undefined) {
      i = overrides.i;
      cell.current.setModelAndReasoningEffort = i.setModelAndReasoningEffort;
    }
    if (overrides.catalog !== undefined) catalog = overrides.catalog;
    if (cleanups) for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
    const effects = [];
    const b3i = { useEffect(cb) { effects.push(cb); } };
    const factory = new Function(
      "b3i",
      "vm",
      "i",
      "__companionModelCell",
      "__companionModelState",
      "n",
      "r",
      "f",
      "T",
      "m",
      "rU",
      model.C014_FZI_EFFECT
    );
    factory(b3i, vm, i, cell, state, n, r, f, T, m, (opts) => {
      rUCalls.push(opts);
      return catalog;
    });
    assert.strictEqual(effects.length, 2, "restore block must register exactly two effects");
    cleanups = effects.map((cb) => cb());
    return cleanups;
  }

  const handler = () => handlers.find((h) => h.type === "companion-project-model");
  render();
  return {
    render,
    dispatched,
    applied,
    cell,
    state,
    i,
    vm,
    rUCalls,
    get handler() {
      return handler();
    },
    get handlers() {
      return handlers;
    },
    cleanup() {
      if (cleanups) for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
      cleanups = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Generated seams / determinism / refusal
// ---------------------------------------------------------------------------

test("host transform injects the two unique message cases and the exported getter", () => {
  const h = materials.host;
  assert.ok(h.includes('case"companion-project-model-request"'));
  assert.ok(h.includes('case"companion-project-model-selected"'));
  assert.strictEqual(h.split("companion-project-model-request").length - 1, 1);
  assert.strictEqual(h.split("companion-project-model-selected").length - 1, 1);
  assert.ok(h.includes("function __companionWorkflowGetProjectModel"));
  assert.ok(h.includes("companion.projectModel.v1"));
  // Prior fixes survive.
  for (const marker of [
    "__companionStartupWatchdog",
    "__companionHistoryRoots",
    "__companionNormalizedRoots",
    'case"companion-tab-title"',
    "__companionShouldApplyPreviewTitle",
    "companion-history-scope-changed",
  ]) {
    assert.ok(h.includes(marker), `generated host lost ${marker}`);
  }
  // The view-focused seam is still unique after our insertion.
  assert.strictEqual(h.split('case"view-focused":{this.setFocusedViewForWebview(e);break}').length - 1, 1);
});

test("c014 transform wraps both picker callbacks and restores ordinary HOME too", () => {
  const c = materials.c014;
  assert.ok(c.includes("__companionModelWrapSelect(function(e,t,n)"));
  assert.ok(c.includes("__companionModelWrapSet(function(e,t)"));
  assert.strictEqual(c.split("companion-project-model-request").length - 1, 1);
  assert.strictEqual(c.split("companion-project-model-selected").length - 1, 1);
  assert.ok(c.includes('vm.subscribe("companion-project-model"'));
  assert.ok(c.includes("{persistAsDefault:false}"));
  assert.ok(c.includes("__companionModelCell.current={conversationId:n,hostId:r,isAeonDraft:f,lockedEffort:m,setModelAndReasoningEffort:"));
  assert.ok(c.includes("if(__companionModelState.current.isAeonDraft!==f){"));
  assert.ok(c.includes("__companionModelState.current.reqId=null;__companionModelState.current.retries=0;"));
  // Ordinary HOME (f=false, n=null) must request, while saved/remote views must not.
  assert.ok(c.includes('if(n!=null||r!=="local")return;'));
  assert.ok(c.includes('let __companionModelRestoreCatalog=rU({hostId:r,enabled:r==="local"&&n==null});'));
  assert.ok(!c.includes("c.isAeonDraft!==true"));
  // Both picker callbacks force the local-empty scope at invocation time.
  assert.strictEqual(c.split('__companionModelCell.current.conversationId==null&&__companionModelCell.current.hostId==="local"||f').length - 1, 2);
  // The ordinary-home setter uses the native optimistic atom, never a backend write.
  assert.ok(c.includes('__companionModelHost.hostId==="local"&&n?.persistAsDefault===!1&&!p'));
  assert.ok(c.includes("l.set(Yf,HSe({conversationId:null,hasConversation:!1,hostId:__companionModelHost.hostId,cwd:__companionModelHost.cwd}),{model:i,reasoningEffort:t})"));
  assert.ok(c.includes("await Bp(l,__companionModelHost.hostId).clearPrewarmedThreads();return!0"));
  // Original _U had no such branch.
  assert.ok(!materials.baselineC014.includes("__companionModelHost"));
  assert.ok(c.includes("companion-tab-title"));
  assert.ok(c.includes("companion-history-scope-changed"));
});

test("c014 cell update: a draft-flag transition re-arms restore and preserves explicit choice", () => {
  const factory = new Function(
    "__companionModelState",
    "__companionModelCell",
    "n",
    "r",
    "f",
    "i",
    "m",
    model.C014_FZI_CELL_UPDATE
  );
  const state = {
    current: {
      hostId: "local",
      isAeonDraft: true,
      applied: true,
      userChose: false,
      reqId: "old-request",
      retries: 3,
      pair: { model: "gpt-5.2", effort: "high" },
      pendingChoices: 1,
      choiceSeq: 2,
      lastChoiceSeq: 2,
      applyPending: () => {},
    },
  };
  const cell = { current: {} };
  const i = { setModelAndReasoningEffort() {} };
  factory(state, cell, null, "local", false, i, null);
  assert.strictEqual(state.current.isAeonDraft, false);
  assert.strictEqual(state.current.applied, false);
  assert.strictEqual(state.current.pair, null);
  assert.strictEqual(state.current.reqId, null);
  assert.strictEqual(state.current.retries, 0);
  assert.strictEqual(state.current.applyPending, null);
  assert.strictEqual(state.current.pendingChoices, 1);
  assert.strictEqual(cell.current.conversationId, null);
  assert.strictEqual(cell.current.hostId, "local");

  state.current.userChose = true;
  state.current.applied = true;
  factory(state, cell, null, "local", true, i, null);
  assert.strictEqual(state.current.userChose, true, "a deliberate choice survives a draft transition");
  assert.strictEqual(state.current.applied, false);
  assert.strictEqual(cell.current.isAeonDraft, true);
});

test("applyModelTransforms is deterministic and returns other files unchanged", () => {
  assert.strictEqual(model.applyModelTransforms(HOST, materials.baselineHost), materials.host);
  assert.strictEqual(model.applyModelTransforms(C014, materials.baselineC014), materials.c014);
  assert.strictEqual(model.applyModelTransforms("webview/assets/app-initial-97d3534ad35f.js", "GUARD"), "GUARD");
  assert.strictEqual(model.applyModelTransforms("package.json", "{}"), "{}");
  assert.strictEqual(model.applyModelTransforms("src/extension.ts", "X"), "X");
});

test("applyModelTransforms refuses original and already-patched bytes", () => {
  assert.throws(() => model.applyModelTransforms(HOST, materials.titles.fixture.texts[HOST]), /baseline is missing/);
  assert.throws(() => model.applyModelTransforms(HOST, materials.host), /already present/);
  assert.throws(() => model.applyModelTransforms(C014, materials.titles.fixture.texts[C014]), /baseline is missing/);
  assert.throws(() => model.applyModelTransforms(C014, materials.c014), /already present/);
});

test("transformed host and webview parse as CJS and ESM", () => {
  execFileSync(process.execPath, ["--check"], {
    input: materials.host,
    stdio: ["pipe", "pipe", "pipe"],
  });
  execFileSync(process.execPath, ["--input-type=module", "--check"], {
    input: materials.c014,
    stdio: ["pipe", "pipe", "pipe"],
  });
});

function evaluateNativeU(text) {
  const start = text.indexOf("function _U(");
  const end = text.indexOf("function sPn(", start);
  assert.ok(start >= 0 && end > start, "_U and sPn seams must remain extractable");
  const src = text.slice(start, end);
  return new Function(
    "vU",
    "ta",
    "Q",
    "pln",
    "iPn",
    "rA",
    "HSe",
    "Yf",
    "Bp",
    "yMn",
    "Nu",
    "config",
    "batchWrite",
    "sendRequest",
    "return (" + src + ")"
  );
}

function makeUHarness({ draft = false, cid = null, hostId = "local", cwd = "C:/projA" } = {}) {
  const calls = [];
  const store = {
    get() {},
    set(atom, key, value) {
      calls.push(["set", atom, key, value]);
    },
  };
  const h = {
    isLunaReserveActive: false,
    hasManagedNewThreadSettings: false,
    isUsingCopilotApi: false,
    modelSettings: {
      model: "shared-default",
      profile: null,
      reasoningEffort: "low",
      isLoading: false,
    },
    originalAdvancedModelSettings: null,
    defaultAdvancedModel: null,
    setModelAndReasoningEffort(m, e, opts) {
      calls.push(["native-set", m, e, opts]);
      return Promise.resolve(true);
    },
    setModelAndReasoningEffortForNextTurn() {
      calls.push(["native-next"]);
    },
  };
  const draftSettings = { modelSettings: null };
  const factory = evaluateNativeU(materials.c014);
  const inst = factory(
    { c: () => [] },
    () => store,
    null,
    () => ({
      draftSettings,
      isNewThreadDraft: draft,
      updateDraftSettings(fn) {
        calls.push(["draft-update", fn]);
      },
    }),
    () => h,
    () => ({ hostId, cwd }),
    (key) => ({ key }),
    "YF",
    (s, hid) => ({
      clearPrewarmedThreads() {
        calls.push(["clear", hid]);
        return Promise.resolve();
      },
    }),
    (s, conversationId, model) => {
      calls.push(["yMn", conversationId, model]);
    },
    "NU",
    () => calls.push(["config"]),
    () => calls.push(["batchWrite"]),
    () => calls.push(["sendRequest"])
  );
  return { api: inst(cid, {}), calls };
}

test("native _U: ordinary-home persistAsDefault:false scopes the Yf atom and nothing else", async () => {
  const { api, calls } = makeUHarness({ draft: false, cid: null });
  assert.strictEqual(
    await api.setModelAndReasoningEffort("gpt-5.2", "high", { persistAsDefault: false }),
    true
  );
  const set = calls.find((c) => c[0] === "set");
  assert.ok(set, "ordinary HOME must write the native Yf optimistic atom");
  assert.strictEqual(set[1], "YF");
  assert.deepStrictEqual(set[2].key, {
    conversationId: null,
    hasConversation: false,
    hostId: "local",
    cwd: "C:/projA",
  });
  assert.deepStrictEqual(set[3], { model: "gpt-5.2", reasoningEffort: "high" });
  assert.ok(calls.some((c) => c[0] === "clear" && c[1] === "local"));
  assert.ok(!calls.some((c) => c[0] === "native-set"));
  assert.ok(!calls.some((c) => ["config", "batchWrite", "sendRequest"].includes(c[0])));
});

test("native _U: saved-thread and managed-draft paths stay native", async () => {
  const saved = makeUHarness({ draft: false, cid: "thread-1" });
  assert.strictEqual(
    await saved.api.setModelAndReasoningEffort("gpt-5.2", "high", { persistAsDefault: false }),
    true
  );
  assert.ok(saved.calls.some((c) => c[0] === "native-set"));
  assert.ok(!saved.calls.some((c) => c[0] === "set"));

  const draft = makeUHarness({ draft: true, cid: null });
  assert.strictEqual(
    await draft.api.setModelAndReasoningEffort("gpt-5.2", "high", { persistAsDefault: false }),
    true
  );
  assert.ok(draft.calls.some((c) => c[0] === "draft-update"));
  assert.ok(draft.calls.some((c) => c[0] === "clear"));
  assert.ok(!draft.calls.some((c) => c[0] === "set"));
  assert.ok(!draft.calls.some((c) => c[0] === "native-set"));
});

// ---------------------------------------------------------------------------
// Pure model core helpers
// ---------------------------------------------------------------------------

function evaluateCore(coreSource) {
  return model.evaluateModelCore(coreSource)(() => ["C:/projA"], fakeNorm);
}

test("core: pair validation and project-key isolation", () => {
  const core = evaluateCore();
  assert.deepStrictEqual(core.__companionModelValidatePair("gpt-5.2", "high"), {
    model: "gpt-5.2",
    effort: "high",
  });
  for (const bad of [
    [null, "high"],
    ["gpt", null],
    ["", "high"],
    ["gpt", ""],
    [123, "high"],
    ["gpt", 42],
    ["x".repeat(201), "high"],
  ]) {
    assert.strictEqual(core.__companionModelValidatePair(bad[0], bad[1]), null, JSON.stringify(bad));
  }

  const a = core.__companionModelProjectKey(["C:/projA"]);
  const b = core.__companionModelProjectKey(["C:/projB"]);
  assert.notStrictEqual(a, b);
  assert.strictEqual(core.__companionModelProjectKey(["C:/b", "C:/a"]), core.__companionModelProjectKey(["C:/a", "C:/b"]));
  assert.strictEqual(core.__companionModelProjectKey([]), null);
  assert.strictEqual(core.__companionModelProjectKey([""]), null);
  assert.match(a, /^[0-9a-f]+$/);
});

test("core: getProjectModel returns null without context, roots, or stored pair", async () => {
  const core = evaluateCore();
  assert.strictEqual(await core.__companionWorkflowGetProjectModel(null), null);
  assert.strictEqual(
    await core.__companionWorkflowGetProjectModel({ __companionWorkflowContext: null }),
    null
  );
  const emptyMemento = makeMemento();
  assert.strictEqual(
    await core.__companionWorkflowGetProjectModel({ __companionWorkflowContext: { workspaceState: emptyMemento } }),
    null
  );
});

test("core: write then read round-trips and isolates two projects in one store", async () => {
  const core = evaluateCore();
  const memento = makeMemento();
  const provider = { __companionWorkflowContext: { workspaceState: memento } };

  const rootsA = () => ["C:/projA"];
  const rootsB = () => ["C:/projB"];
  const coreA = model.evaluateModelCore()(rootsA, fakeNorm);
  const coreB = model.evaluateModelCore()(rootsB, fakeNorm);

  await coreA.__companionModelWrite(provider, { model: "gpt-a", effort: "low" });
  await coreB.__companionModelWrite(provider, { model: "gpt-b", effort: "ultra" });
  assert.deepStrictEqual(coreA.__companionWorkflowGetProjectModel(provider), { model: "gpt-a", effort: "low" });

  assert.deepStrictEqual(await coreA.__companionWorkflowGetProjectModel(provider), {
    model: "gpt-a",
    effort: "low",
  });
  assert.deepStrictEqual(await coreB.__companionWorkflowGetProjectModel(provider), {
    model: "gpt-b",
    effort: "ultra",
  });
  assert.strictEqual(memento.store["companion.projectModel.v1"].byProject[coreA.__companionModelProjectKey(["C:/projA"])].source, "picker");
});

// ---------------------------------------------------------------------------
// Host message handlers
// ---------------------------------------------------------------------------

function makeHostScope(roots) {
  const h = evaluateHostHelpers();
  const hb = h(() => roots, fakeNorm, () => false);
  return { h, hb, roots };
}

test("host request: no bridge context -> pending (never a fallback success)", async () => {
  const { hb } = makeHostScope(["C:/projA"]);
  const { provider, outgoing } = makeHost({ memento: null, panels: [["p1", { id: "w1" }]] });
  await hb.__companionModelHandleRequest(provider, { id: "w1" }, { type: "companion-project-model-request", requestId: "r1", hostId: "local" });
  assert.deepStrictEqual(outgoing, [
    { webview: { id: "w1" }, message: { type: "companion-project-model", requestId: "r1", pending: true } },
  ]);
});

test("host request: no stored pair -> valid:false; stored pair -> valid:true with both fields", async () => {
  const { hb } = makeHostScope(["C:/projA"]);
  const memento = makeMemento();
  const { provider, outgoing } = makeHost({ memento, panels: [["p1", { id: "w1" }]] });
  await hb.__companionModelHandleRequest(provider, { id: "w1" }, { type: "companion-project-model-request", requestId: "r2", hostId: "local" });
  assert.deepStrictEqual(outgoing[0].message, { type: "companion-project-model", requestId: "r2", valid: false });

  outgoing.length = 0;
  await hb.__companionModelHandleSelected(
    provider,
    { id: "w1" },
    { type: "companion-project-model-selected", hostId: "local", model: "gpt-5.2", effort: "high", conversationId: null }
  );
  await hb.__companionModelHandleRequest(provider, { id: "w1" }, { type: "companion-project-model-request", requestId: "r3", hostId: "local" });
  assert.deepStrictEqual(outgoing[0].message, {
    type: "companion-project-model",
    requestId: "r3",
    valid: true,
    model: "gpt-5.2",
    effort: "high",
  });
});

test("host selected: invalid pair, empty roots, non-local host, or sidebar webview never write", async () => {
  const hb = evaluateHostHelpers()(() => ["C:/projA"], fakeNorm, () => false);
  const memento = makeMemento();
  const { provider } = makeHost({ memento, panels: [["p1", { id: "w1" }]] });

  await hb.__companionModelHandleSelected(provider, { id: "w1" }, { type: "x", hostId: "local", model: "", effort: "high" });
  await hb.__companionModelHandleSelected(provider, { id: "w1" }, { type: "x", hostId: "cloud", model: "gpt", effort: "high" });
  await hb.__companionModelHandleSelected(provider, { id: "sidebar" }, { type: "x", hostId: "local", model: "gpt", effort: "high" });
  assert.strictEqual(memento.calls.update.length, 0);

  const hbEmpty = evaluateHostHelpers()(() => [], fakeNorm, () => false);
  await hbEmpty.__companionModelHandleSelected(
    provider,
    { id: "w1" },
    { type: "x", hostId: "local", model: "gpt", effort: "high" }
  );
  assert.strictEqual(memento.calls.update.length, 0);
});

test("host selected: persists only the current project key and nothing else", async () => {
  const hb = evaluateHostHelpers()(() => ["C:/projA", "C:/projB"], fakeNorm, () => false);
  const memento = makeMemento();
  const { provider } = makeHost({ memento, panels: [["p1", { id: "w1" }]] });
  await hb.__companionModelHandleSelected(
    provider,
    { id: "w1" },
    { type: "x", hostId: "local", model: "m1", effort: "medium" }
  );
  assert.strictEqual(memento.calls.update.length, 1);
  const store = memento.store["companion.projectModel.v1"];
  assert.strictEqual(Object.keys(store.byProject).length, 1);
  const entry = Object.values(store.byProject)[0];
  assert.deepStrictEqual(
    { model: entry.model, effort: entry.effort, source: entry.source },
    { model: "m1", effort: "medium", source: "picker" }
  );
});

test("host selected: a failed memento update never interrupts the next write", async () => {
  const hb = evaluateHostHelpers()(() => ["C:/projA"], fakeNorm, () => false);
  let failNext = true;
  const failingMemento = {
    calls: { get: [], update: [] },
    get(key) {
      this.calls.get.push(key);
      return undefined;
    },
    update(key, value) {
      this.calls.update.push({ key, value });
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error("disk failure"));
      }
      return Promise.resolve();
    },
  };
  const { provider } = makeHost({ memento: failingMemento, panels: [["p1", { id: "w1" }]] });
  // First write fails internally but must not reject or break the chat.
  await hb.__companionModelHandleSelected(provider, { id: "w1" }, { type: "x", hostId: "local", model: "m1", effort: "low" });
  await hb.__companionModelHandleSelected(provider, { id: "w1" }, { type: "x", hostId: "local", model: "m2", effort: "low" });
  assert.strictEqual(failingMemento.calls.update.length, 2);
});

test("core: an older picker invocation cannot overwrite a newer stored intent", async () => {
  const core = evaluateCore();
  const memento = makeMemento();
  const provider = { __companionWorkflowContext: { workspaceState: memento } };
  await core.__companionModelWrite(provider, { model: "newer", effort: "high" }, 2000);
  await core.__companionModelWrite(provider, { model: "older", effort: "low" }, 1000);
  assert.deepStrictEqual(core.__companionWorkflowGetProjectModel(provider), {
    model: "newer",
    effort: "high",
  });
  await core.__companionModelWrite(provider, { model: "newest", effort: "medium" }, 3000);
  assert.deepStrictEqual(core.__companionWorkflowGetProjectModel(provider), {
    model: "newest",
    effort: "medium",
  });
});

test("host request/selected only talk to workspaceState and never config/batchWrite or task RPC", async () => {
  const hb = evaluateHostHelpers()(() => ["C:/projA"], fakeNorm, () => false);
  const memento = makeMemento();
  const { provider } = makeHost({ memento, panels: [["p1", { id: "w1" }]] });
  // The provider exposes no config/batchWrite/task surface; the glue never references one.
  assert.strictEqual(provider.config, undefined);
  assert.strictEqual(provider.batchWrite, undefined);
  assert.strictEqual(provider.codexMcpConnection, undefined);
  await hb.__companionModelHandleSelected(
    provider,
    { id: "w1" },
    { type: "x", hostId: "local", model: "m1", effort: "low" }
  );
  assert.deepStrictEqual(memento.calls.get, ["companion.projectModel.v1"]);
  assert.deepStrictEqual(memento.calls.update.map((u) => u.key), ["companion.projectModel.v1"]);
});

// ---------------------------------------------------------------------------
// Renderer picker wrappers
// ---------------------------------------------------------------------------

function wrapState() {
  return {
    applied: false,
    userChose: false,
    reqId: null,
    retries: 0,
    pair: null,
    pendingChoices: 0,
    choiceSeq: 0,
    lastChoiceSeq: 0,
    applyPending: null,
  };
}

test("renderer wrap: successful set reports model+effort and marks user choice", async () => {
  const g = evaluateRendererGlue();
  const dispatched = [];
  const vm = { dispatchMessage(type, payload) { dispatched.push({ type, payload }); } };
  const cell = { current: { conversationId: "thread-1", hostId: "local", isAeonDraft: false, lockedEffort: null } };
  const state = { current: wrapState() };
  const wrapped = g.__companionModelWrapSet((m, e) => Promise.resolve(true), cell, state, vm);
  assert.strictEqual(await wrapped("gpt-5.2", "high"), true);
  assert.strictEqual(state.current.userChose, true);
  assert.strictEqual(dispatched.length, 1);
  assert.deepStrictEqual(
    {
      hostId: dispatched[0].payload.hostId,
      model: dispatched[0].payload.model,
      effort: dispatched[0].payload.effort,
      conversationId: dispatched[0].payload.conversationId,
    },
    { hostId: "local", model: "gpt-5.2", effort: "high", conversationId: "thread-1" }
  );
  assert.strictEqual(typeof dispatched[0].payload.intentAt, "number");
  assert.strictEqual(dispatched[0].payload.intentSeq, 1);
});

test("renderer wrap: locked/rejected outcome reports nothing and preserves the native result", async () => {
  const g = evaluateRendererGlue();
  const dispatched = [];
  const vm = { dispatchMessage(type, payload) { dispatched.push({ type, payload }); } };
  const cell = { current: { conversationId: null, hostId: "local", isAeonDraft: true, lockedEffort: null } };
  const state = { current: wrapState() };

  const locked = g.__companionModelWrapSet(() => Promise.resolve(false), cell, state, vm);
  assert.strictEqual(await locked("x", "y"), false);
  assert.strictEqual(state.current.userChose, false);
  assert.strictEqual(state.current.pendingChoices, 0);
  assert.deepStrictEqual(dispatched, []);

  const rejecting = g.__companionModelWrapSet(() => Promise.reject(new Error("boom")), cell, state, vm);
  await assert.rejects(() => rejecting("x", "y"), /boom/);
  assert.strictEqual(state.current.pendingChoices, 0);
  assert.deepStrictEqual(dispatched, []);

  const throwing = g.__companionModelWrapSet(() => { throw new Error("sync"); }, cell, state, vm);
  assert.throws(() => throwing("x", "y"), /sync/);
  assert.strictEqual(state.current.pendingChoices, 0);
  assert.deepStrictEqual(dispatched, []);
});

test("renderer wrap: locked effort wins and new-empty chat reports null conversationId", async () => {
  const g = evaluateRendererGlue();
  const dispatched = [];
  const vm = { dispatchMessage(type, payload) { dispatched.push({ type, payload }); } };
  const cell = { current: { conversationId: null, hostId: "local", isAeonDraft: true, lockedEffort: "persistent" } };
  const state = { current: wrapState() };
  const wrapped = g.__companionModelWrapSet((m, e) => Promise.resolve(true), cell, state, vm);
  await wrapped("gpt-x", "high");
  const { intentAt, intentSeq, ...payload } = dispatched[0].payload;
  assert.strictEqual(typeof intentAt, "number");
  assert.strictEqual(intentSeq, 1);
  assert.deepStrictEqual(payload, {
    hostId: "local",
    model: "gpt-x",
    effort: "persistent",
    conversationId: null,
  });
});

test("renderer wrap: select passes the callback through unchanged", async () => {
  const g = evaluateRendererGlue();
  const vm = { dispatchMessage() {} };
  const cell = { current: { conversationId: "t1", hostId: "local", isAeonDraft: false, lockedEffort: null } };
  const state = { current: wrapState() };
  let cb = false;
  const wrapped = g.__companionModelWrapSelect((m, e, done) => { done(); return Promise.resolve(true); }, cell, state, vm);
  await wrapped("m", "low", () => { cb = true; });
  assert.strictEqual(cb, true);
  assert.strictEqual(state.current.userChose, true);
});

test("renderer wrap: a remote host is never reported as local", async () => {
  const g = evaluateRendererGlue();
  const dispatched = [];
  const vm = { dispatchMessage(type, payload) { dispatched.push({ type, payload }); } };
  const cell = { current: { conversationId: "thread-1", hostId: "remote", isAeonDraft: false, lockedEffort: null } };
  const state = { current: wrapState() };
  const wrapped = g.__companionModelWrapSet(() => Promise.resolve(true), cell, state, vm);
  assert.strictEqual(await wrapped("gpt-5.2", "high"), true);
  assert.strictEqual(state.current.userChose, true);
  assert.deepStrictEqual(dispatched, []);
});

test("renderer wrap: an older delayed success cannot overwrite a newer deliberate choice", async () => {
  const g = evaluateRendererGlue();
  const dispatched = [];
  const vm = { dispatchMessage(type, payload) { dispatched.push({ type, payload }); } };
  const cell = { current: { conversationId: null, hostId: "local", isAeonDraft: false, lockedEffort: null } };
  const state = { current: wrapState() };
  const first = deferred();
  const second = deferred();
  const wrapped = g.__companionModelWrapSet((m) => (m === "first" ? first.promise : second.promise), cell, state, vm);
  const p1 = wrapped("first", "low");
  const p2 = wrapped("second", "high");
  second.resolve(true);
  assert.strictEqual(await p2, true);
  first.resolve(true);
  assert.strictEqual(await p1, true);
  assert.strictEqual(dispatched.length, 1);
  assert.strictEqual(dispatched[0].payload.model, "second");
  assert.strictEqual(dispatched[0].payload.intentSeq, 2);
});

// ---------------------------------------------------------------------------
// Renderer empty-local restore effect
// ---------------------------------------------------------------------------

const READY_CATALOG = {
  isLoading: false,
  data: {
    models: [
      {
        model: "gpt-5.2",
        supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "medium" }],
      },
    ],
  },
};

function respondRestore(h, pair) {
  const listener = h.handler;
  assert.ok(listener, "restore listener must exist before the response");
  listener.handler({
    type: "companion-project-model",
    requestId: h.state.current.reqId,
    valid: true,
    model: pair.model,
    effort: pair.effort,
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("restore: ordinary HOME (isAeonDraft false) requests and applies the stored pair", async () => {
  const h = makeRestoreHarness({ isDraft: false, n: null, catalog: READY_CATALOG });
  assert.deepStrictEqual(h.rUCalls, [{ hostId: "local", enabled: true }]);
  assert.strictEqual(h.dispatched.length, 1);
  assert.deepStrictEqual(h.dispatched[0], {
    type: "companion-project-model-request",
    payload: { requestId: h.state.current.reqId, hostId: "local" },
  });

  respondRestore(h, { model: "gpt-5.2", effort: "high" });
  assert.deepStrictEqual(h.applied, [
    { m: "gpt-5.2", e: "high", opts: { persistAsDefault: false } },
  ]);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(h.state.current.applied, true);
  assert.strictEqual(h.state.current.pair, null);
  assert.strictEqual(
    h.dispatched.filter((d) => d.type === "companion-project-model-selected").length,
    0,
    "restoring a stored pair must not write a new preference"
  );
  h.cleanup();
});

test("restore: managed draft still requests and applies through the native draft branch", () => {
  const h = makeRestoreHarness({ isDraft: true, n: null, catalog: READY_CATALOG });
  respondRestore(h, { model: "gpt-5.2", effort: "medium" });
  assert.deepStrictEqual(h.applied, [
    { m: "gpt-5.2", e: "medium", opts: { persistAsDefault: false } },
  ]);
  h.cleanup();
});

test("restore: saved conversations and remote empty views never request", () => {
  const saved = makeRestoreHarness({ isDraft: false, n: "saved-thread", r: "local", catalog: READY_CATALOG });
  assert.strictEqual(saved.dispatched.length, 0);
  assert.strictEqual(saved.handler, undefined);
  assert.deepStrictEqual(saved.rUCalls, [{ hostId: "local", enabled: false }]);
  saved.cleanup();

  const remote = makeRestoreHarness({ isDraft: false, n: null, r: "remote-host", catalog: READY_CATALOG });
  assert.strictEqual(remote.dispatched.length, 0);
  assert.strictEqual(remote.handler, undefined);
  assert.deepStrictEqual(remote.rUCalls, [{ hostId: "remote-host", enabled: false }]);
  remote.cleanup();
});

test("restore: delayed catalog readiness retains the pair and applies exactly once", async () => {
  const h = makeRestoreHarness({
    isDraft: false,
    n: null,
    catalog: { isLoading: true, data: null },
  });
  respondRestore(h, { model: "gpt-5.2", effort: "high" });
  assert.deepStrictEqual(h.applied, []);
  assert.deepStrictEqual(h.state.current.pair, { model: "gpt-5.2", effort: "high" });
  assert.strictEqual(h.state.current.applied, false);

  h.render({ catalog: READY_CATALOG });
  assert.deepStrictEqual(h.applied, [
    { m: "gpt-5.2", e: "high", opts: { persistAsDefault: false } },
  ]);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(h.state.current.applied, true);

  h.render({ catalog: READY_CATALOG });
  assert.strictEqual(h.applied.length, 1);
  h.cleanup();
});

test("restore: removed model, unsupported effort, catalog error or lock never applies", () => {
  const unsupported = makeRestoreHarness({
    isDraft: false,
    n: null,
    catalog: { isLoading: false, data: { models: [{ model: "gpt-5.2", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }] } },
  });
  respondRestore(unsupported, { model: "gpt-5.2", effort: "high" });
  assert.deepStrictEqual(unsupported.applied, []);
  assert.strictEqual(unsupported.state.current.applied, true);
  assert.strictEqual(unsupported.state.current.pair, null);
  unsupported.cleanup();

  const removed = makeRestoreHarness({ isDraft: false, n: null, catalog: READY_CATALOG });
  respondRestore(removed, { model: "removed-model", effort: "high" });
  assert.deepStrictEqual(removed.applied, []);
  assert.strictEqual(removed.state.current.applied, true);
  removed.cleanup();

  const errored = makeRestoreHarness({
    isDraft: false,
    n: null,
    catalog: { isLoading: false, isError: true, data: null },
  });
  respondRestore(errored, { model: "gpt-5.2", effort: "high" });
  assert.deepStrictEqual(errored.applied, []);
  assert.strictEqual(errored.state.current.applied, true);
  errored.cleanup();

  const locked = makeRestoreHarness({ isDraft: false, n: null, locked: true, catalog: READY_CATALOG });
  respondRestore(locked, { model: "gpt-5.2", effort: "high" });
  assert.deepStrictEqual(locked.applied, []);
  assert.strictEqual(locked.state.current.applied, true);
  locked.cleanup();

  const lockedEffort = makeRestoreHarness({ isDraft: false, n: null, lockedEffort: "persistent", catalog: READY_CATALOG });
  respondRestore(lockedEffort, { model: "gpt-5.2", effort: "high" });
  assert.deepStrictEqual(lockedEffort.applied, []);
  assert.strictEqual(lockedEffort.state.current.applied, true);
  lockedEffort.cleanup();
});

test("restore: modelSettings loading waits, then applies", () => {
  const h = makeRestoreHarness({ isDraft: false, n: null, catalog: READY_CATALOG });
  h.i.modelSettings.isLoading = true;
  respondRestore(h, { model: "gpt-5.2", effort: "high" });
  assert.deepStrictEqual(h.applied, []);
  assert.strictEqual(h.state.current.applied, false);

  h.i.modelSettings.isLoading = false;
  h.render();
  assert.deepStrictEqual(h.applied, [
    { m: "gpt-5.2", e: "high", opts: { persistAsDefault: false } },
  ]);
  h.cleanup();
});

test("restore: a false native setter result keeps the pair pending instead of marking applied", async () => {
  const custom = {
    modelSettings: { isLoading: false },
    setModelAndReasoningEffort() {
      return Promise.resolve(false);
    },
  };
  const h = makeRestoreHarness({ isDraft: false, n: null, catalog: READY_CATALOG, i: custom });
  respondRestore(h, { model: "gpt-5.2", effort: "high" });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(h.state.current.applied, false);
  assert.deepStrictEqual(h.state.current.pair, { model: "gpt-5.2", effort: "high" });
  h.cleanup();
});

test("restore: a stale requestId or invalid pair is ignored", () => {
  const h = makeRestoreHarness({ isDraft: false, n: null, catalog: READY_CATALOG });
  h.handler.handler({ type: "companion-project-model", requestId: "other-id", valid: true, model: "gpt-5.2", effort: "high" });
  h.handler.handler({ type: "companion-project-model", requestId: h.state.current.reqId, valid: true, model: null, effort: "high" });
  h.handler.handler({ type: "companion-project-model", requestId: h.state.current.reqId, valid: false });
  assert.deepStrictEqual(h.applied, []);
  assert.strictEqual(h.state.current.pair, null);
  h.cleanup();
});

test("restore: a deliberate user choice wins over a delayed stored-pair response", () => {
  const h = makeRestoreHarness({ isDraft: false, n: null, catalog: READY_CATALOG });
  h.state.current.userChose = true;
  respondRestore(h, { model: "gpt-5.2", effort: "high" });
  assert.deepStrictEqual(h.applied, []);
  assert.strictEqual(h.state.current.applied, false);
  h.cleanup();
});

test("restore: a pending picker choice blocks restore, and a failed choice releases it", async () => {
  const g = evaluateRendererGlue();
  const h = makeRestoreHarness({ isDraft: false, n: null, catalog: READY_CATALOG });
  const choice = deferred();
  const wrapped = g.__companionModelWrapSet(() => choice.promise, h.cell, h.state, h.vm);
  const pending = wrapped("user-model", "low");
  assert.strictEqual(h.state.current.pendingChoices, 1);

  respondRestore(h, { model: "gpt-5.2", effort: "high" });
  assert.deepStrictEqual(h.applied, [], "restore must not overwrite an explicit pending choice");
  assert.deepStrictEqual(h.state.current.pair, { model: "gpt-5.2", effort: "high" });

  choice.resolve(false);
  assert.strictEqual(await pending, false);
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(h.state.current.pendingChoices, 0);
  assert.deepStrictEqual(h.applied, [
    { m: "gpt-5.2", e: "high", opts: { persistAsDefault: false } },
  ]);
  h.cleanup();
});

test("restore: a successful pending choice suppresses the stored pair for good", async () => {
  const g = evaluateRendererGlue();
  const h = makeRestoreHarness({ isDraft: false, n: null, catalog: READY_CATALOG });
  const choice = deferred();
  const wrapped = g.__companionModelWrapSet(() => choice.promise, h.cell, h.state, h.vm);
  const pending = wrapped("user-model", "low");
  respondRestore(h, { model: "gpt-5.2", effort: "high" });
  assert.deepStrictEqual(h.applied, []);

  choice.resolve(true);
  assert.strictEqual(await pending, true);
  assert.strictEqual(h.state.current.userChose, true);
  assert.strictEqual(h.state.current.applied, true);
  assert.strictEqual(h.state.current.pair, null);
  assert.deepStrictEqual(h.applied, []);
  h.cleanup();
});

test("restore: pending replies retry a bounded number of times and never apply", () => {
  const realSetTimeout = global.setTimeout;
  const scheduled = [];
  global.setTimeout = (cb, ms) => { scheduled.push({ cb, ms }); return scheduled.length; };
  try {
    const h = makeRestoreHarness({ isDraft: false, n: null, catalog: READY_CATALOG });
    for (let i = 0; i < 8; i++) {
      h.handler.handler({ type: "companion-project-model", requestId: h.state.current.reqId, pending: true });
    }
    assert.strictEqual(h.state.current.retries, 5);
    assert.deepStrictEqual(h.applied, []);
    assert.strictEqual(scheduled.length, 5);
    h.cleanup();
  } finally {
    global.setTimeout = realSetTimeout;
  }
});

test("restore: the restore path never touches config/batchWrite or a task RPC", () => {
  const extraCalls = [];
  const custom = {
    modelSettings: { isLoading: false },
    setModelAndReasoningEffort(m, e, opts) {
      extraCalls.push(["setModelAndReasoningEffort", m, e, opts]);
      return Promise.resolve(true);
    },
    setDefaultModelConfig() {
      extraCalls.push(["setDefaultModelConfig"]);
    },
    setModelAndReasoningEffortForNextTurn() {
      extraCalls.push(["setModelAndReasoningEffortForNextTurn"]);
    },
  };
  const h = makeRestoreHarness({ isDraft: false, n: null, catalog: READY_CATALOG, i: custom });
  respondRestore(h, { model: "gpt-5.2", effort: "high" });
  assert.deepStrictEqual(extraCalls, [
    ["setModelAndReasoningEffort", "gpt-5.2", "high", { persistAsDefault: false }],
  ]);
  h.cleanup();
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// End-to-end: renderer report -> host persistence
// ---------------------------------------------------------------------------

test("end-to-end: a saved-thread pick persists the pair to the project store", async () => {
  const g = evaluateRendererGlue();
  const memento = makeMemento();
  const { provider } = makeHost({ memento, panels: [["p1", { id: "w1" }]] });
  const hb = evaluateHostHelpers()(() => ["C:/projA"], fakeNorm, () => false);
  const cell = { current: { conversationId: "thread-1", hostId: "local", isAeonDraft: false, lockedEffort: null } };
  const state = { current: wrapState() };
  const vm = {
    dispatchMessage(type, payload) {
      if (type === "companion-project-model-selected") {
        void hb.__companionModelHandleSelected(provider, { id: "w1" }, { type, ...payload });
      }
    },
  };
  const wrapped = g.__companionModelWrapSet(() => Promise.resolve(true), cell, state, vm);
  await wrapped("gpt-5.2", "high");
  await new Promise((r) => setImmediate(r));
  const store = memento.store["companion.projectModel.v1"];
  assert.ok(store, "picker selection must be persisted");
  const entry = Object.values(store.byProject)[0];
  assert.deepStrictEqual({ model: entry.model, effort: entry.effort, source: entry.source }, {
    model: "gpt-5.2",
    effort: "high",
    source: "picker",
  });
});

test("end-to-end: a new-empty pick persists the pair with a null conversationId", async () => {
  const g = evaluateRendererGlue();
  const memento = makeMemento();
  const { provider } = makeHost({ memento, panels: [["p1", { id: "w1" }]] });
  const hb = evaluateHostHelpers()(() => ["C:/projA"], fakeNorm, () => false);
  const cell = { current: { conversationId: null, hostId: "local", isAeonDraft: true, lockedEffort: null } };
  const state = { current: wrapState() };
  const reported = [];
  const vm = {
    dispatchMessage(type, payload) {
      reported.push({ type, payload });
      if (type === "companion-project-model-selected") {
        void hb.__companionModelHandleSelected(provider, { id: "w1" }, { type, ...payload });
      }
    },
  };
  const wrapped = g.__companionModelWrapSet(() => Promise.resolve(true), cell, state, vm);
  await wrapped("gpt-new", "medium");
  const { intentAt, intentSeq, ...payload } = reported[0].payload;
  assert.strictEqual(typeof intentAt, "number");
  assert.strictEqual(intentSeq, 1);
  assert.deepStrictEqual(payload, {
    hostId: "local",
    model: "gpt-new",
    effort: "medium",
    conversationId: null,
  });
  await new Promise((r) => setImmediate(r));
  const store = memento.store["companion.projectModel.v1"];
  const entry = Object.values(store.byProject)[0];
  assert.deepStrictEqual({ model: entry.model, effort: entry.effort }, { model: "gpt-new", effort: "medium" });
});

test("host handlers address the exact sending panel and never a different one", async () => {
  const hb = evaluateHostHelpers()(() => ["C:/projA"], fakeNorm, () => false);
  const memento = makeMemento();
  const { provider, outgoing } = makeHost({
    memento,
    panels: [
      ["p1", { id: "w1" }],
      ["p2", { id: "w2" }],
    ],
  });

  await hb.__companionModelHandleRequest(
    provider,
    { id: "w1" },
    { type: "companion-project-model-request", requestId: "rA", hostId: "local" }
  );
  assert.strictEqual(outgoing.length, 1);
  assert.strictEqual(outgoing[0].webview.id, "w1");

  await hb.__companionModelHandleSelected(
    provider,
    { id: "w2" },
    { type: "companion-project-model-selected", hostId: "local", model: "m2", effort: "low" }
  );
  const store = memento.store["companion.projectModel.v1"];
  assert.ok(store, "selection from panel w2 must persist");
  // The first request response was sent only to w1; no cross-panel delivery.
  assert.deepStrictEqual(outgoing.map((o) => o.webview.id), ["w1"]);
});
