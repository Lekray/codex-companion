/* Companion official tab-status bridge - pure, dependency-free runtime.
 * Injected verbatim into the official Codex extension host (out/extension.js).
 * It MUST NOT import/require anything and MUST NOT export - it is evaluated as
 * a plain script. It defines global helpers referenced by the status seams.
 *
 * The host owns the status graph and panel.title. Raw app-server notifications
 * are observed before they are broadcast to webviews; duplicate renderer
 * messages are never trusted for state changes. Only metadata is persisted in
 * workspaceState (bounded, no message text, no history rewrite).
 */
function __companionWorkflowStateKey() {
  return "codexCompanion.official.v1.status";
}
function __companionWorkflowRootsKey(roots) {
  if (!Array.isArray(roots)) return "";
  var out = [];
  for (var i = 0; i < roots.length; i++) {
    var value = roots[i];
    if (typeof value !== "string" || value.length === 0) continue;
    var normalized = value.replace(/\\/g, "/");
    if (/^[A-Za-z]:\//.test(normalized) || /^\/\/[^/]+\/[^/]+/.test(normalized)) {
      normalized = normalized.toLowerCase();
    }
    out.push(normalized);
  }
  out.sort();
  return out.join("\n");
}
function __companionWorkflowCurrentRoots() {
  try {
    return typeof cR === "function" ? cR() : [];
  } catch (e) {
    return [];
  }
}
function __companionWorkflowNewId(prefix) {
  return (
    prefix +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 6)
  );
}
function __companionWorkflowString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function __companionWorkflowRequestKey(value) {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && isFinite(value)) return String(value);
  return null;
}
function __companionWorkflowNumber(value) {
  return typeof value === "number" && isFinite(value) ? value : null;
}
function __companionWorkflowStatus(value) {
  return value === "running" || value === "done" || value === "error" || value === "waiting" ? value : "idle";
}
function __companionWorkflowMarker(status) {
  if (status === "running") return "[~]";
  if (status === "done") return "[V]";
  if (status === "error") return "[!]";
  if (status === "waiting") return "[?]";
  return "";
}
function __companionWorkflowTruncate(text) {
  if (typeof TKe === "function") {
    try {
      return TKe(text);
    } catch (e) {}
  }
  return text.length > 30 ? text.substring(0, 30) + "\u2026" : text;
}
function __companionWorkflowIsSpecialPanel(provider, panel) {
  if (provider == null || panel == null) return true;
  var diff = provider.diffPanel;
  var plan = provider.planSummaryPanel;
  var settings = provider.settingsPanel;
  return (
    (diff != null && (diff === panel || diff.currentPanel === panel)) ||
    (plan != null && (plan === panel || plan.currentPanel === panel)) ||
    (settings != null && (settings === panel || settings.currentPanel === panel))
  );
}
function __companionWorkflowRecord(provider, panel) {
  if (provider == null || panel == null || provider.editorPanels == null) return null;
  var rec = provider.editorPanels.get(panel);
  return rec != null && typeof rec === "object" ? rec : null;
}
function __companionWorkflowPanelId(rec) {
  if (rec == null) return null;
  if (typeof rec.__companionWorkflowPanelId !== "string" || rec.__companionWorkflowPanelId.length === 0) {
    rec.__companionWorkflowPanelId = __companionWorkflowNewId("panel-");
  }
  return rec.__companionWorkflowPanelId;
}
function __companionWorkflowChatPanel(provider, panel) {
  if (provider == null || panel == null || __companionWorkflowIsSpecialPanel(provider, panel)) return false;
  if (typeof provider.isPanelAlive === "function") {
    try {
      return provider.isPanelAlive(panel) === true;
    } catch (e) {
      return false;
    }
  }
  return provider.editorPanels != null && typeof provider.editorPanels.has === "function" && provider.editorPanels.has(panel);
}
function __companionWorkflowBoundPanels(provider, threadId) {
  var out = [];
  if (provider == null || provider.editorPanels == null || typeof threadId !== "string") return out;
  var panels = Array.from(provider.editorPanels.keys());
  for (var i = 0; i < panels.length; i++) {
    var panel = panels[i];
    var rec = __companionWorkflowRecord(provider, panel);
    if (rec == null || rec.__companionTitleActive !== true) continue;
    if (rec.__companionTitleThreadId !== threadId) continue;
    if (!__companionWorkflowChatPanel(provider, panel)) continue;
    out.push(panel);
  }
  return out;
}
function __companionWorkflowApplyTitle(provider, panel) {
  var rec = __companionWorkflowRecord(provider, panel);
  if (rec == null || rec.__companionTitleActive !== true) return false;
  var base = __companionWorkflowString(rec.__companionTitleText);
  if (base == null) return false;
  var runtime = provider == null ? null : provider.__companionWorkflowRuntime;
  var threadId = __companionWorkflowString(rec.__companionTitleThreadId);
  var thread = runtime != null && threadId != null ? runtime.threads[threadId] : null;
  var status = thread != null ? thread.status : "idle";
  var marker = __companionWorkflowMarker(status);
  var title = (marker.length > 0 ? marker + " " : "") + __companionWorkflowTruncate(base);
  try {
    panel.title = title;
  } catch (e) {
    return false;
  }
  return true;
}
function __companionWorkflowRefreshThreadTitles(provider, threadId) {
  var panels = __companionWorkflowBoundPanels(provider, threadId);
  for (var i = 0; i < panels.length; i++) __companionWorkflowApplyTitle(provider, panels[i]);
}
function __companionWorkflowRefreshAllTitles(runtime) {
  var provider = runtime.provider;
  if (provider == null || provider.editorPanels == null) return;
  var panels = Array.from(provider.editorPanels.keys());
  for (var i = 0; i < panels.length; i++) {
    if (__companionWorkflowChatPanel(provider, panels[i])) __companionWorkflowApplyTitle(provider, panels[i]);
  }
}
function __companionWorkflowTab(runtime, provider, panel) {
  var rec = __companionWorkflowRecord(provider, panel);
  var active = rec != null && rec.__companionTitleActive === true;
  var threadId = active ? __companionWorkflowString(rec.__companionTitleThreadId) : null;
  var thread = threadId != null ? runtime.threads[threadId] : null;
  return {
    panelId: __companionWorkflowPanelId(rec) || __companionWorkflowNewId("panel-"),
    threadId: threadId,
    hostId: "local",
    route: active ? __companionWorkflowString(rec.__companionTitleRoute) : null,
    title: active && __companionWorkflowString(rec.__companionTitleText) != null ? rec.__companionTitleText : "",
    status: thread != null ? thread.status : "idle",
    turnId: thread != null ? thread.turnId : null,
    updatedAt: thread != null ? thread.updatedAt : Date.now()
  };
}
function __companionWorkflowTabs(runtime) {
  var provider = runtime.provider;
  var tabs = [];
  if (provider == null || provider.editorPanels == null) return tabs;
  var panels = Array.from(provider.editorPanels.keys());
  for (var i = 0; i < panels.length; i++) {
    var panel = panels[i];
    if (!__companionWorkflowChatPanel(provider, panel)) continue;
    tabs.push(__companionWorkflowTab(runtime, provider, panel));
  }
  return tabs;
}
function __companionWorkflowEnsureThread(runtime, threadId) {
  if (runtime == null || typeof threadId !== "string" || threadId.length === 0) return null;
  if (runtime.threads[threadId] == null) {
    runtime.threads[threadId] = {
      threadId: threadId,
      status: "idle",
      turnId: null,
      turnStartedAt: null,
      turnActive: false,
      goalStatus: null,
      completedTurnId: null,
      doneEmittedFor: null,
      pending: Object.create(null),
      pendingCount: 0,
      observedAt: 0,
      updatedAt: Date.now()
    };
    runtime.threadCount = (runtime.threadCount || 0) + 1;
    if (runtime.threadCount > 512) __companionWorkflowPruneThreads(runtime);
  }
  return runtime.threads[threadId];
}
function __companionWorkflowObserve(thread) {
  if (thread != null) thread.observedAt = Date.now();
}
function __companionWorkflowPruneThreads(runtime) {
  var ids = Object.keys(runtime.threads);
  if (ids.length <= 512) {
    runtime.threadCount = ids.length;
    return;
  }
  var keep = Object.create(null);
  var provider = runtime.provider;
  if (provider != null && provider.editorPanels != null) {
    var panels = Array.from(provider.editorPanels.keys());
    for (var i = 0; i < panels.length; i++) {
      var rec = __companionWorkflowRecord(provider, panels[i]);
      if (rec == null || rec.__companionTitleActive !== true) continue;
      var boundId = __companionWorkflowString(rec.__companionTitleThreadId);
      if (boundId != null) keep[boundId] = true;
    }
  }
  var candidates = [];
  for (var j = 0; j < ids.length; j++) {
    var thread = runtime.threads[ids[j]];
    if (thread == null || keep[ids[j]] === true) continue;
    if (thread.turnActive === true || thread.status === "running" || thread.status === "waiting") continue;
    candidates.push(thread);
  }
  candidates.sort(function (a, b) {
    return (a.updatedAt || 0) - (b.updatedAt || 0);
  });
  var target = 256;
  var remove = ids.length - target;
  for (var k = 0; k < candidates.length && remove > 0; k++, remove--) {
    var removed = candidates[k];
    delete runtime.threads[removed.threadId];
    var requestIds = Object.keys(runtime.requests);
    for (var r = 0; r < requestIds.length; r++) {
      if (runtime.requests[requestIds[r]] === removed.threadId) delete runtime.requests[requestIds[r]];
    }
  }
  runtime.threadCount = Object.keys(runtime.threads).length;
}
function __companionWorkflowEventId(threadId, turnId, status, requestKey) {
  return (
    "local|" +
    threadId +
    "|" +
    (turnId == null ? "" : turnId) +
    "|" +
    status +
    (requestKey == null ? "" : "|" + requestKey)
  );
}
function __companionWorkflowPublish(runtime, thread, status, previousStatus, turnId, requestKey, forcedEventId) {
  var eventId =
    forcedEventId != null
      ? forcedEventId
      : __companionWorkflowEventId(thread.threadId, turnId, status, requestKey);
  var panels = __companionWorkflowBoundPanels(runtime.provider, thread.threadId);
  // Unbound threads keep only metadata/title state. Historical transitions are
  // never queued or replayed when a saved chat is opened later.
  if (panels.length === 0) return;
  runtime.sequence += 1;
  var tab = __companionWorkflowTab(runtime, runtime.provider, panels[0]);
  tab.status = status;
  tab.turnId = turnId;
  tab.updatedAt = thread.updatedAt;
  var event = {
    apiVersion: 1,
    kind: "status",
    instanceId: runtime.instanceId,
    sequence: runtime.sequence,
    live: true,
    eventId: eventId,
    tab: tab,
    previousStatus: previousStatus
  };
  try {
    var result = je.commands.executeCommand("codexCompanion.official.v1.event", event);
    if (result != null && typeof result.then === "function") result.then(undefined, function () {});
  } catch (e) {}
}
function __companionWorkflowSetStatus(runtime, thread, status, extra) {
  status = __companionWorkflowStatus(status);
  var previous = thread.status;
  thread.status = status;
  thread.updatedAt = Date.now();
  if (extra != null) {
    if (extra.turnId !== undefined) thread.turnId = extra.turnId;
    if (extra.turnStartedAt !== undefined) thread.turnStartedAt = extra.turnStartedAt;
    if (extra.turnActive !== undefined) thread.turnActive = extra.turnActive;
    if (extra.completedTurnId !== undefined) thread.completedTurnId = extra.completedTurnId;
    if (extra.doneEmittedFor !== undefined) thread.doneEmittedFor = extra.doneEmittedFor;
  }
  __companionWorkflowRefreshThreadTitles(runtime.provider, thread.threadId);
  if (previous !== status) {
    __companionWorkflowPublish(
      runtime,
      thread,
      status,
      previous,
      thread.turnId,
      extra != null && extra.requestKey != null ? extra.requestKey : null
    );
  }
  __companionWorkflowSave(runtime);
}
function __companionWorkflowSave(runtime) {
  if (runtime == null || runtime.disposed) return;
  var roots = runtime.roots;
  if (!Array.isArray(roots) || roots.length === 0) return;
  var context = runtime.context;
  if (context == null || context.workspaceState == null || typeof context.workspaceState.update !== "function") return;
  var ids = Object.keys(runtime.threads);
  ids.sort(function (a, b) {
    return (runtime.threads[b].updatedAt || 0) - (runtime.threads[a].updatedAt || 0);
  });
  var threads = {};
  for (var i = 0; i < ids.length && i < 256; i++) {
    var thread = runtime.threads[ids[i]];
    if (thread == null) continue;
    threads[thread.threadId] = {
      status: __companionWorkflowStatus(thread.status),
      turnId: typeof thread.turnId === "string" ? thread.turnId : null,
      goalStatus: typeof thread.goalStatus === "string" ? thread.goalStatus : null,
      completedTurnId: typeof thread.completedTurnId === "string" ? thread.completedTurnId : null,
      updatedAt: thread.updatedAt || Date.now()
    };
  }
  try {
    var result = context.workspaceState.update(__companionWorkflowStateKey(), {
      version: 1,
      roots: roots.slice(),
      threads: threads
    });
    if (result != null && typeof result.then === "function") result.then(undefined, function () {});
  } catch (e) {}
}
function __companionWorkflowRestore(runtime) {
  var context = runtime.context;
  if (context == null || context.workspaceState == null || typeof context.workspaceState.get !== "function") return;
  if (!Array.isArray(runtime.roots) || runtime.roots.length === 0) return;
  var currentKey = __companionWorkflowRootsKey(runtime.roots);
  var result;
  try {
    result = context.workspaceState.get(__companionWorkflowStateKey());
  } catch (e) {
    return;
  }
  if (result != null && typeof result.then === "function") {
    result.then(function (saved) {
      __companionWorkflowApplyRestore(runtime, saved, currentKey);
    }, function () {});
    return;
  }
  __companionWorkflowApplyRestore(runtime, result, currentKey);
}
function __companionWorkflowApplyRestore(runtime, saved, currentKey) {
  if (runtime.disposed || saved == null || typeof saved !== "object" || saved.version !== 1) return;
  if (__companionWorkflowRootsKey(runtime.roots) !== currentKey) return;
  if (__companionWorkflowRootsKey(saved.roots) !== currentKey) return;
  var values = saved.threads;
  if (values == null || typeof values !== "object") return;
  var ids = Object.keys(values);
  for (var i = 0; i < ids.length; i++) {
    var value = values[ids[i]];
    if (value == null || typeof value !== "object") continue;
    var thread = __companionWorkflowEnsureThread(runtime, ids[i]);
    if (thread == null) continue;
    // A native notification that arrived while async state was resolving wins.
    if (thread.observedAt > 0) continue;
    var storedStatus = __companionWorkflowStatus(value.status);
    var storedTurnId = __companionWorkflowString(value.turnId);
    var storedCompletedTurnId = __companionWorkflowString(value.completedTurnId);
    thread.turnId = storedTurnId;
    thread.goalStatus = __companionWorkflowString(value.goalStatus);
    // Only a completed snapshot carries success metadata. Stale active/cancelled
    // entries must not later produce a [V] through the goal path.
    thread.completedTurnId = storedStatus === "done" ? storedCompletedTurnId : null;
    thread.turnStartedAt = null;
    thread.turnActive = false;
    thread.pending = Object.create(null);
    thread.pendingCount = 0;
    thread.doneEmittedFor =
      storedStatus === "done" && storedCompletedTurnId != null ? storedCompletedTurnId : null;
    // Reloaded running/waiting turns are not currently executing. They stay
    // idle (with their metadata) until a native active status is observed.
    thread.status =
      storedStatus === "running" || storedStatus === "waiting" ? "idle" : storedStatus;
    thread.updatedAt = __companionWorkflowNumber(value.updatedAt) || Date.now();
  }
  __companionWorkflowRefreshAllTitles(runtime);
}
function __companionWorkflowInstall(provider, context) {
  if (provider == null || typeof provider !== "object") return null;
  if (provider.__companionWorkflowRuntime != null) return provider.__companionWorkflowRuntime;
  if (context == null || typeof context !== "object") return null;
  var initialRoots = __companionWorkflowCurrentRoots();
  if (!Array.isArray(initialRoots)) initialRoots = [];
  var runtime = {
    provider: provider,
    context: context,
    instanceId: __companionWorkflowNewId("official-"),
    sequence: 0,
    roots: initialRoots,
    threads: Object.create(null),
    threadCount: 0,
    requests: Object.create(null),
    disposed: false
  };
  provider.__companionWorkflowRuntime = runtime;
  provider.__companionWorkflowContext = context;
  try {
    var getState = function () {
      if (runtime.disposed) {
        return {
          apiVersion: 1,
          instanceId: runtime.instanceId,
          sequence: runtime.sequence,
          capabilities: { statuses: false, projectModel: false },
          tabs: [],
          projectModel: null
        };
      }
      var hasModel = typeof __companionWorkflowGetProjectModel === "function";
      var model = null;
      if (hasModel) {
        try {
          model = __companionWorkflowGetProjectModel(provider);
        } catch (e) {
          model = null;
        }
      }
      return {
        apiVersion: 1,
        instanceId: runtime.instanceId,
        sequence: runtime.sequence,
        capabilities: { statuses: true, projectModel: hasModel },
        tabs: __companionWorkflowTabs(runtime),
        projectModel: model != null && typeof model === "object" ? model : null
      };
    };
    var focusTab = function (input) {
      if (runtime.disposed || input == null || typeof input !== "object") return false;
      var panelId = __companionWorkflowString(input.panelId);
      var threadId = __companionWorkflowString(input.threadId);
      if (panelId == null && threadId == null) return false;
      var tabs = __companionWorkflowTabs(runtime);
      var chosen = null;
      for (var i = 0; i < tabs.length; i++) {
        if (panelId != null && tabs[i].panelId !== panelId) continue;
        if (threadId != null && tabs[i].threadId !== threadId) continue;
        chosen = tabs[i];
        break;
      }
      if (chosen == null) return false;
      var panels = Array.from(provider.editorPanels.keys());
      for (var j = 0; j < panels.length; j++) {
        var rec = __companionWorkflowRecord(provider, panels[j]);
        if (__companionWorkflowPanelId(rec) !== chosen.panelId) continue;
        if (!__companionWorkflowChatPanel(provider, panels[j])) return false;
        try {
          if (typeof panels[j].reveal === "function") panels[j].reveal();
        } catch (e) {}
        try {
          var result = je.commands.executeCommand("workbench.action.focusWindow");
          if (result != null && typeof result.then === "function") result.then(undefined, function () {});
        } catch (e) {}
        return true;
      }
      return false;
    };
    var commandDisposables = [];
    commandDisposables.push(je.commands.registerCommand("chatgpt.companion.v1.getState", getState));
    commandDisposables.push(je.commands.registerCommand("chatgpt.companion.v1.focusTab", focusTab));
    if (context.subscriptions != null && typeof context.subscriptions.push === "function") {
      for (var i = 0; i < commandDisposables.length; i++) context.subscriptions.push(commandDisposables[i]);
    }
    if (provider.subscriptions != null && typeof provider.subscriptions.push === "function") {
      provider.subscriptions.push({
        dispose: function () {
          runtime.disposed = true;
          runtime.threads = Object.create(null);
          runtime.threadCount = 0;
          runtime.requests = Object.create(null);
        }
      });
    }
    if (je.workspace != null && typeof je.workspace.onDidChangeWorkspaceFolders === "function") {
      var subscription = je.workspace.onDidChangeWorkspaceFolders(function () {
        if (runtime.disposed) return;
        var next = __companionWorkflowCurrentRoots();
        if (!Array.isArray(next)) next = [];
        if (__companionWorkflowRootsKey(next) === __companionWorkflowRootsKey(runtime.roots)) return;
        runtime.roots = next;
        runtime.threads = Object.create(null);
        runtime.threadCount = 0;
        runtime.requests = Object.create(null);
        __companionWorkflowRefreshAllTitles(runtime);
        __companionWorkflowSave(runtime);
      });
      if (subscription != null && provider.subscriptions != null && typeof provider.subscriptions.push === "function") {
        provider.subscriptions.push(subscription);
      }
    }
    __companionWorkflowRestore(runtime);
  } catch (e) {}
  return runtime;
}
function __companionWorkflowBindTitle(provider, webview) {
  var runtime = provider == null ? null : provider.__companionWorkflowRuntime;
  if (runtime == null || runtime.disposed) return false;
  var panel;
  try {
    panel = provider.findPanelByWebview(webview);
  } catch (e) {
    return false;
  }
  if (panel == null || !__companionWorkflowChatPanel(provider, panel)) return false;
  var rec = __companionWorkflowRecord(provider, panel);
  if (rec == null) return false;
  __companionWorkflowPanelId(rec);
  if (rec.__companionTitleActive !== true) {
    rec.__companionWorkflowThreadId = null;
    return false;
  }
  var threadId = __companionWorkflowString(rec.__companionTitleThreadId);
  if (threadId == null) {
    rec.__companionWorkflowThreadId = null;
    return false;
  }
  rec.__companionWorkflowThreadId = threadId;
  __companionWorkflowEnsureThread(runtime, threadId);
  __companionWorkflowApplyTitle(provider, panel);
  return true;
}
function __companionWorkflowNotification(provider, message) {
  var runtime = provider == null ? null : provider.__companionWorkflowRuntime;
  if (runtime == null || runtime.disposed || message == null || typeof message !== "object") return false;
  var method = message.method;
  var params = message.params != null && typeof message.params === "object" ? message.params : {};
  try {
    if (method === "thread/status/changed") {
      var threadId = __companionWorkflowString(params.threadId);
      var status = params.status;
      if (threadId == null || status == null || typeof status !== "object") return false;
      var thread = __companionWorkflowEnsureThread(runtime, threadId);
      if (thread == null) return false;
      __companionWorkflowObserve(thread);
      if (status.type === "active") {
        var flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
        var waiting =
          flags.indexOf("waitingOnApproval") !== -1 || flags.indexOf("waitingOnUserInput") !== -1;
        __companionWorkflowSetStatus(runtime, thread, waiting ? "waiting" : "running", {
          turnActive: true
        });
        return true;
      }
      if (status.type === "systemError") {
        __companionWorkflowSetStatus(runtime, thread, "error", { turnActive: false });
        return true;
      }
      if (status.type === "idle") {
        // Idle alone is never a successful completion; cancelled/interrupted
        // turns settle here without a [V] marker.
        if (
          thread.turnActive === true &&
          thread.turnId != null &&
          (thread.status === "running" || thread.status === "waiting")
        ) {
          // A tracked turn may report idle slightly before turn/completed.
          // Keep the observed active state so the real terminal event still
          // publishes running/waiting -> done instead of a suppressed idle.
          return true;
        }
        if (thread.status === "running" || thread.status === "waiting") {
          __companionWorkflowSetStatus(runtime, thread, "idle", { turnActive: false });
        }
        return true;
      }
      return false;
    }
    if (method === "turn/started") {
      var turn = params.turn;
      var startedThread = __companionWorkflowString(params.threadId);
      var startedId = turn != null ? __companionWorkflowString(turn.id) : null;
      if (startedThread == null || startedId == null) return false;
      var startedThreadState = __companionWorkflowEnsureThread(runtime, startedThread);
      if (startedThreadState == null) return false;
      __companionWorkflowObserve(startedThreadState);
      startedThreadState.pending = Object.create(null);
      startedThreadState.pendingCount = 0;
      var requestIds = Object.keys(runtime.requests);
      for (var requestIndex = 0; requestIndex < requestIds.length; requestIndex++) {
        if (runtime.requests[requestIds[requestIndex]] === startedThread) {
          delete runtime.requests[requestIds[requestIndex]];
        }
      }
      __companionWorkflowSetStatus(runtime, startedThreadState, "running", {
        turnId: startedId,
        turnStartedAt: __companionWorkflowNumber(turn.startedAt),
        turnActive: true,
        completedTurnId: null,
        doneEmittedFor: null
      });
      return true;
    }
    if (method === "turn/completed") {
      var completed = params.turn;
      var completedThread = __companionWorkflowString(params.threadId);
      var completedId = completed != null ? __companionWorkflowString(completed.id) : null;
      if (completedThread == null || completedId == null) return false;
      var completedThreadState = __companionWorkflowEnsureThread(runtime, completedThread);
      if (completedThreadState == null) return false;
      __companionWorkflowObserve(completedThreadState);
      var startedAt = completed != null ? __companionWorkflowNumber(completed.startedAt) : null;
      if (completedThreadState.turnId != null && completedThreadState.turnId !== completedId) {
        // No live start was observed (hydrated metadata): accept the terminal.
        // After a newer start, a different turn is stale unless its timestamp
        // proves it started later.
        if (
          completedThreadState.turnStartedAt != null &&
          (startedAt == null || startedAt <= completedThreadState.turnStartedAt)
        ) {
          return false;
        }
      }
      if (
        startedAt != null &&
        completedThreadState.turnStartedAt != null &&
        startedAt < completedThreadState.turnStartedAt
      ) {
        return false;
      }
      if (
        startedAt != null &&
        (completedThreadState.turnStartedAt == null || startedAt > completedThreadState.turnStartedAt)
      ) {
        completedThreadState.turnStartedAt = startedAt;
      }
      completedThreadState.turnActive = false;
      completedThreadState.turnId = completedId;
      var terminal = completed.status;
      if (terminal === "completed") {
        completedThreadState.completedTurnId = completedId;
        if (completedThreadState.goalStatus != null && completedThreadState.goalStatus !== "complete") {
          var goalStatus = completedThreadState.goalStatus;
          if (goalStatus === "active") {
            __companionWorkflowSetStatus(runtime, completedThreadState, "running", { turnActive: false });
          } else {
            __companionWorkflowSetStatus(runtime, completedThreadState, "waiting", { turnActive: false });
          }
        } else if (completedThreadState.doneEmittedFor !== completedId) {
          completedThreadState.doneEmittedFor = completedId;
          __companionWorkflowSetStatus(runtime, completedThreadState, "done", { turnActive: false });
        }
        return true;
      }
      if (terminal === "failed") {
        __companionWorkflowSetStatus(runtime, completedThreadState, "error", { turnActive: false });
        return true;
      }
      if (terminal === "interrupted" || terminal === "cancelled" || terminal === "canceled") {
        __companionWorkflowSetStatus(runtime, completedThreadState, "idle", { turnActive: false });
        return true;
      }
      return false;
    }
    if (method === "serverRequest/resolved") {
      var requestId = __companionWorkflowRequestKey(params.requestId);
      var mappedThreadId =
        requestId != null ? __companionWorkflowString(runtime.requests[requestId]) : null;
      var resolvedThreadId = mappedThreadId || __companionWorkflowString(params.threadId);
      if (resolvedThreadId == null) return false;
      var resolvedThread = __companionWorkflowEnsureThread(runtime, resolvedThreadId);
      if (resolvedThread == null) return false;
      __companionWorkflowObserve(resolvedThread);
      var wasPending = false;
      if (requestId != null && resolvedThread.pending[requestId] === true) {
        wasPending = true;
        delete resolvedThread.pending[requestId];
        resolvedThread.pendingCount = Math.max(0, resolvedThread.pendingCount - 1);
      }
      if (requestId != null && mappedThreadId === resolvedThread.threadId) {
        delete runtime.requests[requestId];
      }
      if (wasPending && resolvedThread.status === "waiting" && resolvedThread.pendingCount === 0) {
        __companionWorkflowSetStatus(runtime, resolvedThread, resolvedThread.turnActive ? "running" : "idle", {});
      }
      return true;
    }
    if (method === "thread/goal/updated") {
      var goalThreadId = __companionWorkflowString(params.threadId);
      var goal = params.goal;
      if (goalThreadId == null || goal == null || typeof goal !== "object") return false;
      var goalThread = __companionWorkflowEnsureThread(runtime, goalThreadId);
      if (goalThread == null) return false;
      __companionWorkflowObserve(goalThread);
      goalThread.goalStatus = __companionWorkflowString(goal.status);
      if (goalThread.goalStatus === "complete") {
        if (goalThread.completedTurnId != null && goalThread.doneEmittedFor !== goalThread.completedTurnId) {
          goalThread.doneEmittedFor = goalThread.completedTurnId;
          __companionWorkflowSetStatus(runtime, goalThread, "done", {});
        }
      } else if (
        goalThread.goalStatus === "paused" ||
        goalThread.goalStatus === "blocked" ||
        goalThread.goalStatus === "usageLimited" ||
        goalThread.goalStatus === "budgetLimited"
      ) {
        if (goalThread.status === "running") {
          __companionWorkflowSetStatus(runtime, goalThread, "waiting", { turnActive: false });
        }
      }
      return true;
    }
    if (method === "thread/goal/cleared") {
      var clearedThreadId = __companionWorkflowString(params.threadId);
      if (clearedThreadId == null) return false;
      var clearedThread = __companionWorkflowEnsureThread(runtime, clearedThreadId);
      if (clearedThread == null) return false;
      __companionWorkflowObserve(clearedThread);
      clearedThread.goalStatus = null;
      if (clearedThread.completedTurnId != null && clearedThread.doneEmittedFor !== clearedThread.completedTurnId) {
        clearedThread.doneEmittedFor = clearedThread.completedTurnId;
        __companionWorkflowSetStatus(runtime, clearedThread, "done", {});
      } else if (clearedThread.status === "waiting" && clearedThread.pendingCount === 0 && !clearedThread.turnActive) {
        __companionWorkflowSetStatus(runtime, clearedThread, "idle", {});
      }
      return true;
    }
  } catch (e) {}
  return false;
}
function __companionWorkflowRequest(provider, request) {
  var runtime = provider == null ? null : provider.__companionWorkflowRuntime;
  if (runtime == null || runtime.disposed || request == null || typeof request !== "object") return false;
  try {
    var method = request.method;
    if (typeof method !== "string") return false;
    var params = request.params != null && typeof request.params === "object" ? request.params : {};
    var needsUser =
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      method === "item/permissions/requestApproval" ||
      method === "execCommandApproval" ||
      method === "applyPatchApproval" ||
      method === "item/tool/requestUserInput" ||
      method === "mcpServer/elicitation/request" ||
      method.indexOf("requestApproval") !== -1 ||
      method.indexOf("requestUserInput") !== -1;
    if (!needsUser) return false;
    var threadId =
      __companionWorkflowString(params.threadId) ||
      __companionWorkflowString(params.conversationId) ||
      (params.thread != null ? __companionWorkflowString(params.thread.id) : null);
    if (threadId == null) return false;
    var thread = __companionWorkflowEnsureThread(runtime, threadId);
    if (thread == null) return false;
    __companionWorkflowObserve(thread);
    var requestId = __companionWorkflowRequestKey(request.id);
    if (requestId != null) {
      runtime.requests[requestId] = threadId;
      if (thread.pending[requestId] !== true) {
        thread.pending[requestId] = true;
        thread.pendingCount += 1;
      }
    }
    if (thread.status !== "waiting") {
      __companionWorkflowSetStatus(runtime, thread, "waiting", {
        turnActive: thread.turnId != null ? true : thread.turnActive,
        requestKey: requestId
      });
    }
    return true;
  } catch (e) {
    return false;
  }
}
