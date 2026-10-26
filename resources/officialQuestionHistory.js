/* Companion compact question-history assembler - pure, dependency-free runtime.
 *
 * Injected verbatim into the official Codex extension host (out/extension.js).
 * It MUST NOT import/require anything and MUST NOT export/module.exports.
 * It defines only named global helpers and runs no side effects on load.
 *
 * It observes native thread/turns/list, thread/items/list and
 * thread/resume(initialTurnsPage) responses that native code was going to
 * deliver anyway. It never issues its own RPC, never polls, never persists,
 * and never decides terminal vs waiting. When it can prove a COMPLETE item set
 * for the latest turn it emits compact evidence via deps.complete(...):
 * item ids + question/answer key arrays only, never message text.
 */

var __companionQuestionMaxGroups = 16;
var __companionQuestionMaxItems = 512;
var __companionQuestionMaxPages = 16;
var __companionQuestionMaxQuestionItems = 32;
var __companionQuestionMaxString = 4096;
var __companionQuestionMaxReply = 65536;
var __companionQuestionTurnStatuses = [
  "inProgress",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "canceled"
];

function __companionQuestionBoundString(value) {
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= __companionQuestionMaxString
  ) {
    return value;
  }
  return null;
}

function __companionQuestionNumber(value) {
  return typeof value === "number" && isFinite(value) ? value : null;
}

// Cursor normalization. Returns:
//   { root: true }              for null / absent request cursor
//   { kind: "string", value }   for a nonempty opaque string cursor
//   { kind: "item", value }     for { type: "item", itemId: string } anchors
//   { invalid: true }           for unknown / malformed cursors
function __companionQuestionCursorInfo(cursor) {
  if (typeof cursor === "string") {
    if (cursor.length > 0 && cursor.length <= __companionQuestionMaxString) {
      return { kind: "string", value: cursor };
    }
    return { invalid: true };
  }
  if (cursor != null && typeof cursor === "object") {
    if (
      cursor.type === "item" &&
      typeof cursor.itemId === "string" &&
      cursor.itemId.length > 0 &&
      cursor.itemId.length <= __companionQuestionMaxString
    ) {
      return { kind: "item", value: cursor.itemId };
    }
    return { invalid: true };
  }
  return { invalid: true };
}

function __companionQuestionRequestCursor(cursor) {
  if (cursor === null || cursor === undefined) return { root: true };
  return __companionQuestionCursorInfo(cursor);
}

function __companionQuestionNextCursor(nextCursor) {
  if (nextCursor === null) return { end: true };
  if (nextCursor === undefined) return { unknown: true };
  return __companionQuestionCursorInfo(nextCursor);
}

function __companionQuestionCursorEquals(a, b) {
  if (a == null || b == null) return false;
  if (a.root === true || b.root === true) {
    return a.root === true && b.root === true;
  }
  return a.kind === b.kind && a.value === b.value;
}

function __companionQuestionCursorKey(info) {
  if (info == null || info.root === true) return "#";
  return (info.kind === "string" ? "s:" : "i:") + info.value;
}

function __companionQuestionDirection(value, fallback) {
  if (value == null) return fallback;
  return value === "asc" || value === "desc" ? value : null;
}

