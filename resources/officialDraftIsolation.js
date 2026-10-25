/*
 * Companion draft isolation helper - pure, dependency-free payload.
 *
 * Injected verbatim at the top of both official webview bundles for the
 * pinned Codex 26.1007.21434 build. It reads only the per-editor
 * <meta name="initial-route"> value (the same route source the official
 * router uses), extracts a Companion UUID from the HOME route, and exposes
 * one deterministic key helper for the native draft seam:
 *
 *   Fv({kind:"new", entrypoint:"home", gptId:null})
 *     -> __companionDraftIsolation.scopeKey(xp({entrypoint:"home"}))
 *
 * With no valid HOME Companion token scopeKey() returns its argument
 * unchanged, so native tabs keep the literal "new-conversation" key for the
 * ComposerScope atom and both native draft stores. It does not read files,
 * storage or developer artifacts and never writes user data.
 */
(function () {
  "use strict";

  var MARKER = "__companionDraftIsolation";
  var VERSION = 2;
  var DRAFT_MARKER = "companion-draft-isolation-v1";
  var BASE_HOME = "new-conversation";
  var SUFFIX = ":companion:";
  var UUID_PATTERN =
    "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  var TOKEN_RE = new RegExp("^" + UUID_PATTERN + "$", "i");

  function normalizeToken(value) {
    if (typeof value !== "string") return null;
    var trimmed = value.trim();
    return TOKEN_RE.test(trimmed) ? trimmed.toLowerCase() : null;
  }

  function decodeOnce(value) {
    if (typeof value !== "string" || value.indexOf("%") === -1) return null;
    try {
      return decodeURIComponent(value);
    } catch (_) {
      return null;
    }
  }

  function parseQuery(query) {
    if (typeof query !== "string" || query.length === 0) return null;
    var candidates = [query];
    var decoded = decodeOnce(query);
    if (decoded != null && decoded !== query) candidates.push(decoded);
    for (var i = 0; i < candidates.length; i += 1) {
      var candidate = candidates[i];
      if (typeof URLSearchParams === "function") {
        try {
          var params = new URLSearchParams(candidate);
          var values = params.getAll("companion");
          for (var j = 0; j < values.length; j += 1) {
            var fromParams = normalizeToken(values[j]);
            if (fromParams != null) return fromParams;
          }
        } catch (_) {}
      }
      // Support the observed whole-query encoding: ?companion%3D<uuid>.
      var pairs = candidate.split("&");
      for (var k = 0; k < pairs.length; k += 1) {
        var pair = pairs[k];
        var eq = pair.indexOf("=");
        if (eq === -1) continue;
        var key = pair.slice(0, eq);
        try {
          key = decodeURIComponent(key);
        } catch (_) {}
        if (key !== "companion") continue;
        var raw = pair.slice(eq + 1);
        if (raw.indexOf("%") !== -1) {
          try {
            raw = decodeURIComponent(raw);
          } catch (_) {}
        }
        var token = normalizeToken(raw);
        if (token != null) return token;
      }
    }
    return null;
  }

  function parseInitialRoute(route) {
    if (typeof route !== "string") return null;
    var value = route.trim();
    if (value.length === 0) return null;
    var hashIndex = value.indexOf("#");
    if (hashIndex !== -1) value = value.slice(0, hashIndex);
    var queryIndex = value.indexOf("?");
    var path = queryIndex === -1 ? value : value.slice(0, queryIndex);
    // Only the official HOME path qualifies. Saved/local/sidebar/panel routes
    // are deliberately left native.
    if (path !== "/") return null;
    if (queryIndex === -1) return null;
    return parseQuery(value.slice(queryIndex + 1));
  }

  function readInitialRoute() {
    try {
      if (
        typeof document !== "undefined" &&
        document != null &&
        typeof document.querySelector === "function"
      ) {
        var meta = document.querySelector('meta[name="initial-route"]');
        if (
          meta != null &&
          typeof meta.content === "string" &&
          meta.content.trim().length > 0
        ) {
          return meta.content.trim();
        }
      }
    } catch (_) {}
    try {
      if (
        typeof window !== "undefined" &&
        window != null &&
        window.location != null &&
        typeof URL === "function"
      ) {
        var route = new URL(window.location.href).searchParams.get("initialRoute");
        if (route != null && route.trim().length > 0) return route.trim();
      }
    } catch (_) {}
    return null;
  }

  var resolved = false;
  var cachedToken = null;

  function token() {
    if (!resolved) {
      resolved = true;
      try {
        cachedToken = parseInitialRoute(readInitialRoute());
      } catch (_) {
        cachedToken = null;
      }
    }
    return cachedToken;
  }

  /*
   * Only the native HOME base key is scoped, and only for a valid Companion
   * UUID. Every other native key (panel, saved, local, gpt, cloud, chatgpt,
   * library, PR, other) is returned unchanged. The token is the initial
   * per-editor identity, never a per-focus nonce.
   */
  function scopeKey(nativeKey) {
    if (nativeKey !== BASE_HOME) return nativeKey;
    var value = token();
    return value == null ? nativeKey : nativeKey + SUFFIX + value;
  }

  var api = {
    marker: MARKER,
    version: VERSION,
    draftMarker: DRAFT_MARKER,
    homeKey: BASE_HOME,
    isValidCompanionToken: function (value) {
      return normalizeToken(value) != null;
    },
    parseQuery: parseQuery,
    parseInitialRoute: parseInitialRoute,
    readInitialRoute: readInitialRoute,
    token: token,
    scopeKey: scopeKey
  };

  if (typeof globalThis !== "undefined" && globalThis[MARKER] == null) {
    globalThis[MARKER] = api;
  }
  if (typeof module !== "undefined" && module && module.exports) {
    module.exports = api;
  }
})();
