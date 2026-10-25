/* Companion history scoping — pure, dependency-free path normalization/matching.
 * Injected verbatim into the official Codex extension host (out/extension.js, CommonJS)
 * and into the official webview bundles (ESM). It MUST NOT import/require anything,
 * MUST NOT touch globalThis, and MUST NOT export — it is evaluated as a plain script
 * in both environments. Keep it self-contained.
 *
 * Rules (per architecture):
 *  - root == cwd, or cwd nested after a path separator; no sibling prefix.
 *  - Absolute Windows drive/UNC paths: slash/backslash-insensitive, case-insensitive.
 *  - Extended \\?\ prefixes handled (incl. \\?\UNC\ form).
 *  - Trailing slashes and . / .. dot segments resolved lexically (no filesystem access).
 *  - POSIX/WSL absolute paths stay case-sensitive even in a Windows process.
 *  - null / empty / relative / drive-relative ("C:foo") paths are rejected (=> no match).
 */
function __companionNormPath(v) {
  if (v === null || v === undefined) return null;
  var s = String(v);
  if (s.length === 0) return null;

  // Extended-length prefix "\\?\" (also "\\?\UNC\server\share").
  var forceUnc = false;
  if (/^\\\\\?[\\/]/.test(s)) {
    s = s.slice(4);
    if (/^UNC[\\/]/i.test(s)) {
      forceUnc = true;
      s = s.slice(4);
    }
  }

  var prefix;
  var lower;
  if (forceUnc) {
    prefix = "//";
    lower = true;
  } else if (/^[A-Za-z]:[\\/]/.test(s)) {
    prefix = s.slice(0, 1).toLowerCase() + ":";
    s = s.slice(2);
    lower = true;
  } else if (/^[\\/]{2}/.test(s)) {
    s = s.slice(2);
    prefix = "//";
    lower = true;
  } else if (/^[\\/]/.test(s)) {
    s = s.slice(1);
    prefix = "/";
    lower = false;
  } else {
    // Relative path or drive-relative path like "C:foo".
    return null;
  }

  var body = __companionResolveSegments(s);
  if (body === null) return null;
  if (lower) body = body.toLowerCase();

  if (prefix === "/") return body === "" ? "/" : "/" + body;
  if (prefix === "//") return body === "" ? null : "//" + body;
  // Drive prefix: root keeps exactly one trailing slash ("c:/"), subpaths do not.
  return body === "" ? prefix + "/" : prefix + "/" + body;
}

function __companionResolveSegments(s) {
  s = s.replace(/\\/g, "/");
  var out = [];
  var parts = s.split("/");
  for (var i = 0; i < parts.length; i++) {
    var seg = parts[i];
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length) out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

function __companionNormalizedRoots(roots) {
  if (!Array.isArray(roots)) return [];
  var rn = [];
  for (var i = 0; i < roots.length; i++) {
    var x = __companionNormPath(roots[i]);
    if (x !== null && rn.indexOf(x) === -1) rn.push(x);
  }
  return rn;
}

function __companionCwdMatchesRoots(cwd, roots) {
  var n = __companionNormPath(cwd);
  if (n === null) return false;
  if (!Array.isArray(roots)) return false;
  for (var i = 0; i < roots.length; i++) {
    var rn = __companionNormPath(roots[i]);
    if (rn === null) continue;
    if (n === rn) return true;
    if (rn.charAt(rn.length - 1) === "/" ? n.indexOf(rn) === 0 : n.indexOf(rn + "/") === 0) return true;
  }
  return false;
}

function __companionThreadCwd(row) {
  if (!row || typeof row !== "object") return undefined;
  var thread = row;
  if (row.thread !== null && typeof row.thread === "object") thread = row.thread;
  return thread && typeof thread === "object" ? thread.cwd : undefined;
}

// Filters list/search data rows by roots. roots === null/undefined => no scoping
// (return data unchanged); roots === [] (or all-invalid) => fail closed (return []).
function __companionFilterRows(data, roots) {
  if (roots === null || roots === undefined) return data;
  if (!Array.isArray(data)) return data;
  var rn = __companionNormalizedRoots(roots);
  if (rn.length === 0) return [];
  return data.filter(function (row) {
    return __companionCwdMatchesRoots(__companionThreadCwd(row), rn);
  });
}
