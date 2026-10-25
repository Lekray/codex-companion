/* Companion tab-title sync - pure, dependency-free payload validation.
 * Injected verbatim into the official Codex extension host (out/extension.js).
 * It MUST NOT import/require anything, MUST NOT touch globalThis, and MUST NOT
 * export - it is evaluated as a plain script. Keep it self-contained.
 *
 * A title report is accepted only for the local host and a local thread route.
 * The route id may be either the resolved server thread id or the client thread
 * id from the same route, because a newly-created chat can still be addressed
 * by its client id while the title store already resolves the saved id.
 */
function __companionTabTitlePayload(message, localPrefix) {
  if (message === null || typeof message !== "object") return null;
  var prefix = typeof localPrefix === "string" && localPrefix.length > 0 ? localPrefix : "/local/";
  var threadId = typeof message.threadId === "string" && message.threadId.length > 0 ? message.threadId : null;
  var hostId = typeof message.hostId === "string" ? message.hostId : null;
  var route = typeof message.route === "string" ? message.route : null;
  var title = typeof message.title === "string" ? message.title : null;
  var routeThreadId =
    typeof message.routeThreadId === "string" && message.routeThreadId.length > 0
      ? message.routeThreadId
      : null;
  var reset = message.reset === true || threadId === null || hostId !== "local" || route === null || title === null;

  if (!reset && route.indexOf(prefix) !== 0) reset = true;

  if (!reset) {
    var rest = route.slice(prefix.length);
    var slash = rest.indexOf("/");
    var routeId = slash === -1 ? rest : rest.slice(0, slash);
    if (routeId.length === 0 || (routeId !== threadId && routeId !== routeThreadId)) reset = true;
  }

  if (!reset) {
    var trimmed = title.trim();
    if (trimmed.length > 0) {
      return { reset: false, threadId: threadId, hostId: "local", route: route, title: trimmed };
    }
  }

  return { reset: true, threadId: null, hostId: null, route: null, title: null };
}
