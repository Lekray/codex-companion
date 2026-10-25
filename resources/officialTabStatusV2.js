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
      asyncQuestions: Object.create(null),
      asyncQuestionCount: 0,
      settledQuestions: Object.create(null),
      settledQuestionCount: 0,
      seenUserMessages: Object.create(null),
      seenUserMessageCount: 0,
      questionClosedTurnId: null,
      liveEpoch: 0,
      lastHydratedReadSeq: 0,
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
function __companionWorkflowResetQuestionState(thread) {
  if (thread == null) return;
  thread.asyncQuestions = Object.create(null);
  thread.asyncQuestionCount = 0;
  thread.settledQuestions = Object.create(null);
  thread.settledQuestionCount = 0;
  thread.seenUserMessages = Object.create(null);
  thread.seenUserMessageCount = 0;
  thread.questionClosedTurnId = null;
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
function __companionWorkflowTrackRead(provider, webview, request) {
  try {
    var runtime = provider == null ? null : provider.__companionWorkflowRuntime;
    if (runtime == null || runtime.disposed || runtime.reads == null) return null;
    if (request == null || typeof request !== "object" || request.method !== "thread/read") return null;
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
    var thread = __companionWorkflowEnsureThread(runtime, threadId);
    if (thread == null) return null;
    if (runtime.reads[requestId] != null) {
      delete runtime.reads[requestId];
      runtime.readCount = Math.max(0, (runtime.readCount || 1) - 1);
    }
    runtime.readSeq = (runtime.readSeq || 0) + 1;
    var record = {
      requestId: requestId,
      requestSeq: runtime.readSeq,
      threadId: threadId,
      includeTurns: params != null && params.includeTurns === true,
      webview: webview,
      liveEpoch: thread.liveEpoch || 0,
      createdAt: Date.now()
    };
    runtime.reads[requestId] = record;
    runtime.readCount = Object.keys(runtime.reads).length;
    if (runtime.readCount > __companionWorkflowMaxReads()) __companionWorkflowPruneReads(runtime);
    return {
      requestId: requestId,
      threadId: threadId,
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
function __companionWorkflowTurnQuestions(turn) {
  var items = turn != null && Array.isArray(turn.items) ? turn.items : null;
  if (turn != null && turn.itemsView != null && turn.itemsView !== "full") return null;
  if (items != null && items.length > 512) return null;
  var candidates = [];
  if (items == null) return candidates;
  var answered = Object.create(null);
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (item == null || typeof item !== "object") continue;
    if (item.type === "userMessage" || (item.type === "steeringUserMessage" && item.status === "accepted")) {
      // Match the native question-reply envelope. Ordinary messages, rejected
      // steering and partial replies must not settle unrelated questions.
      var content = item.type === "userMessage" ? item.content : item.input;
      if (!Array.isArray(content) || content.length > 128) continue;
      var text = content.filter(function (part) { return part != null && part.type === "text" && typeof part.text === "string"; })
        .map(function (part) { return part.text; }).join("\n");
      var boundary = "\n## My request:\n";
      var boundaryAt = text.lastIndexOf(boundary);
      text = (boundaryAt === -1 ? text : text.slice(boundaryAt + boundary.length)).trim();
      var open = "<send_user_message_question_reply>";
      var close = "</send_user_message_question_reply>";
      if (text.length > 65536 || text.indexOf(open) !== 0 || text.slice(-close.length) !== close) continue;
      var replies;
      try { replies = JSON.parse(text.slice(open.length, -close.length)); } catch (e) { continue; }
      if (!Array.isArray(replies)) replies = [replies];
      if (replies.length === 0 || replies.length > 128) continue;
      var valid = replies.every(function (reply) {
        return reply != null && typeof reply.questionItemId === "string" && typeof reply.question === "string" && typeof reply.answer === "string";
      });
      if (!valid) continue;
      for (var r = 0; r < replies.length; r++) answered[replies[r].questionItemId] = true;
      continue;
    }
    if (item.type !== "agentMessage" || !Array.isArray(item.questions) || item.questions.length === 0) {
      continue;
    }
    if (item.questions.length > 128) return null;
    var itemId = __companionWorkflowString(item.id);
    if (itemId == null) continue;
    var questionKeys = [];
    for (var q = 0; q < item.questions.length; q++) {
      if (item.questions[q] != null && typeof item.questions[q] === "object") {
        questionKeys.push(JSON.stringify(["request_user_input_async", itemId, q]));
      }
    }
    if (questionKeys.length === 0) continue;
    var duplicate = false;
    for (var c = 0; c < candidates.length; c++) {
      if (candidates[c].itemId === itemId) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) candidates.push({ itemId: itemId, questionKeys: questionKeys });
    if (candidates.length > 32) return null;
  }
  return candidates.filter(function (candidate) {
    return candidate.questionKeys.some(function (key) { return answered[key] !== true; });
  });
}
function __companionWorkflowReconcileQuestions(thread, turn, candidates) {
  var turnId = turn != null ? __companionWorkflowString(turn.id) : null;
  if (thread == null || turnId == null) return;
  var keep = Object.create(null);
  for (var i = 0; i < candidates.length; i++) {
    keep[__companionWorkflowQuestionKey(turnId, candidates[i].itemId)] = true;
  }
  var ids = Object.keys(thread.asyncQuestions);
  for (var j = 0; j < ids.length; j++) {
    var question = thread.asyncQuestions[ids[j]];
    if (question == null || question.turnId !== turnId || keep[ids[j]] === true) continue;
    delete thread.asyncQuestions[ids[j]];
    thread.asyncQuestionCount = Math.max(0, (thread.asyncQuestionCount || 1) - 1);
    __companionWorkflowRememberSettledQuestion(thread, ids[j]);
  }
  for (var k = 0; k < candidates.length && (thread.asyncQuestionCount || 0) < 32; k++) {
    var key = __companionWorkflowQuestionKey(turnId, candidates[k].itemId);
    if (thread.settledQuestions[key] === true || thread.asyncQuestions[key] != null) continue;
    thread.asyncQuestions[key] = {
      turnId: turnId,
      itemId: candidates[k].itemId,
      observedAt: Date.now()
    };
    thread.asyncQuestionCount = (thread.asyncQuestionCount || 0) + 1;
  }
}
function __companionWorkflowHydrateRead(runtime, thread, snapshot, includeTurns) {
  if (runtime == null || thread == null || snapshot == null || typeof snapshot !== "object") return false;
  var status = snapshot.status;
  if (status == null || typeof status !== "object" || typeof status.type !== "string") return false;
  var readTurn = includeTurns === true ? __companionWorkflowLatestTurn(snapshot.turns) : null;
  if (readTurn != null) {
    var readStartedAt = __companionWorkflowNumber(readTurn.startedAt);
    if (thread.turnStartedAt != null && readStartedAt != null && readStartedAt < thread.turnStartedAt) return false;
    if (thread.turnId != null && readTurn.id !== thread.turnId &&
        (readStartedAt == null || (thread.turnStartedAt != null && readStartedAt <= thread.turnStartedAt))) return false;
    // Runtime snapshots can lag a terminal already observed for the same turn.
    if (readTurn.status === "inProgress" && thread.turnActive === false &&
        thread.turnId === readTurn.id &&
        (thread.questionClosedTurnId === readTurn.id || thread.completedTurnId === readTurn.id)) return false;
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
      var sameTurn = thread.turnId == null || latestId == null || thread.turnId === latestId;
      var fresh = startedAt != null
        ? thread.turnStartedAt == null || startedAt >= thread.turnStartedAt
        : sameTurn;
      if (fresh) {
        if (thread.turnId != null && latestId != null && thread.turnId !== latestId) {
          __companionWorkflowClearSyncPending(runtime, thread);
          __companionWorkflowResetQuestionState(thread);
          extraActive.completedTurnId = null;
          extraActive.doneEmittedFor = null;
        }
        extraActive.turnId = latestId;
        extraActive.turnStartedAt = startedAt;
        var candidates = __companionWorkflowTurnQuestions(latestInProgress);
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
  // A snapshot for an older turn must never overwrite a newer live start or a
  // terminal of the current turn.
  if (
    thread.turnStartedAt != null &&
    latestStartedAt != null &&
    latestStartedAt < thread.turnStartedAt
  ) {
    return false;
  }
  if (turnStatus !== "inProgress" && thread.turnId != null && thread.turnId !== turnId) {
    // A different terminal turn needs explicit newer timestamps. Without them
    // the current live/newer turn wins and the snapshot is stale.
    if (!(latestStartedAt != null && (thread.turnStartedAt == null || latestStartedAt > thread.turnStartedAt))) {
      return false;
    }
  }
  if (turnStatus === "inProgress") {
    if (thread.turnId != null && thread.turnId !== turnId) {
      __companionWorkflowClearSyncPending(runtime, thread);
      __companionWorkflowResetQuestionState(thread);
    }
    var turnCandidates = __companionWorkflowTurnQuestions(latestTurn);
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
    var completedCandidates = __companionWorkflowTurnQuestions(latestTurn);
    if (completedCandidates == null) return false;
    if (completedCandidates.length > 0 ||
        (!Array.isArray(latestTurn.items) && __companionWorkflowHasPending(thread))) {
      // A completed turn that still shows an unanswered question must never
      // become a false done. Keep existing waiting, otherwise stay idle.
      var keepWaiting = thread.status === "waiting" || __companionWorkflowHasPending(thread);
      __companionWorkflowSetStatusSilent(runtime, thread, keepWaiting ? "waiting" : "idle", {
        turnId: turnId,
        turnStartedAt: latestStartedAt,
        turnActive: false,
        completedTurnId: null,
        doneEmittedFor: null
      });
      thread.observedAt = Math.max(1, Date.now());
      return true;
    }
    __companionWorkflowClearSyncPending(runtime, thread);
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
    __companionWorkflowSettleAsyncQuestions(thread, null);
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
    __companionWorkflowSettleAsyncQuestions(thread, null);
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
function __companionWorkflowReadResponse(provider, webview, response) {
  try {
    var runtime = provider == null ? null : provider.__companionWorkflowRuntime;
    if (runtime == null || runtime.disposed || runtime.reads == null) return false;
    if (response == null || typeof response !== "object") return false;
    var requestId = __companionWorkflowRequestKey(response.id);
    if (requestId == null) return false;
    var record = runtime.reads[requestId];
    if (record == null) return false;
    // The response, or its error, always ends the tracking record.
    __companionWorkflowForgetRead(provider, requestId);
    if (record.webview !== webview) return false;
    if (response.error != null) return false;
    var result = response.result;
    if (result == null || typeof result !== "object") return false;
    var snapshot = result.thread;
    if (snapshot == null || typeof snapshot !== "object") return false;
    var snapshotId = __companionWorkflowString(snapshot.id);
    if (snapshotId == null || snapshotId !== record.threadId) return false;
    if (
      snapshot.hostId !== undefined &&
      snapshot.hostId !== null &&
      __companionWorkflowString(snapshot.hostId) !== "local"
    ) {
      return false;
    }
    var thread = __companionWorkflowEnsureThread(runtime, record.threadId);
    if (thread == null) return false;
    if (record.requestSeq <= (thread.lastHydratedReadSeq || 0)) return false;
    // Any live event observed for the thread after the request invalidates
    // this response, including a same-status event in the same millisecond.
    if ((thread.liveEpoch || 0) !== record.liveEpoch) return false;
    thread.lastHydratedReadSeq = record.requestSeq;
    return __companionWorkflowHydrateRead(runtime, thread, snapshot, record.includeTurns);
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
        thread.questionClosedTurnId = thread.turnId;
        __companionWorkflowSetStatus(runtime, thread, "error", { turnActive: false });
        return true;
      }
      if (status.type === "idle") {
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
      if (item.type === "userMessage") {
        // A user message that was already seen before the question (the
        // original prompt) must not clear it when its completion arrives late.
        if (!__companionWorkflowRememberUserMessage(itemThread, itemKey)) return true;
        __companionWorkflowSettleAsyncQuestions(itemThread, itemTurnId);
        __companionWorkflowSettleAfterAsync(runtime, itemThread);
        return true;
      }
      if (item.type !== "agentMessage") return false;
      if (itemThread.questionClosedTurnId === itemTurnId) return true;
      var questions = item.questions;
      if (!Array.isArray(questions) || questions.length === 0) return false;
      var hasQuestionObject = false;
      for (var questionIndex = 0; questionIndex < questions.length; questionIndex++) {
        if (questions[questionIndex] != null && typeof questions[questionIndex] === "object") {
          hasQuestionObject = true;
          break;
        }
      }
      if (!hasQuestionObject) return false;
      if (itemThread.settledQuestions[itemKey] === true) return true;
      if (itemThread.asyncQuestions[itemKey] != null) {
        if (itemThread.status !== "waiting") {
          __companionWorkflowSetStatus(runtime, itemThread, "waiting", {});
        }
        return true;
      }
      if ((itemThread.asyncQuestionCount || 0) >= 32) return true;
      itemThread.asyncQuestions[itemKey] = {
        turnId: itemTurnId,
        itemId: itemId,
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
        __companionWorkflowClearSyncPending(runtime, completedThreadState);
        __companionWorkflowSettleAsyncQuestions(completedThreadState, null);
        completedThreadState.questionClosedTurnId = completedId;
        __companionWorkflowSetStatus(runtime, completedThreadState, "error", { turnActive: false });
        return true;
      }
      if (terminal === "interrupted" || terminal === "cancelled" || terminal === "canceled") {
        __companionWorkflowClearSyncPending(runtime, completedThreadState);
        __companionWorkflowSettleAsyncQuestions(completedThreadState, null);
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
