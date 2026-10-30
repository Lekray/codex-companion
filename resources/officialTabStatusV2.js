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
  if (typeof __companionWindowNamesApply === "function" && __companionWindowNamesApply(provider, panel)) return true;
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
    title: typeof __companionWindowNamesBase === "function" && __companionWindowNamesBase(provider, panel) != null ? __companionWindowNamesBase(provider, panel) : active && __companionWorkflowString(rec.__companionTitleText) != null ? rec.__companionTitleText : "",
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
      asyncQuestions: Object.create(null),
      asyncQuestionCount: 0,
      settledQuestions: Object.create(null),
      settledQuestionCount: 0,
      settledQuestionKeys: Object.create(null),
      settledQuestionKeyCount: 0,
      seenUserMessages: Object.create(null),
      seenUserMessageCount: 0,
      questionClosedTurnId: null,
      liveTerminalTurnId: null,
      liveActiveTurnId: null,
      liveEpoch: 0,
      lastHydratedReadSeq: 0,
      lastHydratedHistorySeq: 0,
      observedAt: 0,
      updatedAt: Date.now()
    };
    runtime.threadCount = (runtime.threadCount || 0) + 1;
    if (runtime.threadCount > 512) __companionWorkflowPruneThreads(runtime);
  }
  return runtime.threads[threadId];
}
function __companionWorkflowObserve(thread) {
  if (thread == null) return;
  // A monotonically increasing per-thread epoch, independent of wall-clock
  // resolution. Every observed live event for the thread invalidates reads
  // that started earlier, including same-millisecond duplicates.
  thread.liveEpoch = (thread.liveEpoch || 0) + 1;
  thread.observedAt = Date.now();
}
function __companionWorkflowQuestionKey(turnId, itemId) {
  return turnId + "|" + itemId;
}
function __companionWorkflowHasPending(thread) {
  return (
    thread != null &&
    (thread.pendingCount > 0 || (thread.asyncQuestionCount || 0) > 0)
  );
}
function __companionWorkflowTurnHasPending(thread, turnId) {
  if (thread == null || turnId == null) return false;
  var ids = Object.keys(thread.asyncQuestions);
  for (var i = 0; i < ids.length; i++) {
    var question = thread.asyncQuestions[ids[i]];
    if (question != null && question.turnId === turnId) return true;
  }
  return false;
}
function __companionWorkflowResetQuestionState(thread) {
  if (thread == null) return;
  thread.asyncQuestions = Object.create(null);
  thread.asyncQuestionCount = 0;
  thread.settledQuestions = Object.create(null);
  thread.settledQuestionCount = 0;
  thread.settledQuestionKeys = Object.create(null);
  thread.settledQuestionKeyCount = 0;
  thread.seenUserMessages = Object.create(null);
  thread.seenUserMessageCount = 0;
  thread.questionClosedTurnId = null;
  thread.liveTerminalTurnId = null;
  thread.liveActiveTurnId = null;
}
function __companionWorkflowClearSyncPending(runtime, thread) {
  if (runtime == null || thread == null) return;
  var ids = Object.keys(thread.pending);
  for (var i = 0; i < ids.length; i++) {
    if (runtime.requests[ids[i]] === thread.threadId) delete runtime.requests[ids[i]];
  }
  thread.pending = Object.create(null);
  thread.pendingCount = 0;
}
function __companionWorkflowRememberSettledQuestion(thread, key) {
  if (thread == null || key == null || thread.settledQuestions[key] === true) return;
  if (thread.settledQuestionCount >= 64) {
    var oldest = Object.keys(thread.settledQuestions)[0];
    if (oldest != null) {
      delete thread.settledQuestions[oldest];
      thread.settledQuestionCount = Math.max(0, thread.settledQuestionCount - 1);
    }
  }
  thread.settledQuestions[key] = true;
  thread.settledQuestionCount += 1;
}
function __companionWorkflowSettledQuestionStorageKey(turnId, key) {
  if (typeof key !== "string" || key.length === 0) return null;
  return turnId == null ? key : turnId + "\u0000" + key;
}
function __companionWorkflowRememberSettledQuestionKey(thread, turnId, key) {
  if (thread == null) return false;
  if (typeof key !== "string" || key.length === 0 || key.length > 4096) return false;
  var storageKey = __companionWorkflowSettledQuestionStorageKey(turnId, key);
  if (storageKey == null) return false;
  if (thread.settledQuestionKeys == null) thread.settledQuestionKeys = Object.create(null);
  if (thread.settledQuestionKeys[storageKey] === true) return false;
  var count = thread.settledQuestionKeyCount || 0;
  if (count >= 4096) {
    var oldest = Object.keys(thread.settledQuestionKeys)[0];
    if (oldest != null) {
      delete thread.settledQuestionKeys[oldest];
      count = Math.max(0, count - 1);
    }
  }
  thread.settledQuestionKeys[storageKey] = true;
  thread.settledQuestionKeyCount = count + 1;
  return true;
}
function __companionWorkflowQuestionKeySettled(thread, turnId, key) {
  if (thread == null || thread.settledQuestionKeys == null) return false;
  var storageKey = __companionWorkflowSettledQuestionStorageKey(turnId, key);
  return storageKey != null && thread.settledQuestionKeys[storageKey] === true;
}
function __companionWorkflowClearSettledQuestionKeys(thread) {
  if (thread == null) return;
  thread.settledQuestionKeys = Object.create(null);
  thread.settledQuestionKeyCount = 0;
}
function __companionWorkflowSettleQuestionKeys(thread, turnId, keys) {
  if (thread == null || turnId == null || !Array.isArray(keys) || keys.length === 0) return 0;
  var settled = Object.create(null);
  for (var i = 0; i < keys.length && i < 128; i++) {
    if (typeof keys[i] !== "string" || keys[i].length === 0) continue;
    settled[keys[i]] = true;
    __companionWorkflowRememberSettledQuestionKey(thread, turnId, keys[i]);
  }
  var matched = 0;
  var ids = Object.keys(thread.asyncQuestions);
  for (var j = 0; j < ids.length; j++) {
    var question = thread.asyncQuestions[ids[j]];
    if (question == null || question.turnId !== turnId) continue;
    var questionKeys = Array.isArray(question.questionKeys) ? question.questionKeys : [];
    var remaining = [];
    for (var k = 0; k < questionKeys.length; k++) {
      if (settled[questionKeys[k]] === true) {
        matched += 1;
      } else {
        remaining.push(questionKeys[k]);
      }
    }
    if (remaining.length === questionKeys.length) continue;
    if (remaining.length > 0) {
      question.questionKeys = remaining;
      continue;
    }
    delete thread.asyncQuestions[ids[j]];
    thread.asyncQuestionCount = Math.max(0, (thread.asyncQuestionCount || 1) - 1);
    __companionWorkflowRememberSettledQuestion(thread, ids[j]);
  }
  return matched;
}
function __companionWorkflowSettleAsyncQuestions(thread, turnId) {
  if (thread == null) return;
  var ids = Object.keys(thread.asyncQuestions);
  for (var i = 0; i < ids.length; i++) {
    var question = thread.asyncQuestions[ids[i]];
    if (turnId != null && question != null && question.turnId !== turnId) continue;
    delete thread.asyncQuestions[ids[i]];
    thread.asyncQuestionCount = Math.max(0, thread.asyncQuestionCount - 1);
    __companionWorkflowRememberSettledQuestion(thread, ids[i]);
  }
}
function __companionWorkflowRememberUserMessage(thread, key) {
  if (thread == null || key == null || thread.seenUserMessages[key] === true) return false;
  if (thread.seenUserMessageCount >= 64) {
    var oldest = Object.keys(thread.seenUserMessages)[0];
    if (oldest != null) {
      delete thread.seenUserMessages[oldest];
      thread.seenUserMessageCount = Math.max(0, thread.seenUserMessageCount - 1);
    }
  }
  thread.seenUserMessages[key] = true;
  thread.seenUserMessageCount += 1;
  return true;
}
function __companionWorkflowSettleAfterAsync(runtime, thread) {
  if (runtime == null || thread == null || __companionWorkflowHasPending(thread)) return;
  if (thread.status !== "waiting") return;
  if (thread.turnActive === true) {
    __companionWorkflowSetStatus(runtime, thread, "running", {});
    return;
  }
  if (thread.completedTurnId != null && thread.doneEmittedFor !== thread.completedTurnId) {
    if (thread.goalStatus != null && thread.goalStatus !== "complete") {
      __companionWorkflowSetStatus(
        runtime,
        thread,
        thread.goalStatus === "active" ? "running" : "waiting",
        {}
      );
      return;
    }
    thread.doneEmittedFor = thread.completedTurnId;
    __companionWorkflowSetStatus(runtime, thread, "done", {});
    return;
  }
  __companionWorkflowSetStatus(runtime, thread, "idle", {});
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
    if (runtime.reads != null) {
      var readIds = Object.keys(runtime.reads);
      for (var w = 0; w < readIds.length; w++) {
        if (runtime.reads[readIds[w]] != null && runtime.reads[readIds[w]].threadId === removed.threadId) {
          if (runtime.history != null) {
            try {
              runtime.history.forget(runtime.reads[readIds[w]]);
            } catch (e) {}
          }
          delete runtime.reads[readIds[w]];
          runtime.readCount = Math.max(0, (runtime.readCount || 1) - 1);
        }
      }
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
function __companionWorkflowPublish(runtime, thread, status, previousStatus, turnId, requestKey, forcedEventId, live) {
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
    live: live !== false,
    eventId: eventId,
    tab: tab,
    previousStatus: previousStatus
  };
  try {
    var result = je.commands.executeCommand("codexCompanion.official.v1.event", event);
    if (result != null && typeof result.then === "function") result.then(undefined, function () {});
  } catch (e) {}
}
function __companionWorkflowApplyStatusExtra(thread, extra) {
  if (thread == null || extra == null || typeof extra !== "object") return;
  if (extra.turnId !== undefined) thread.turnId = extra.turnId;
  if (extra.turnStartedAt !== undefined) thread.turnStartedAt = extra.turnStartedAt;
  if (extra.turnActive !== undefined) thread.turnActive = extra.turnActive;
  if (extra.completedTurnId !== undefined) thread.completedTurnId = extra.completedTurnId;
  if (extra.doneEmittedFor !== undefined) thread.doneEmittedFor = extra.doneEmittedFor;
}
function __companionWorkflowSetStatus(runtime, thread, status, extra) {
  status = __companionWorkflowStatus(status);
  var previous = thread.status;
  thread.status = status;
  thread.updatedAt = Date.now();
  __companionWorkflowApplyStatusExtra(thread, extra);
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
// Hydration updates the same status graph but must never look like a fresh
// live transition: no claim, notification or sound may be replayed after a
// reload. The snapshot event only refreshes titles/attention counters.
function __companionWorkflowSetStatusSilent(runtime, thread, status, extra) {
  status = __companionWorkflowStatus(status);
  var previous = thread.status;
  thread.status = status;
  thread.updatedAt = Date.now();
  __companionWorkflowApplyStatusExtra(thread, extra);
  __companionWorkflowRefreshThreadTitles(runtime.provider, thread.threadId);
  __companionWorkflowPublish(runtime, thread, status, previous, thread.turnId, null, null, false);
  __companionWorkflowSave(runtime);
}
// ---------------------------------------------------------------------------
// Host-only hydration from observed native thread/read responses.
//
// The bridge never issues its own RPC. It only links a thread/read request to
// the local webview that sent it, and consumes the response that native code
// was going to deliver anyway. Records are bounded and always removed on the
// matching response/error/abandon/failed delivery/webview disposal.
// ---------------------------------------------------------------------------
function __companionWorkflowMaxReads() {
  return 64;
}
function __companionWorkflowPruneReads(runtime) {
  if (runtime == null || runtime.reads == null) return;
  var ids = Object.keys(runtime.reads);
  var limit = __companionWorkflowMaxReads();
  while (ids.length > limit) {
    var oldestId = null;
    var oldestSeq = null;
    for (var i = 0; i < ids.length; i++) {
      var record = runtime.reads[ids[i]];
      if (record == null) {
        ids.splice(i, 1);
        i -= 1;
        continue;
      }
      if (oldestSeq == null || record.requestSeq < oldestSeq) {
        oldestSeq = record.requestSeq;
        oldestId = ids[i];
      }
    }
    if (oldestId == null) break;
    if (runtime.history != null && runtime.reads[oldestId] != null) {
      try {
        runtime.history.forget(runtime.reads[oldestId]);
      } catch (e) {}
    }
    delete runtime.reads[oldestId];
    ids = Object.keys(runtime.reads);
  }
  runtime.readCount = Object.keys(runtime.reads).length;
}
function __companionWorkflowForgetRead(provider, requestId) {
  try {
    var runtime = provider == null ? null : provider.__companionWorkflowRuntime;
    if (runtime == null || runtime.disposed || runtime.reads == null) return false;
    var key = __companionWorkflowRequestKey(requestId);
    if (key == null || runtime.reads[key] == null) return false;
    if (runtime.history != null) {
      try {
        runtime.history.forget(runtime.reads[key]);
      } catch (e) {}
    }
    delete runtime.reads[key];
    runtime.readCount = Math.max(0, (runtime.readCount || 1) - 1);
    return true;
  } catch (e) {
    return false;
  }
}
function __companionWorkflowForgetWebviewReads(provider, webview) {
  try {
    var runtime = provider == null ? null : provider.__companionWorkflowRuntime;
    if (runtime == null || runtime.disposed || runtime.reads == null || webview == null) return 0;
    var ids = Object.keys(runtime.reads);
    var removed = 0;
    if (runtime.history != null) {
      try {
        runtime.history.disposeWebview(webview);
      } catch (e) {}
    }
    for (var i = 0; i < ids.length; i++) {
      var record = runtime.reads[ids[i]];
      if (record == null || record.webview !== webview) continue;
      delete runtime.reads[ids[i]];
      removed += 1;
    }
    runtime.readCount = Math.max(0, (runtime.readCount || removed) - removed);
    return removed;
  } catch (e) {
    return 0;
  }
}
function __companionWorkflowIsObservedReadMethod(method) {
  return (
    method === "thread/read" ||
    method === "thread/resume" ||
    method === "thread/turns/list" ||
    method === "thread/items/list"
  );
}
function __companionWorkflowBoundThreadId(provider, panel) {
  var rec = __companionWorkflowRecord(provider, panel);
  if (rec == null) return null;
  return (
    __companionWorkflowString(rec.__companionWorkflowThreadId) ||
    __companionWorkflowString(rec.__companionTitleThreadId)
  );
}
function __companionWorkflowSanitizeCursor(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") return value.length <= 4096 ? value : undefined;
  if (value != null && typeof value === "object" && value.type === "item") {
    var itemId = __companionWorkflowString(value.itemId);
    if (itemId != null && itemId.length <= 4096) return { type: "item", itemId: itemId };
  }
  // Preserve invalidity; dropping an unknown cursor would turn it into a root.
  return { type: "invalid" };
}
function __companionWorkflowSanitizePage(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  var page = {};
  var limit = __companionWorkflowNumber(value.limit);
  if (limit != null && limit > 0 && limit <= 1000) page.limit = Math.floor(limit);
  if (typeof value.itemsView === "string" && value.itemsView.length > 0 && value.itemsView.length <= 32) {
    page.itemsView = value.itemsView;
  }
  var direction = value.sortDirection;
  if (direction !== "asc" && direction !== "desc") direction = value.sort;
  if (direction === "asc" || direction === "desc") {
    page.sortDirection = direction;
    page.sort = direction;
  } else if (value.sortDirection !== undefined || value.sort !== undefined) {
    page.sortDirection = "invalid";
  }
  if (Object.prototype.hasOwnProperty.call(value, "cursor")) {
    var cursor = __companionWorkflowSanitizeCursor(value.cursor);
    if (cursor !== undefined) page.cursor = cursor;
  }
  return page;
}
function __companionWorkflowSanitizeReadParams(params) {
  var source = params != null && typeof params === "object" ? params : {};
  var out = {};
  var threadId = __companionWorkflowString(source.threadId);
  if (threadId != null && threadId.length <= 4096) out.threadId = threadId;
  var turnId = __companionWorkflowString(source.turnId);
  if (turnId != null && turnId.length <= 4096) out.turnId = turnId;
  if (Object.prototype.hasOwnProperty.call(source, "cursor")) {
    var cursor = __companionWorkflowSanitizeCursor(source.cursor);
    if (cursor !== undefined) out.cursor = cursor;
  }
  var direction = source.sortDirection;
  if (direction !== "asc" && direction !== "desc") direction = source.sort;
  if (direction === "asc" || direction === "desc") {
    out.sortDirection = direction;
    out.sort = direction;
  } else if (source.sortDirection !== undefined || source.sort !== undefined) {
    out.sortDirection = "invalid";
  }
  if (typeof source.itemsView === "string" && source.itemsView.length > 0 && source.itemsView.length <= 32) {
    out.itemsView = source.itemsView;
  }
  if (source.excludeTurns !== undefined) out.excludeTurns = source.excludeTurns === true;
  if (Object.prototype.hasOwnProperty.call(source, "initialTurnsPage")) {
    var page = __companionWorkflowSanitizePage(source.initialTurnsPage);
    if (page != null) out.initialTurnsPage = page;
  }
  return out;
}
function __companionWorkflowTrackRead(provider, webview, request) {
  try {
    var runtime = provider == null ? null : provider.__companionWorkflowRuntime;
    if (runtime == null || runtime.disposed || runtime.reads == null) return null;
    if (request == null || typeof request !== "object") return null;
    var method = request.method;
    if (!__companionWorkflowIsObservedReadMethod(method)) return null;
    var params = request.params != null && typeof request.params === "object" ? request.params : null;
    var threadId = params != null ? __companionWorkflowString(params.threadId) : null;
    var requestId = __companionWorkflowRequestKey(request.id);
    if (threadId == null || requestId == null || webview == null) return null;
    // Only a live local chat panel may originate hydration.
    var panel;
    try {
      panel = provider.findPanelByWebview(webview);
    } catch (e) {
      return null;
    }
    if (panel == null || !__companionWorkflowChatPanel(provider, panel)) return null;
    var boundThreadId = __companionWorkflowBoundThreadId(provider, panel);
    if (boundThreadId != null && boundThreadId !== threadId) return null;
    var thread = __companionWorkflowEnsureThread(runtime, threadId);
    if (thread == null) return null;
    if (runtime.reads[requestId] != null) {
      if (runtime.history != null) {
        try {
          runtime.history.forget(runtime.reads[requestId]);
        } catch (e) {}
      }
      delete runtime.reads[requestId];
      runtime.readCount = Math.max(0, (runtime.readCount || 1) - 1);
    }
    runtime.readSeq = (runtime.readSeq || 0) + 1;
    var record = {
      requestId: requestId,
      requestSeq: runtime.readSeq,
      threadId: threadId,
      method: method,
      includeTurns: params != null && params.includeTurns === true,
      webview: webview,
      liveEpoch: thread.liveEpoch || 0,
      params: __companionWorkflowSanitizeReadParams(params),
      createdAt: Date.now()
    };
    runtime.reads[requestId] = record;
    runtime.readCount = Object.keys(runtime.reads).length;
    if (runtime.readCount > __companionWorkflowMaxReads()) __companionWorkflowPruneReads(runtime);
    if (runtime.history != null) {
      try {
        runtime.history.track(record);
      } catch (e) {}
    }
    return {
      requestId: requestId,
      threadId: threadId,
      method: method,
      requestSeq: record.requestSeq,
      includeTurns: record.includeTurns
    };
  } catch (e) {
    return null;
  }
}
function __companionWorkflowLatestTurn(turns) {
  if (!Array.isArray(turns)) return null;
  var best = null;
  var bestStarted = null;
  for (var i = 0; i < turns.length; i++) {
    var turn = turns[i];
    // A malformed tail must not expose an older terminal as the latest turn.
    if (turn == null || typeof turn !== "object") return null;
    if (__companionWorkflowString(turn.id) == null || typeof turn.status !== "string") return null;
    var startedAt = __companionWorkflowNumber(turn.startedAt);
    if (best == null || (startedAt != null && (bestStarted == null || startedAt >= bestStarted)) || (startedAt == null && bestStarted == null)) {
      best = turn;
      bestStarted = startedAt;
    }
  }
  return best;
}
function __companionWorkflowQuestionHelpersAvailable() {
  return (
    typeof __companionQuestionProject === "function" &&
    typeof __companionQuestionCandidates === "function"
  );
}
function __companionWorkflowProjectItem(item) {
  if (item == null || typeof item !== "object") return null;
  if (typeof __companionQuestionProject !== "function") return null;
  try {
    var projected = __companionQuestionProject(item);
    if (projected == null || typeof projected !== "object") return null;
    var id = __companionWorkflowString(projected.id);
    if (id == null || id.length > 4096) return null;
    var questionKeys = __companionWorkflowCompactKeyArray(projected.questionKeys, 128);
    var answerKeys = __companionWorkflowCompactKeyArray(projected.answerKeys, 128);
    if (questionKeys == null || answerKeys == null) return null;
    return { id: id, questionKeys: questionKeys, answerKeys: answerKeys };
  } catch (e) {
    return null;
  }
}
function __companionWorkflowCompactKeyArray(value, limit) {
  if (!Array.isArray(value) || value.length > limit) return null;
  var out = [];
  for (var i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string" || value[i].length === 0 || value[i].length > 4096) return null;
    out.push(value[i]);
  }
  return out;
}
function __companionWorkflowItemLooksLikeQuestion(item) {
  return (
    item != null &&
    typeof item === "object" &&
    item.type === "agentMessage" &&
    Array.isArray(item.questions) &&
    item.questions.length > 0
  );
}
function __companionWorkflowItemLooksLikeReply(item) {
  if (item == null || typeof item !== "object") return false;
  var acceptedSteering = item.type === "steeringUserMessage" && item.status === "accepted";
  if (item.type !== "userMessage" && !acceptedSteering) return false;
  var content = acceptedSteering ? item.input : item.content;
  if (!Array.isArray(content) || content.length > 128) return true;
  for (var i = 0; i < content.length; i++) {
    var part = content[i];
    if (part == null || typeof part !== "object") continue;
    if (part.type !== "text" || typeof part.text !== "string") continue;
    if (part.text.length > 65536) return true;
    if (part.text.indexOf("<send_user_message_question_reply>") !== -1) return true;
  }
  return false;
}
function __companionWorkflowProjectQuestionItems(items) {
  if (!Array.isArray(items)) return null;
  if (items.length > 512) return null;
  if (!__companionWorkflowQuestionHelpersAvailable()) return null;
  var projected = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var compact = __companionWorkflowProjectItem(item);
    // Valid ordinary items have an empty compact projection. Null is unknown,
    // and cannot be silently converted into proof of no remaining questions.
    if (compact == null) return null;
    projected.push(compact);
  }
  return projected;
}
function __companionWorkflowQuestionCandidatesFromProjected(projected) {
  if (!Array.isArray(projected)) return null;
  if (typeof __companionQuestionCandidates !== "function") return null;
  var raw;
  try {
    raw = __companionQuestionCandidates(projected);
  } catch (e) {
    return null;
  }
  if (!Array.isArray(raw) || raw.length > 32) return null;
  var candidates = [];
  for (var i = 0; i < raw.length; i++) {
    var candidate = raw[i];
    if (candidate == null || typeof candidate !== "object") return null;
    var itemId = __companionWorkflowString(candidate.itemId);
    if (itemId == null || itemId.length > 4096) return null;
    var questionKeys = __companionWorkflowCompactKeyArray(candidate.questionKeys, 128);
    if (questionKeys == null) return null;
    if (questionKeys.length === 0) continue;
    candidates.push({ itemId: itemId, questionKeys: questionKeys });
  }
  return candidates;
}
function __companionWorkflowRememberAnsweredKeys(thread, turnId, projectedItems) {
  if (thread == null || turnId == null || !Array.isArray(projectedItems)) return;
  for (var i = 0; i < projectedItems.length && i < 512; i++) {
    var item = projectedItems[i];
    if (item == null || !Array.isArray(item.answerKeys)) continue;
    for (var k = 0; k < item.answerKeys.length && k < 128; k++) {
      __companionWorkflowRememberSettledQuestionKey(thread, turnId, item.answerKeys[k]);
    }
  }
}
function __companionWorkflowTurnQuestions(turn, thread) {
  if (turn == null || typeof turn !== "object") return null;
  if (turn.itemsView != null && turn.itemsView !== "full") return null;
  if (turn.itemsTruncated === true || turn.truncated === true || turn.summary != null) return null;
  if (!Array.isArray(turn.items)) return null;
  var projected = __companionWorkflowProjectQuestionItems(turn.items);
  if (projected == null) return null;
  var candidates = __companionWorkflowQuestionCandidatesFromProjected(projected);
  if (candidates == null) return null;
  var turnId = __companionWorkflowString(turn.id);
  if (thread != null && turnId != null) {
    __companionWorkflowRememberAnsweredKeys(thread, turnId, projected);
  }
  return candidates;
}
function __companionWorkflowReconcileQuestions(thread, turn, candidates) {
  var turnId = turn != null ? __companionWorkflowString(turn.id) : null;
  if (thread == null || turnId == null || !Array.isArray(candidates)) return;
  var keep = Object.create(null);
  for (var i = 0; i < candidates.length && i < 32; i++) {
    var candidate = candidates[i];
    if (candidate == null || typeof candidate !== "object") continue;
    var itemId = __companionWorkflowString(candidate.itemId);
    if (itemId == null) continue;
    var remaining = [];
    var seen = Object.create(null);
    var sourceKeys = Array.isArray(candidate.questionKeys) ? candidate.questionKeys : [];
    for (var k = 0; k < sourceKeys.length && k < 128; k++) {
      var questionKey = sourceKeys[k];
      if (typeof questionKey !== "string" || questionKey.length === 0) continue;
      if (seen[questionKey] === true) continue;
      seen[questionKey] = true;
      if (__companionWorkflowQuestionKeySettled(thread, turnId, questionKey)) continue;
      remaining.push(questionKey);
    }
    var groupKey = __companionWorkflowQuestionKey(turnId, itemId);
    if (remaining.length === 0) {
      __companionWorkflowRememberSettledQuestion(thread, groupKey);
      continue;
    }
    keep[groupKey] = remaining;
  }
  var ids = Object.keys(thread.asyncQuestions);
  for (var j = 0; j < ids.length; j++) {
    var question = thread.asyncQuestions[ids[j]];
    if (question == null || question.turnId !== turnId) continue;
    if (keep[ids[j]] != null) continue;
    delete thread.asyncQuestions[ids[j]];
    thread.asyncQuestionCount = Math.max(0, (thread.asyncQuestionCount || 1) - 1);
    __companionWorkflowRememberSettledQuestion(thread, ids[j]);
  }
  var keepIds = Object.keys(keep);
  for (var c = 0; c < keepIds.length; c++) {
    var key = keepIds[c];
    if (thread.settledQuestions[key] === true) continue;
    if (thread.asyncQuestions[key] != null) {
      thread.asyncQuestions[key].questionKeys = keep[key];
      continue;
    }
    if ((thread.asyncQuestionCount || 0) >= 32) continue;
    thread.asyncQuestions[key] = {
      turnId: turnId,
      itemId: key.slice(turnId.length + 1),
      questionKeys: keep[key],
      observedAt: Date.now()
    };
    thread.asyncQuestionCount = (thread.asyncQuestionCount || 0) + 1;
  }
}
function __companionWorkflowIsColdEvidence(thread) {
  return (
    thread != null &&
    thread.questionClosedTurnId == null &&
    thread.turnActive !== true &&
    thread.turnStartedAt == null
  );
}
function __companionWorkflowCanAdoptTurn(thread, turnId, turnStatus, startedAt) {
  if (thread == null || turnId == null) return false;
  // A real live terminal is authoritative for that turn, with or without an
  // async card that is still waiting to be answered.
  if (thread.liveTerminalTurnId === turnId) return false;
  if (thread.turnStartedAt != null && startedAt != null && startedAt < thread.turnStartedAt) return false;
  var sameTurn = thread.turnId === turnId;
  if (sameTurn) {
    if (turnStatus === "inProgress") {
      if (thread.turnActive === true) return true;
      // A persisted/hydrated terminal for this exact turn beats an older
      // in-progress page.
      if (thread.questionClosedTurnId === turnId || thread.completedTurnId === turnId) return false;
      return true;
    }
    // A live active turn of the same id wins over a terminal snapshot; the
    // real turn/completed notification is the authority. A merely hydrated
    // in-progress snapshot may be superseded by a newer complete read.
    if (thread.liveActiveTurnId === turnId) return false;
    return true;
  }
  if (thread.liveActiveTurnId != null && thread.liveActiveTurnId === thread.turnId) {
    if (startedAt == null || thread.turnStartedAt == null || startedAt <= thread.turnStartedAt) return false;
  }
  if (thread.liveTerminalTurnId === thread.turnId && thread.liveTerminalTurnId != null && thread.turnStartedAt == null) return false;
  if (thread.questionClosedTurnId != null && thread.questionClosedTurnId !== turnId) {
    if (!(startedAt != null && (thread.turnStartedAt == null || startedAt > thread.turnStartedAt))) return false;
  }
  if (__companionWorkflowIsColdEvidence(thread)) return true;
  if (startedAt != null && (thread.turnStartedAt == null || startedAt > thread.turnStartedAt)) return true;
  return false;
}
function __companionWorkflowHydrateRead(runtime, thread, snapshot, includeTurns) {
  if (runtime == null || thread == null || snapshot == null || typeof snapshot !== "object") return false;
  var status = snapshot.status;
  if (status == null || typeof status !== "object" || typeof status.type !== "string") return false;
  var readTurn = includeTurns === true ? __companionWorkflowLatestTurn(snapshot.turns) : null;
  if (readTurn != null) {
    var readTurnId = __companionWorkflowString(readTurn.id);
    var readStartedAt = __companionWorkflowNumber(readTurn.startedAt);
    if (readTurnId == null) return false;
    if (!__companionWorkflowCanAdoptTurn(thread, readTurnId, readTurn.status, readStartedAt)) return false;
  }
  if (status.type === "active") {
    var flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
    var flagWaiting =
      flags.indexOf("waitingOnApproval") !== -1 || flags.indexOf("waitingOnUserInput") !== -1;
    var extraActive = { turnActive: true };
    var latestInProgress = null;
    if (includeTurns === true) {
      var latest = __companionWorkflowLatestTurn(snapshot.turns);
      if (latest != null && latest.status === "inProgress") latestInProgress = latest;
    }
    var questionWaiting = false;
    if (latestInProgress != null) {
      var startedAt = __companionWorkflowNumber(latestInProgress.startedAt);
      var latestId = __companionWorkflowString(latestInProgress.id);
      if (latestId != null) {
        if (thread.turnId != null && thread.turnId !== latestId) {
          __companionWorkflowClearSyncPending(runtime, thread);
          __companionWorkflowResetQuestionState(thread);
          extraActive.completedTurnId = null;
          extraActive.doneEmittedFor = null;
        }
        extraActive.turnId = latestId;
        extraActive.turnStartedAt = startedAt;
        var candidates = __companionWorkflowTurnQuestions(latestInProgress, thread);
        if (candidates != null) __companionWorkflowReconcileQuestions(thread, latestInProgress, candidates);
        questionWaiting = __companionWorkflowHasPending(thread);
      }
    }
    // Runtime active flags are authoritative; real pending request/question
    // keys can only add waiting, never synthesize them.
    var waiting =
      flagWaiting || questionWaiting || __companionWorkflowHasPending(thread);
    __companionWorkflowSetStatusSilent(runtime, thread, waiting ? "waiting" : "running", extraActive);
    thread.observedAt = Math.max(1, Date.now());
    return true;
  }
  if (status.type === "systemError") {
    __companionWorkflowClearSyncPending(runtime, thread);
    __companionWorkflowSettleAsyncQuestions(thread, null);
    __companionWorkflowClearSettledQuestionKeys(thread);
    thread.questionClosedTurnId = thread.turnId;
    __companionWorkflowSetStatusSilent(runtime, thread, "error", { turnActive: false, completedTurnId: null, doneEmittedFor: null });
    thread.observedAt = Math.max(1, Date.now());
    return true;
  }
  // Without full turns only authoritative active flags / systemError may be
  // restored. Idle/notLoaded never invent a turn status.
  if (status.type !== "idle" || includeTurns !== true) return false;
  var turns = Array.isArray(snapshot.turns) ? snapshot.turns : null;
  if (turns == null || turns.length === 0) return false;
  var latestTurn = __companionWorkflowLatestTurn(turns);
  if (latestTurn == null) return false;
  var turnId = __companionWorkflowString(latestTurn.id);
  var turnStatus = latestTurn.status;
  var latestStartedAt = __companionWorkflowNumber(latestTurn.startedAt);
  if (turnId == null) return false;
  if (turnStatus === "inProgress") {
    if (thread.turnId != null && thread.turnId !== turnId) {
      __companionWorkflowClearSyncPending(runtime, thread);
      __companionWorkflowResetQuestionState(thread);
    }
    var turnCandidates = __companionWorkflowTurnQuestions(latestTurn, thread);
    if (turnCandidates != null) __companionWorkflowReconcileQuestions(thread, latestTurn, turnCandidates);
    var activeWaiting = __companionWorkflowHasPending(thread);
    __companionWorkflowSetStatusSilent(runtime, thread, activeWaiting ? "waiting" : "running", {
      turnId: turnId,
      turnStartedAt: latestStartedAt,
      turnActive: true,
      completedTurnId: null,
      doneEmittedFor: null
    });
    thread.observedAt = Math.max(1, Date.now());
    return true;
  }
  if (turnStatus === "completed") {
    var completedCandidates = __companionWorkflowTurnQuestions(latestTurn, thread);
    // A missing/summary/truncated item view is not proof of anything: keep the
    // known status instead of guessing pending or done.
    if (completedCandidates == null) return false;
    __companionWorkflowClearSyncPending(runtime, thread);
    if (thread.turnId != null && thread.turnId !== turnId) {
      __companionWorkflowResetQuestionState(thread);
    }
    thread.turnId = turnId;
    thread.turnStartedAt = latestStartedAt;
    thread.turnActive = false;
    __companionWorkflowReconcileQuestions(thread, latestTurn, completedCandidates);
    if (__companionWorkflowTurnHasPending(thread, turnId)) {
      thread.questionClosedTurnId = turnId;
      thread.completedTurnId = turnId;
      thread.doneEmittedFor = null;
      __companionWorkflowSetStatusSilent(runtime, thread, "waiting", {
        turnId: turnId,
        turnStartedAt: latestStartedAt,
        turnActive: false,
        completedTurnId: turnId,
        doneEmittedFor: null
      });
      thread.observedAt = Math.max(1, Date.now());
      return true;
    }
    __companionWorkflowSettleAsyncQuestions(thread, turnId);
    thread.questionClosedTurnId = turnId;
    if (thread.goalStatus != null && thread.goalStatus !== "complete") {
      __companionWorkflowSetStatusSilent(runtime, thread, thread.goalStatus === "active" ? "running" : "waiting", {
        turnId: turnId, turnStartedAt: latestStartedAt, turnActive: false,
        completedTurnId: turnId, doneEmittedFor: null
      });
      thread.observedAt = Math.max(1, Date.now());
      return true;
    }
    thread.completedTurnId = turnId;
    thread.doneEmittedFor = turnId;
    __companionWorkflowSetStatusSilent(runtime, thread, "done", {
      turnId: turnId,
      turnStartedAt: latestStartedAt,
      turnActive: false,
      completedTurnId: turnId,
      doneEmittedFor: turnId
    });
    thread.observedAt = Math.max(1, Date.now());
    return true;
  }
  if (turnStatus === "failed") {
    __companionWorkflowClearSyncPending(runtime, thread);
    if (thread.turnId != null && thread.turnId !== turnId) {
      __companionWorkflowResetQuestionState(thread);
    }
    __companionWorkflowSettleAsyncQuestions(thread, null);
    __companionWorkflowClearSettledQuestionKeys(thread);
    thread.turnId = turnId;
    thread.turnStartedAt = latestStartedAt;
    thread.turnActive = false;
    thread.questionClosedTurnId = turnId;
    __companionWorkflowSetStatusSilent(runtime, thread, "error", {
      turnId: turnId,
      turnStartedAt: latestStartedAt,
      turnActive: false,
      completedTurnId: null,
      doneEmittedFor: null
    });
    thread.observedAt = Math.max(1, Date.now());
    return true;
  }
  if (turnStatus === "interrupted" || turnStatus === "cancelled" || turnStatus === "canceled") {
    __companionWorkflowClearSyncPending(runtime, thread);
    if (thread.turnId != null && thread.turnId !== turnId) {
      __companionWorkflowResetQuestionState(thread);
    }
    __companionWorkflowSettleAsyncQuestions(thread, null);
    __companionWorkflowClearSettledQuestionKeys(thread);
    thread.turnId = turnId;
    thread.turnStartedAt = latestStartedAt;
    thread.turnActive = false;
    thread.questionClosedTurnId = turnId;
    __companionWorkflowSetStatusSilent(runtime, thread, "idle", {
      turnId: turnId,
      turnStartedAt: latestStartedAt,
      turnActive: false,
      completedTurnId: null,
      doneEmittedFor: null
    });
    thread.observedAt = Math.max(1, Date.now());
    return true;
  }
  return false;
}
function __companionWorkflowReadOwnsPanel(runtime, record) {
  if (runtime == null || runtime.provider == null || record == null) return false;
  var panel;
  try {
    panel = runtime.provider.findPanelByWebview(record.webview);
  } catch (e) {
    return false;
  }
  if (panel == null || !__companionWorkflowChatPanel(runtime.provider, panel)) return false;
  var boundThreadId = __companionWorkflowBoundThreadId(runtime.provider, panel);
  if (boundThreadId != null && boundThreadId !== record.threadId) return false;
  return true;
}
function __companionWorkflowApplyQuestionHistory(runtime, record, data) {
  if (runtime == null || runtime.disposed || record == null) return false;
  if (data == null || typeof data !== "object") return false;
  if (data.threadId !== record.threadId || data.webview !== record.webview) return false;
  if (!__companionWorkflowReadOwnsPanel(runtime, record)) return false;
  var requestSeq = __companionWorkflowNumber(data.requestSeq);
  var liveEpoch = __companionWorkflowNumber(data.liveEpoch);
  if (requestSeq == null || liveEpoch == null) return false;
  var turn = data.turn;
  if (turn == null || typeof turn !== "object") return false;
  var turnId = __companionWorkflowString(turn.id);
  if (turnId == null || turnId.length > 4096) return false;
  var turnStatus = turn.status;
  if (
    turnStatus !== "inProgress" &&
    turnStatus !== "completed" &&
    turnStatus !== "failed" &&
    turnStatus !== "interrupted" &&
    turnStatus !== "cancelled" &&
    turnStatus !== "canceled"
  ) {
    return false;
  }
  var startedAt = __companionWorkflowNumber(turn.startedAt);
  if (turn.startedAt !== undefined && turn.startedAt !== null && startedAt == null) return false;
  var items = Array.isArray(data.items) ? data.items : null;
  if (items == null || items.length > 512) return false;
  var thread = __companionWorkflowEnsureThread(runtime, record.threadId);
  if (thread == null) return false;
  if ((thread.liveEpoch || 0) !== liveEpoch) return false;
  if (requestSeq <= (thread.lastHydratedHistorySeq || 0)) return false;
  // A live turn start/terminal is stronger than a resumed/history snapshot.
  if (!__companionWorkflowCanAdoptTurn(thread, turnId, turnStatus, startedAt)) return false;
  var candidates = __companionWorkflowQuestionCandidatesFromProjected(items);
  if (candidates == null) return false;
  thread.lastHydratedHistorySeq = requestSeq;
  if (turnStatus === "inProgress") {
    if (thread.turnId != null && thread.turnId !== turnId) {
      __companionWorkflowClearSyncPending(runtime, thread);
      __companionWorkflowResetQuestionState(thread);
    }
    __companionWorkflowRememberAnsweredKeys(thread, turnId, items);
    __companionWorkflowReconcileQuestions(thread, turn, candidates);
    var activeWaiting = __companionWorkflowHasPending(thread);
    __companionWorkflowSetStatusSilent(runtime, thread, activeWaiting ? "waiting" : "running", {
      turnId: turnId,
      turnStartedAt: startedAt,
      turnActive: true,
      completedTurnId: null,
      doneEmittedFor: null
    });
    thread.observedAt = Math.max(1, Date.now());
    return true;
  }
  __companionWorkflowClearSyncPending(runtime, thread);
  if (thread.turnId != null && thread.turnId !== turnId) {
    __companionWorkflowResetQuestionState(thread);
  }
  thread.turnId = turnId;
  thread.turnStartedAt = startedAt;
  thread.turnActive = false;
  if (turnStatus === "completed") {
    __companionWorkflowRememberAnsweredKeys(thread, turnId, items);
    __companionWorkflowReconcileQuestions(thread, turn, candidates);
    if (__companionWorkflowTurnHasPending(thread, turnId)) {
      thread.questionClosedTurnId = turnId;
      thread.completedTurnId = turnId;
      thread.doneEmittedFor = null;
      __companionWorkflowSetStatusSilent(runtime, thread, "waiting", {
        turnId: turnId,
        turnStartedAt: startedAt,
        turnActive: false,
        completedTurnId: turnId,
        doneEmittedFor: null
      });
      thread.observedAt = Math.max(1, Date.now());
      return true;
    }
    __companionWorkflowSettleAsyncQuestions(thread, turnId);
    thread.questionClosedTurnId = turnId;
    if (thread.goalStatus != null && thread.goalStatus !== "complete") {
      __companionWorkflowSetStatusSilent(runtime, thread, thread.goalStatus === "active" ? "running" : "waiting", {
        turnId: turnId,
        turnStartedAt: startedAt,
        turnActive: false,
        completedTurnId: turnId,
        doneEmittedFor: null
      });
      thread.observedAt = Math.max(1, Date.now());
      return true;
    }
    thread.completedTurnId = turnId;
    thread.doneEmittedFor = turnId;
    __companionWorkflowSetStatusSilent(runtime, thread, "done", {
      turnId: turnId,
      turnStartedAt: startedAt,
      turnActive: false,
      completedTurnId: turnId,
      doneEmittedFor: turnId
    });
    thread.observedAt = Math.max(1, Date.now());
    return true;
  }
  __companionWorkflowSettleAsyncQuestions(thread, null);
  if (turnStatus === "failed") {
    __companionWorkflowClearSettledQuestionKeys(thread);
    thread.questionClosedTurnId = turnId;
    __companionWorkflowSetStatusSilent(runtime, thread, "error", {
      turnId: turnId,
      turnStartedAt: startedAt,
      turnActive: false,
      completedTurnId: null,
      doneEmittedFor: null
    });
    thread.observedAt = Math.max(1, Date.now());
    return true;
  }
  __companionWorkflowClearSettledQuestionKeys(thread);
  thread.questionClosedTurnId = turnId;
  __companionWorkflowSetStatusSilent(runtime, thread, "idle", {
    turnId: turnId,
    turnStartedAt: startedAt,
    turnActive: false,
    completedTurnId: null,
    doneEmittedFor: null
  });
  thread.observedAt = Math.max(1, Date.now());
  return true;
}
function __companionWorkflowFinishRead(runtime, requestId, record, forgetHistory) {
  if (runtime == null || runtime.reads == null || record == null) return;
  if (runtime.reads[requestId] === record) {
    delete runtime.reads[requestId];
    runtime.readCount = Math.max(0, (runtime.readCount || 1) - 1);
  }
  if (forgetHistory && runtime.history != null) {
    try {
      runtime.history.forget(record);
    } catch (e) {}
  }
}
function __companionWorkflowReadResponse(provider, webview, response) {
  try {
    var runtime = provider == null ? null : provider.__companionWorkflowRuntime;
    if (runtime == null || runtime.disposed || runtime.reads == null) return false;
    if (response == null || typeof response !== "object") return false;
    var requestId = __companionWorkflowRequestKey(response.id);
    if (requestId == null) return false;
    var record = runtime.reads[requestId];
    if (record == null) return false;
    if (record.webview !== webview) {
      __companionWorkflowFinishRead(runtime, requestId, record, true);
      return false;
    }
    if (!__companionWorkflowReadOwnsPanel(runtime, record)) {
      __companionWorkflowFinishRead(runtime, requestId, record, true);
      return false;
    }
    var thread = __companionWorkflowEnsureThread(runtime, record.threadId);
    if (thread == null) {
      __companionWorkflowFinishRead(runtime, requestId, record, true);
      return false;
    }
    if (response.error != null) {
      if (runtime.history != null) {
        try {
          runtime.history.receive(record, null, response.error);
        } catch (e) {}
      }
      __companionWorkflowFinishRead(runtime, requestId, record, true);
      return false;
    }
    var result = response.result;
    if (result == null || typeof result !== "object") {
      __companionWorkflowFinishRead(runtime, requestId, record, true);
      return false;
    }
    var snapshot = result.thread;
    if (record.method === "thread/read" && (snapshot == null || typeof snapshot !== "object")) {
      __companionWorkflowFinishRead(runtime, requestId, record, true);
      return false;
    }
    if (snapshot != null && typeof snapshot === "object") {
      var snapshotId = __companionWorkflowString(snapshot.id);
      if (snapshotId == null || snapshotId !== record.threadId) {
        __companionWorkflowFinishRead(runtime, requestId, record, true);
        return false;
      }
      if (
        snapshot.hostId !== undefined &&
        snapshot.hostId !== null &&
        __companionWorkflowString(snapshot.hostId) !== "local"
      ) {
        __companionWorkflowFinishRead(runtime, requestId, record, true);
        return false;
      }
    }
    // Any live event observed for the thread after the request invalidates
    // this response, including a same-status event in the same millisecond.
    if ((thread.liveEpoch || 0) !== record.liveEpoch) {
      __companionWorkflowFinishRead(runtime, requestId, record, true);
      return false;
    }
    var historyApplied = false;
    if (runtime.history != null) {
      runtime.lastHistoryApplied = false;
      try {
        runtime.history.receive(record, result, null);
      } catch (e) {
        runtime.lastHistoryApplied = false;
      }
      historyApplied = runtime.lastHistoryApplied === true;
      runtime.lastHistoryApplied = false;
    }
    var applied = false;
    if (record.method === "thread/read") {
      if (record.requestSeq > (thread.lastHydratedReadSeq || 0)) {
        thread.lastHydratedReadSeq = record.requestSeq;
        applied = __companionWorkflowHydrateRead(runtime, thread, snapshot, record.includeTurns);
      }
    } else if (record.method === "thread/resume") {
      var legacyTurns =
        record.params == null || record.params.excludeTurns !== true;
      if (legacyTurns && snapshot != null && Array.isArray(snapshot.turns) && snapshot.turns.length > 0) {
        if (record.requestSeq > (thread.lastHydratedReadSeq || 0)) {
          thread.lastHydratedReadSeq = record.requestSeq;
          applied = __companionWorkflowHydrateRead(runtime, thread, snapshot, true);
        }
      }
    }
    // A later complete ordinary read also supersedes an older paged assembly.
    // Summary-only runtime flags do not prove which async questions remain.
    if (applied && (record.includeTurns === true || (record.method === "thread/resume" && record.params.excludeTurns !== true))) {
      var completeTurn = __companionWorkflowLatestTurn(snapshot.turns);
      if (completeTurn != null && (completeTurn.itemsView == null || completeTurn.itemsView === "full") &&
          completeTurn.truncated !== true && completeTurn.itemsTruncated !== true &&
          __companionWorkflowProjectQuestionItems(completeTurn.items) != null) {
        thread.lastHydratedHistorySeq = Math.max(thread.lastHydratedHistorySeq || 0, record.requestSeq);
      }
    }
    __companionWorkflowFinishRead(runtime, requestId, record, false);
    return applied || historyApplied;
  } catch (e) {
    return false;
  }
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
    reads: Object.create(null),
    readCount: 0,
    readSeq: 0,
    history: null,
    lastHistoryApplied: false,
    disposed: false
  };
  if (typeof __companionCreateQuestionHistory === "function") {
    try {
      runtime.history = __companionCreateQuestionHistory({
        currentEpoch: function (threadId) {
          var thread = runtime.threads[threadId];
          return thread != null ? thread.liveEpoch || 0 : 0;
        },
        complete: function (data) {
          var record =
            data != null && typeof data === "object"
              ? {
                  threadId: data.threadId,
                  webview: data.webview,
                  requestSeq: data.requestSeq,
                  liveEpoch: data.liveEpoch
                }
              : null;
          var applied = __companionWorkflowApplyQuestionHistory(runtime, record, data);
          runtime.lastHistoryApplied = applied === true;
          return applied;
        }
      });
    } catch (e) {
      runtime.history = null;
    }
  }
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
          if (runtime.history != null) {
            try {
              runtime.history.clear();
            } catch (e) {}
          }
          runtime.threads = Object.create(null);
          runtime.threadCount = 0;
          runtime.requests = Object.create(null);
          runtime.reads = Object.create(null);
          runtime.readCount = 0;
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
        if (runtime.history != null) {
          try {
            runtime.history.clear();
          } catch (e) {}
        }
        runtime.threads = Object.create(null);
        runtime.threadCount = 0;
        runtime.requests = Object.create(null);
        runtime.reads = Object.create(null);
        runtime.readCount = 0;
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
    if (typeof __companionWindowNamesApply === "function") __companionWindowNamesApply(provider, panel);
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
      // Native resume loads an idle thread and broadcasts idle before its
      // initialTurnsPage response. With no live turn or pending state this
      // carries no new turn/question information and changes no status. It
      // must not invalidate the cold history response that caused the load.
      var loadOnlyIdle = status.type === "idle" && thread.turnActive !== true &&
        thread.liveActiveTurnId == null && thread.liveTerminalTurnId == null &&
        !__companionWorkflowHasPending(thread) && thread.status !== "running" && thread.status !== "waiting";
      if (!loadOnlyIdle) __companionWorkflowObserve(thread);
      if (status.type === "active") {
        var flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
        if (thread.turnId != null) thread.liveActiveTurnId = thread.turnId;
        var flagWaiting =
          flags.indexOf("waitingOnApproval") !== -1 || flags.indexOf("waitingOnUserInput") !== -1;
        // Empty active flags must not erase a real pending request/question.
        __companionWorkflowSetStatus(
          runtime,
          thread,
          flagWaiting || __companionWorkflowHasPending(thread) ? "waiting" : "running",
          { turnActive: true }
        );
        return true;
      }
      if (status.type === "systemError") {
        __companionWorkflowClearSyncPending(runtime, thread);
        __companionWorkflowSettleAsyncQuestions(thread, null);
        __companionWorkflowClearSettledQuestionKeys(thread);
        if (thread.turnId != null) thread.liveTerminalTurnId = thread.turnId;
        thread.liveActiveTurnId = null;
        thread.questionClosedTurnId = thread.turnId;
        __companionWorkflowSetStatus(runtime, thread, "error", { turnActive: false });
        return true;
      }
      if (status.type === "idle") {
        thread.liveActiveTurnId = null;
        if (__companionWorkflowHasPending(thread)) {
          // Idle may precede the terminal event. Keep the tracked turn active
          // so answering a pending question resumes [~] until that terminal.
          __companionWorkflowSetStatus(runtime, thread, "waiting", {});
          return true;
        }
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
    if (method === "item/started" || method === "item/completed") {
      var itemThreadId = __companionWorkflowString(params.threadId);
      var itemTurnId = __companionWorkflowString(params.turnId);
      var item = params.item;
      if (
        itemThreadId == null ||
        itemTurnId == null ||
        item == null ||
        typeof item !== "object" ||
        __companionWorkflowString(item.id) == null ||
        typeof item.type !== "string"
      ) {
        return false;
      }
      var itemThread = __companionWorkflowEnsureThread(runtime, itemThreadId);
      if (itemThread == null) return false;
      // A late item from a turn that is no longer current is stale. Do not
      // observe it: async restore uses observedAt to avoid overwriting live state.
      if (itemThread.turnId != null && itemThread.turnId !== itemTurnId) return true;
      var itemId = item.id;
      var itemKey = __companionWorkflowQuestionKey(itemTurnId, itemId);
      __companionWorkflowObserve(itemThread);
      if (item.type === "userMessage" || item.type === "steeringUserMessage") {
        // Only accepted steering is user input. A pending steering item must
        // not be deduplicated before its accepted version arrives.
        if (item.type === "steeringUserMessage" && item.status !== "accepted") return true;
        // The original prompt must not settle the question when its completion
        // arrives late; the same dedupe also makes repeated replies harmless.
        if (!__companionWorkflowRememberUserMessage(itemThread, itemKey)) return true;
        var compactReply = __companionWorkflowProjectItem(item);
        var answerKeys = compactReply != null ? compactReply.answerKeys : [];
        if (answerKeys.length > 0) {
          __companionWorkflowSettleQuestionKeys(itemThread, itemTurnId, answerKeys);
        }
        __companionWorkflowSettleAfterAsync(runtime, itemThread);
        return true;
      }
      if (item.type !== "agentMessage") return false;
      if (itemThread.questionClosedTurnId === itemTurnId) return true;
      var questions = item.questions;
      if (!Array.isArray(questions) || questions.length === 0) return false;
      var compactQuestion = __companionWorkflowProjectItem(item);
      if (compactQuestion == null) {
        // Malformed/over-limit question data cannot create new card state.
        return true;
      }
      if (itemThread.settledQuestions[itemKey] === true) return true;
      var itemQuestionKeys = [];
      for (var questionIndex = 0; questionIndex < compactQuestion.questionKeys.length; questionIndex++) {
        var questionKey = compactQuestion.questionKeys[questionIndex];
        if (__companionWorkflowQuestionKeySettled(itemThread, itemTurnId, questionKey)) continue;
        if (itemQuestionKeys.indexOf(questionKey) === -1) itemQuestionKeys.push(questionKey);
      }
      if (itemQuestionKeys.length === 0) {
        __companionWorkflowRememberSettledQuestion(itemThread, itemKey);
        return true;
      }
      if (itemThread.asyncQuestions[itemKey] != null) {
        var existingQuestion = itemThread.asyncQuestions[itemKey];
        var existingKeys = Array.isArray(existingQuestion.questionKeys) ? existingQuestion.questionKeys : [];
        var mergedKeys = existingKeys.slice();
        for (var m = 0; m < itemQuestionKeys.length; m++) {
          if (mergedKeys.indexOf(itemQuestionKeys[m]) === -1) mergedKeys.push(itemQuestionKeys[m]);
        }
        existingQuestion.questionKeys = mergedKeys;
        if (itemThread.status !== "waiting") {
          __companionWorkflowSetStatus(runtime, itemThread, "waiting", {});
        }
        return true;
      }
      if ((itemThread.asyncQuestionCount || 0) >= 32) return true;
      itemThread.asyncQuestions[itemKey] = {
        turnId: itemTurnId,
        itemId: itemId,
        questionKeys: itemQuestionKeys,
        observedAt: Date.now()
      };
      itemThread.asyncQuestionCount = (itemThread.asyncQuestionCount || 0) + 1;
      if (itemThread.turnId == null) itemThread.turnId = itemTurnId;
      if (itemThread.status !== "waiting") {
        __companionWorkflowSetStatus(runtime, itemThread, "waiting", {});
      }
      return true;
    }
    if (method === "turn/started") {
      var turn = params.turn;
      var startedThread = __companionWorkflowString(params.threadId);
      var startedId = turn != null ? __companionWorkflowString(turn.id) : null;
      if (startedThread == null || startedId == null) return false;
      var startedThreadState = __companionWorkflowEnsureThread(runtime, startedThread);
      if (startedThreadState == null) return false;
      __companionWorkflowObserve(startedThreadState);
      // A duplicate start of the same turn is not a new turn and must not
      // discard a pending request/question. A genuinely new turn clears the
      // previous turn's synchronous requests and async question metadata.
      if (startedThreadState.turnId !== startedId) {
        __companionWorkflowClearSyncPending(runtime, startedThreadState);
        __companionWorkflowResetQuestionState(startedThreadState);
      }
      startedThreadState.liveActiveTurnId = startedId;
      __companionWorkflowSetStatus(
        runtime,
        startedThreadState,
        __companionWorkflowHasPending(startedThreadState) ? "waiting" : "running",
        {
          turnId: startedId,
          turnStartedAt: __companionWorkflowNumber(turn.startedAt),
          turnActive: true,
          completedTurnId: null,
          doneEmittedFor: null
        }
      );
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
        completedThreadState.liveTerminalTurnId = completedId;
        completedThreadState.liveActiveTurnId = null;
        __companionWorkflowClearSyncPending(runtime, completedThreadState);
        completedThreadState.questionClosedTurnId = completedId;
        completedThreadState.completedTurnId = completedId;
        if (__companionWorkflowHasPending(completedThreadState)) {
          // An async question may outlive a successful turn. Keep waiting and
          // do not emit done/sound until the card is answered or a newer turn
          // supersedes it.
          __companionWorkflowSetStatus(runtime, completedThreadState, "waiting", { turnActive: false });
        } else if (completedThreadState.goalStatus != null && completedThreadState.goalStatus !== "complete") {
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
        completedThreadState.liveTerminalTurnId = completedId;
        completedThreadState.liveActiveTurnId = null;
        __companionWorkflowClearSyncPending(runtime, completedThreadState);
        __companionWorkflowSettleAsyncQuestions(completedThreadState, null);
        __companionWorkflowClearSettledQuestionKeys(completedThreadState);
        completedThreadState.questionClosedTurnId = completedId;
        __companionWorkflowSetStatus(runtime, completedThreadState, "error", { turnActive: false });
        return true;
      }
      if (terminal === "interrupted" || terminal === "cancelled" || terminal === "canceled") {
        completedThreadState.liveTerminalTurnId = completedId;
        completedThreadState.liveActiveTurnId = null;
        __companionWorkflowClearSyncPending(runtime, completedThreadState);
        __companionWorkflowSettleAsyncQuestions(completedThreadState, null);
        __companionWorkflowClearSettledQuestionKeys(completedThreadState);
        completedThreadState.questionClosedTurnId = completedId;
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
      if (wasPending && resolvedThread.status === "waiting" && !__companionWorkflowHasPending(resolvedThread)) {
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
        if (__companionWorkflowHasPending(goalThread)) {
          __companionWorkflowSetStatus(runtime, goalThread, "waiting", {});
        } else if (
          goalThread.completedTurnId != null &&
          goalThread.doneEmittedFor !== goalThread.completedTurnId
        ) {
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
      if (__companionWorkflowHasPending(clearedThread)) {
        __companionWorkflowSetStatus(runtime, clearedThread, "waiting", {});
      } else if (
        clearedThread.completedTurnId != null &&
        clearedThread.doneEmittedFor !== clearedThread.completedTurnId
      ) {
        clearedThread.doneEmittedFor = clearedThread.completedTurnId;
        __companionWorkflowSetStatus(runtime, clearedThread, "done", {});
      } else if (
        clearedThread.status === "waiting" &&
        !__companionWorkflowHasPending(clearedThread) &&
        !clearedThread.turnActive
      ) {
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
