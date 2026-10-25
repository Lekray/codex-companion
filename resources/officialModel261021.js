/* Pure renderer payload. Initialization is lazy because the native modules
 * use cyclic imports and may invoke exports before evaluating module bodies. */
function __companionModelBus() {
  var bus = globalThis.__companionModelRuntime261021;
  if (!bus) bus = globalThis.__companionModelRuntime261021 = { state: Object.create(null), projectKey: null };
  return bus;
}
function __companionModelFreshState() {
  return { pending: 0, choiceSeq: 0, lastSuccessfulSeq: 0, userChose: false,
    applied: false, applying: false, pair: null, apply: null };
}
function __companionModelState(key) {
  var bus = __companionModelBus();
  return bus.state[key] || (bus.state[key] = __companionModelFreshState());
}
function __companionModelDispatch(type, payload) {
  if (typeof globalThis.__companionDispatch === 'function') globalThis.__companionDispatch(type, payload);
}
function __companionModelWrapSet(original, cell) {
  return function (model, effort, options) {
    var current = cell.current || {};
    var meta = { conversationId: current.conversationId, hostId: current.hostId,
      projectKey: __companionModelBus().projectKey };
    var restoring = options != null && options.__companionRestore === true;
    var nativeOptions = options;
    if (meta.conversationId == null && meta.hostId === 'local') {
      nativeOptions = Object.assign({}, options, { persistAsDefault: false });
      delete nativeOptions.__companionRestore;
    }
    if (restoring) return original(model, effort, nativeOptions);
    var state = __companionModelState(meta.conversationId == null ? '' : meta.conversationId);
    var seq = ++state.choiceSeq, intentAt = Date.now();
    state.pending++;
    function settle(value, ok) {
      state.pending--;
      if (ok && value !== false) {
        state.userChose = true; state.applied = true; state.pair = null;
        if (seq > state.lastSuccessfulSeq) {
          state.lastSuccessfulSeq = seq;
          if (meta.hostId === 'local') {
            try { __companionModelDispatch('companion-project-model-selected', {
              hostId: 'local', conversationId: meta.conversationId, model: model,
              effort: effort, intentAt: intentAt, intentSeq: seq, projectKey: meta.projectKey
            }); } catch (_) {}
          }
        }
      } else if (typeof state.apply === 'function') state.apply();
    }
    var result;
    try { result = original(model, effort, nativeOptions); }
    catch (error) { settle(null, false); throw error; }
    if (result != null && typeof result.then === 'function') return result.then(function (value) {
      settle(value, true); return value;
    }, function (error) { settle(null, false); throw error; });
    settle(result, true); return result;
  };
}
function __companionModelEligible(meta) {
  return meta && meta.conversationId == null && meta.hostId === 'local' && meta.locked !== true;
}
function __companionModelRestoreStart(cell) {
  if (!__companionModelEligible(cell.current)) return function () {};
  var bus = __companionModelBus(), state = __companionModelFreshState();
  bus.state[''] = state;
  var closed = false, timer = null, retries = 0, requestId = null;
  function apply() {
    var meta = cell.current;
    if (closed || !__companionModelEligible(meta) || state.applied || state.applying ||
        state.userChose || state.pending > 0 || state.pair == null) return;
    var models = meta.catalog && meta.catalog.models;
    if (!Array.isArray(models) || !meta.settings || meta.settings.isLoading === true ||
        meta.status === 'pending' || meta.status === 'loading') return;
    var pair = state.pair;
    var entry = models.find(function (item) { return item && item.model === pair.model; });
    var supported = entry && Array.isArray(entry.supportedReasoningEfforts) &&
      entry.supportedReasoningEfforts.some(function (item) { return item && item.reasoningEffort === pair.effort; });
    if (!supported) { state.pair = null; state.applied = true; return; }
    var setter = meta.selection && meta.selection.setModelAndReasoningEffort;
    if (typeof setter !== 'function') return;
    state.applying = true;
    function settled(value) {
      state.applying = false;
      if (!closed && value !== false) { state.applied = true; state.pair = null; }
    }
    var result;
    try { result = setter(pair.model, pair.effort, { persistAsDefault: false, __companionRestore: true }); }
    catch (_) { state.applying = false; return; }
    if (result != null && typeof result.then === 'function') result.then(settled, function () { state.applying = false; });
    else settled(result);
  }
  function request() {
    if (closed || state.applied || state.userChose) return;
    requestId = 'companion-model-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    __companionModelDispatch('companion-project-model-request', { requestId: requestId, hostId: 'local' });
  }
  function receive(message) {
    if (closed || !message || message.requestId !== requestId) return;
    if (typeof message.projectKey === 'string') bus.projectKey = message.projectKey;
    if (state.applied || state.userChose) return;
    if (message.pending === true) {
      if (retries++ < 5) { if (timer != null) clearTimeout(timer); timer = setTimeout(request, 600); }
      return;
    }
    if (message.valid === true && typeof message.model === 'string' && typeof message.effort === 'string') {
      state.pair = { model: message.model, effort: message.effort }; apply();
    }
  }
  state.apply = apply;
  var unsubscribe = typeof globalThis.__companionSubscribe === 'function'
    ? globalThis.__companionSubscribe('companion-project-model', receive) : null;
  request();
  return function () {
    closed = true;
    if (timer != null) clearTimeout(timer);
    state.apply = null;
    if (typeof unsubscribe === 'function') unsubscribe();
  };
}
function __companionModelApplyCurrent() {
  var state = __companionModelBus().state[''];
  if (state && typeof state.apply === 'function') state.apply();
}