function __companionQuestionSameKeys(a, b) {
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// Parse the native question-reply envelope exactly like the V2 TurnQuestions
// helper. Returns an array of answer questionItemId strings or null.
function __companionQuestionParseReply(item) {
  var content = item.type === "userMessage" ? item.content : item.input;
  if (!Array.isArray(content) || content.length > 128) return null;
  var parts = [];
  for (var i = 0; i < content.length; i++) {
    var part = content[i];
    if (part == null || typeof part !== "object" || Array.isArray(part) || typeof part.type !== "string") return null;
    if (part.type === "text" && typeof part.text !== "string") return null;
    if (
      part != null &&
      typeof part === "object" &&
      part.type === "text" &&
      typeof part.text === "string"
    ) {
      parts.push(part.text);
    }
  }
  var text = parts.join("\n");
  var boundary = "\n## My request:\n";
  var boundaryAt = text.lastIndexOf(boundary);
  if (boundaryAt !== -1) text = text.slice(boundaryAt + boundary.length);
  text = text.trim();
  var open = "<send_user_message_question_reply>";
  var close = "</send_user_message_question_reply>";
  if (text.length > __companionQuestionMaxReply) return null;
  if (text.indexOf(open) !== 0) return [];
  if (text.slice(-close.length) !== close) return null;
  var replies;
  try {
    replies = JSON.parse(text.slice(open.length, -close.length));
  } catch (e) {
    return null;
  }
  if (!Array.isArray(replies)) replies = [replies];
  if (replies.length === 0 || replies.length > 128) return null;
  var answerKeys = [];
  for (var r = 0; r < replies.length; r++) {
    var reply = replies[r];
    if (reply == null || typeof reply !== "object") return null;
    if (
      typeof reply.questionItemId !== "string" ||
      typeof reply.question !== "string" ||
      typeof reply.answer !== "string"
    ) {
      return null;
    }
    var questionItemId = __companionQuestionBoundString(reply.questionItemId);
    if (questionItemId == null) return null;
    answerKeys.push(questionItemId);
  }
  return answerKeys;
}

// Compact projection of a single item. Returns null for malformed,
// unprovable or over-limit data. Retains only ids and key arrays.
function __companionQuestionProject(item) {
  if (item == null || typeof item !== "object" || Array.isArray(item)) return null;
  var type = item.type;
  var itemId = __companionQuestionBoundString(item.id);
  if (itemId == null || __companionQuestionBoundString(type) == null) return null;
  var projected = { id: itemId, questionKeys: [], answerKeys: [] };
  if (type === "agentMessage") {
    var questions = item.questions;
    if (questions == null) return projected;
    if (!Array.isArray(questions) || questions.length > 128) return null;
    var questionKeys = [];
    for (var q = 0; q < questions.length; q++) {
      if (questions[q] == null || typeof questions[q] !== "object" || Array.isArray(questions[q])) return null;
      var key = JSON.stringify(["request_user_input_async", itemId, q]);
      if (__companionQuestionBoundString(key) == null) return null;
      questionKeys.push(key);
    }
    return { id: itemId, questionKeys: questionKeys, answerKeys: [] };
  }
  if (type === "userMessage" || (type === "steeringUserMessage" && item.status === "accepted")) {
    var answerKeys = __companionQuestionParseReply(item);
    if (answerKeys == null) return null;
    return { id: itemId, questionKeys: [], answerKeys: answerKeys };
  }
  return projected;
}

// Union exact question keys minus exact answer keys, per item id.
function __companionQuestionCandidates(projectedItems) {
  var result = [];
  if (!Array.isArray(projectedItems)) return result;
  var answers = Object.create(null);
  var byId = Object.create(null);
  var order = [];
  for (var i = 0; i < projectedItems.length; i++) {
    var p = projectedItems[i];
    if (p == null || typeof p !== "object") continue;
    if (Array.isArray(p.answerKeys)) {
      for (var a = 0; a < p.answerKeys.length; a++) {
        if (typeof p.answerKeys[a] === "string") answers[p.answerKeys[a]] = true;
      }
    }
    if (p.id != null && Array.isArray(p.questionKeys) && p.questionKeys.length > 0) {
      var entry = byId[p.id];
      if (entry == null) {
        entry = { itemId: p.id, keys: Object.create(null) };
        byId[p.id] = entry;
        order.push(p.id);
      }
      for (var q = 0; q < p.questionKeys.length; q++) {
        if (typeof p.questionKeys[q] === "string") entry.keys[p.questionKeys[q]] = true;
      }
    }
  }
  for (var o = 0; o < order.length; o++) {
    var itemId = order[o];
    var e = byId[itemId];
    var remaining = [];
    var keys = Object.keys(e.keys);
    for (var k = 0; k < keys.length; k++) {
      if (answers[keys[k]] !== true) remaining.push(keys[k]);
    }
    if (remaining.length > 0) result.push({ itemId: itemId, questionKeys: remaining });
  }
  return result;
}

function __companionCreateQuestionHistory(deps) {
  var groups = [];
  var generation = 0;
  var emitted = Object.create(null);
  var emittedOrder = [];

  function findGroup(threadId, webview) {
    for (var i = 0; i < groups.length; i++) {
      if (groups[i].threadId === threadId && groups[i].webview === webview) return groups[i];
    }
    return null;
  }

  function ensureGroup(threadId, webview) {
    var existing = findGroup(threadId, webview);
    if (existing != null) return existing;
    if (groups.length >= __companionQuestionMaxGroups) groups.shift();
    var group = {
      threadId: threadId,
      webview: webview,
      generation: 0,
      chain: null,
      turn: null,
      pendingRoot: null,
      requested: null,
      rootRequestSeq: null,
      rootLiveEpoch: null,
      completeEmitted: false
    };
    groups.push(group);
    return group;
  }

  function resetAssembly(group) {
    group.chain = null;
    group.turn = null;
    group.pendingRoot = null;
    group.requested = null;
    group.rootRequestSeq = null;
    group.rootLiveEpoch = null;
    group.completeEmitted = false;
  }

  function invalidateGroup(group) {
    generation += 1;
    group.generation = generation;
    resetAssembly(group);
  }

  function normalizeRequestedPage(params) {
    var sortDirection = __companionQuestionDirection(params.sortDirection, "desc");
    if (sortDirection == null) return null;
    var itemsView = params.itemsView;
    if (itemsView == null) itemsView = "summary";
    if (itemsView !== "summary" && itemsView !== "notLoaded" && itemsView !== "full") return null;
    return { sortDirection: sortDirection, itemsView: itemsView };
  }

  function currentEpoch(threadId) {
    if (deps == null || typeof deps.currentEpoch !== "function") return null;
    try {
      return deps.currentEpoch(threadId);
    } catch (e) {
      return null;
    }
  }

  function accumulateProjection(state, projection) {
    if (projection == null) return false;
    var previous = state.itemIdSeen[projection.id];
    if (previous != null) return __companionQuestionSameKeys(previous.questionKeys, projection.questionKeys) &&
      __companionQuestionSameKeys(previous.answerKeys, projection.answerKeys);
    state.itemIdSeen[projection.id] = projection;
    state.items.push(projection);
    return true;
  }

  function projectInlineItems(rawItems) {
    if (!Array.isArray(rawItems)) return null;
    if (rawItems.length > __companionQuestionMaxItems) return null;
    var state = { items: [], itemIdSeen: Object.create(null) };
    for (var i = 0; i < rawItems.length; i++) {
      var item = rawItems[i];
      var projection = __companionQuestionProject(item);
      if (projection == null) return null;
      if (!accumulateProjection(state, projection)) return null;
    }
    return state.items;
  }

  function extractItem(entry, expectedTurnId) {
    if (entry == null || typeof entry !== "object") return null;
    if ("turnId" in entry) {
      if (entry.turnId !== expectedTurnId) return null;
      if (!("item" in entry)) return null;
      var item = entry.item;
      if (item == null || typeof item !== "object") return null;
      return item;
    }
    if ("item" in entry) return null;
    if (typeof entry.type !== "string" || entry.type.length === 0) return null;
    return entry;
  }

  function emitComplete(group, items) {
    if (group.completeEmitted) return false;
    if (typeof deps.complete !== "function" || group.rootRequestSeq <= (emitted[group.threadId] || 0)) return false;
    var questionItems = 0;
    for (var i = 0; i < items.length; i++) {
      if (items[i] != null && Array.isArray(items[i].questionKeys) && items[i].questionKeys.length > 0) {
        questionItems += 1;
      }
    }
    if (questionItems > __companionQuestionMaxQuestionItems) {
      invalidateGroup(group);
      return false;
    }
    group.completeEmitted = true;
    if (emitted[group.threadId] == null) emittedOrder.push(group.threadId);
    emitted[group.threadId] = group.rootRequestSeq;
    if (emittedOrder.length > 512) delete emitted[emittedOrder.shift()];
    var data = {
      threadId: group.threadId,
      webview: group.webview,
      requestSeq: group.rootRequestSeq,
      liveEpoch: group.rootLiveEpoch,
      turn: { id: group.turn.id, status: group.turn.status, startedAt: group.turn.startedAt },
      items: items
    };
    try {
      deps.complete(data);
      return true;
    } catch (e) {
      return false;
    }
  }

  function latestTurnMeta(page, requested) {
    if (page == null || typeof page !== "object") return null;
    var data = page.data;
    if (!Array.isArray(data) || data.length === 0 || data.length > 512) return null;
    for (var i = 0; i < data.length; i++) {
      if (data[i] == null || typeof data[i] !== "object" || __companionQuestionBoundString(data[i].id) == null) return null;
    }
    var candidate;
    if (requested.sortDirection === "asc") {
      if (page.nextCursor !== null) return null;
      candidate = data[data.length - 1];
    } else {
      candidate = data[0];
    }
    if (candidate == null || typeof candidate !== "object") return null;
    var id = __companionQuestionBoundString(candidate.id);
    if (id == null) return null;
    var status = candidate.status;
    if (typeof status !== "string") return null;
    var recognized = false;
    for (var s = 0; s < __companionQuestionTurnStatuses.length; s++) {
      if (__companionQuestionTurnStatuses[s] === status) {
        recognized = true;
        break;
      }
    }
    if (!recognized) return null;
    var startedAt;
    if (typeof candidate.startedAt === "number" && isFinite(candidate.startedAt)) {
      startedAt = candidate.startedAt;
    } else if (candidate.startedAt == null) {
      startedAt = null;
    } else {
      return null;
    }
    return {
      id: id,
      status: status,
      startedAt: startedAt,
      items: candidate.items,
      itemsView: candidate.itemsView
    };
  }

  function handleTurnsPage(group, page) {
    var requested = group.requested;
    var meta = latestTurnMeta(page, requested);
    if (meta == null) {
      invalidateGroup(group);
      return false;
    }
    group.turn = { id: meta.id, status: meta.status, startedAt: meta.startedAt };
    var fullInline =
      requested.itemsView === "full" &&
      Array.isArray(meta.items) &&
      (meta.itemsView == null || meta.itemsView === "full");
    if (fullInline) {
      var projected = projectInlineItems(meta.items);
      if (projected == null) {
        invalidateGroup(group);
        return false;
      }
      group.chain = null;
      return emitComplete(group, projected);
    }
    group.chain = {
      turnId: meta.id,
      direction: requested.sortDirection,
      expectedCursor: { root: true },
      seenCursors: Object.create(null),
      items: [],
      itemIdSeen: Object.create(null),
      rawCount: 0,
      pageCount: 0,
      complete: false
    };
    group.completeEmitted = false;
    return false;
  }

  function handleItemsPage(group, record, result) {
    var chain = group.chain;
    if (chain == null) return false;
    var params = record.params != null && typeof record.params === "object" ? record.params : null;
    if (params == null || params.turnId !== chain.turnId) return false;
    if (result == null || typeof result !== "object" || !Array.isArray(result.data)) {
      invalidateGroup(group);
      return false;
    }
    var requestCursor = __companionQuestionRequestCursor(params.cursor);
    if (!__companionQuestionCursorEquals(requestCursor, chain.expectedCursor)) { invalidateGroup(group); return false; }
    var direction = __companionQuestionDirection(params.sortDirection, "asc");
    if (direction == null) { invalidateGroup(group); return false; }
    if (chain.pageCount === 0) {
      chain.direction = direction;
    } else if (chain.direction !== direction) {
      invalidateGroup(group); return false;
    }
    var nextInfo = __companionQuestionNextCursor(result.nextCursor);
    if (nextInfo.unknown || nextInfo.invalid) {
      invalidateGroup(group);
      return false;
    }
    if (!requestCursor.root) {
      var requestKey = __companionQuestionCursorKey(requestCursor);
      if (chain.seenCursors[requestKey]) {
        invalidateGroup(group);
        return false;
      }
      chain.seenCursors[requestKey] = true;
    }
    if (!nextInfo.end) {
      var nextKey = __companionQuestionCursorKey(nextInfo);
      if (chain.seenCursors[nextKey]) {
        invalidateGroup(group);
        return false;
      }
    }
    if (chain.pageCount + 1 > __companionQuestionMaxPages) {
      invalidateGroup(group);
      return false;
    }
    var data = result.data;
    for (var i = 0; i < data.length; i++) {
      var item = extractItem(data[i], chain.turnId);
      if (item == null) {
        invalidateGroup(group);
        return false;
      }
      if (chain.rawCount >= __companionQuestionMaxItems) {
        invalidateGroup(group);
        return false;
      }
      chain.rawCount += 1;
      var projection = __companionQuestionProject(item);
      if (projection == null) { invalidateGroup(group); return false; }
      if (!accumulateProjection(chain, projection)) {
        invalidateGroup(group);
        return false;
      }
    }
    chain.pageCount += 1;
    if (nextInfo.end) {
      group.chain = null;
      return emitComplete(group, chain.items);
    }
    chain.expectedCursor = nextInfo;
    return false;
  }

  function track(record) {
    if (record == null || typeof record !== "object") return;
    delete record.historyGeneration;
    var threadId = __companionQuestionBoundString(record.threadId);
    var webview = record.webview;
    if (threadId == null || webview == null) return;
    if (typeof record.requestSeq !== "number" || !isFinite(record.requestSeq) || record.requestSeq <= 0 || Math.floor(record.requestSeq) !== record.requestSeq) return;
    if (typeof record.liveEpoch !== "number" || currentEpoch(threadId) !== record.liveEpoch) return;
    var method = record.method;
    if (method === "thread/turns/list" || method === "thread/resume") {
      var params = record.params != null && typeof record.params === "object" ? record.params : null;
      if (params == null) return;
      var requested;
      var pendingMethod;
      if (method === "thread/turns/list") {
        if (!__companionQuestionRequestCursor(params.cursor).root) return;
        requested = normalizeRequestedPage(params);
        pendingMethod = method;
      } else {
        if (params.initialTurnsPage == null || typeof params.initialTurnsPage !== "object") return;
        if (!__companionQuestionRequestCursor(params.initialTurnsPage.cursor).root) return;
        requested = normalizeRequestedPage(params.initialTurnsPage);
        pendingMethod = method;
      }
      if (requested == null) return;
      var group = ensureGroup(threadId, webview);
      if (group == null) return;
      if (group.rootRequestSeq != null && record.requestSeq <= group.rootRequestSeq) return;
      invalidateGroup(group);
      group.pendingRoot = { method: pendingMethod };
      group.requested = requested;
      group.rootRequestSeq = __companionQuestionNumber(record.requestSeq);
      group.rootLiveEpoch = record.liveEpoch;
      record.historyGeneration = group.generation;
      return;
    }
    if (method === "thread/items/list") {
      var group = findGroup(threadId, webview);
      if (group == null || group.chain == null) return;
      if (group.rootLiveEpoch !== record.liveEpoch) { invalidateGroup(group); return; }
      var params = record.params != null && typeof record.params === "object" ? record.params : null;
      if (params == null || params.turnId !== group.chain.turnId) return;
      record.historyGeneration = group.generation;
      return;
    }
  }

  function receive(record, result, error) {
    if (record == null || typeof record !== "object") return false;
    if (record.historyGeneration == null) return false;
    var threadId = __companionQuestionBoundString(record.threadId);
    var webview = record.webview;
    if (threadId == null || webview == null) return false;
    var group = findGroup(threadId, webview);
    if (group == null || group.generation !== record.historyGeneration) return false;
    var epoch = currentEpoch(threadId);
    if (epoch == null || epoch !== record.liveEpoch || epoch !== group.rootLiveEpoch) {
      invalidateGroup(group);
      return false;
    }
    if (error != null || result == null) {
      invalidateGroup(group);
      return false;
    }
    if (record.method === "thread/turns/list" || record.method === "thread/resume") {
      if (group.pendingRoot == null || group.pendingRoot.method !== record.method) return false;
      group.pendingRoot = null;
      if (record.method === "thread/resume") {
        if (result == null || typeof result !== "object") {
          invalidateGroup(group);
          return false;
        }
        if (result.thread == null || typeof result.thread !== "object") { invalidateGroup(group); return false; }
        if (result.thread.hostId != null && result.thread.hostId !== "local") { invalidateGroup(group); return false; }
        if (result.thread != null && typeof result.thread === "object") {
          var resumeThreadId = __companionQuestionBoundString(result.thread.id);
          if (resumeThreadId == null || resumeThreadId !== threadId) {
            invalidateGroup(group);
            return false;
          }
        }
        return handleTurnsPage(group, result.initialTurnsPage);
      }
      return handleTurnsPage(group, result);
    }
    if (record.method === "thread/items/list") {
      return handleItemsPage(group, record, result);
    }
    return false;
  }

  function forget(record) {
    if (record == null || typeof record !== "object") return;
    var threadId = __companionQuestionBoundString(record.threadId);
    var webview = record.webview;
    if (threadId == null || webview == null) return;
    var group = findGroup(threadId, webview);
    if (group == null) return;
    if (record.historyGeneration == null || record.historyGeneration !== group.generation) return;
    invalidateGroup(group);
  }

  function disposeWebview(webview) {
    for (var i = groups.length - 1; i >= 0; i--) {
      if (groups[i].webview === webview) groups.splice(i, 1);
    }
  }

  function clear() {
    groups.length = 0;
    emitted = Object.create(null);
    emittedOrder = [];
  }

  return {
    track: track,
    receive: receive,
    forget: forget,
    disposeWebview: disposeWebview,
    clear: clear
  };
}
