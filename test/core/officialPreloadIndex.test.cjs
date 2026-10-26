"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const preload = require("../../scripts/officialPreloadIndex.cjs");

const EXPECTED_ORIGINAL_HASH =
  "9852ece5b9a25906b654fa8cccd77873105fe1b88556b141fc35dc4062511629";
const EXPECTED_PATCHED_HASH =
  "3753642aab9026fe1fdf361530612b6a3864ec7c084e68778c6f7f003e7c549e";

const BASE = "https://app.test/assets/";
const IMPORT_META_URL = "https://app.test/assets/app-initial-13f932cb2f13.js";

const installedFile = process.env.COMPANION_PRELOAD_INDEX_FIXTURE
  ? path.resolve(process.env.COMPANION_PRELOAD_INDEX_FIXTURE)
  : fs.existsSync(path.resolve(__dirname, '../../.artifacts/fixes-0210/originals', preload.FILE))
    ? path.resolve(__dirname, '../../.artifacts/fixes-0210/originals', preload.FILE)
    : path.join(
      process.env.USERPROFILE || process.env.HOME || "",
      ".vscode/extensions/openai.chatgpt-26.1021.22027-win32-x64/webview/assets/app-initial-13f932cb2f13.js"
    );

const sourceAvailable = fs.existsSync(installedFile);
const source = sourceAvailable ? fs.readFileSync(installedFile, "utf8") : "";
const info = sourceAvailable ? preload.analyze(source) : null;
const patched = sourceAvailable ? preload.transform(source) : "";
const patchedInfo = sourceAvailable ? preload.analyze(patched) : null;
const originalHelper = info ? source.slice(info.helperStart, info.helperEnd) : "";
const indexedHelper = patchedInfo
  ? patched.slice(patchedInfo.helperStart, patchedInfo.helperEnd)
  : "";

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function needSource(t) {
  if (sourceAvailable) return true;
  t.skip(`installed ${preload.FILE} is not available at ${installedFile}`);
  return false;
}

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.cancelable = Boolean(init.cancelable);
    this.defaultPrevented = false;
    this.payload = undefined;
  }

  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }
}

class FakeLink {
  constructor(state, tagName, record) {
    this.state = state;
    this.tagName = String(tagName).toUpperCase();
    this.rel = "";
    this.as = undefined;
    this.crossOrigin = undefined;
    this._href = "";
    this._attributes = new Map();
    this._listeners = new Map();
    if (record) state.created.push(this);
  }

  get href() {
    this.state.hrefReads += 1;
    return this._href;
  }

  set href(value) {
    this._href = String(value);
  }

  setAttribute(name, value) {
    this._attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this._attributes.has(name) ? this._attributes.get(name) : null;
  }

  addEventListener(type, listener) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(listener);
  }

  dispatch(type) {
    for (const listener of this._listeners.get(type) || []) listener();
  }
}

/*
 * Minimal controlled DOM. getElementsByTagName returns a live array-like
 * collection, exactly like the browser, so the pristine helper's backwards
 * scan and the indexed helper's (re)built per-call snapshot see the same links.
 */
function createDom(options = {}) {
  const state = {
    links: [],
    created: [],
    appended: [],
    events: [],
    hrefReads: 0,
    imports: 0,
  };
  const collection = {};
  Object.defineProperty(collection, "length", {
    get() {
      return state.links.length;
    },
  });

  const attach = (link) => {
    state.links.push(link);
    const index = state.links.length - 1;
    Object.defineProperty(collection, index, {
      configurable: true,
      enumerable: true,
      get() {
        return state.links[index];
      },
    });
  };

  const addExistingLink = (spec) => {
    const link = new FakeLink(state, "link", false);
    link.rel = spec.rel || "";
    if (spec.as !== undefined) link.as = spec.as;
    if (spec.crossOrigin !== undefined) link.crossOrigin = spec.crossOrigin;
    link.href = spec.href;
    attach(link);
    return link;
  };

  let meta = null;
  if (options.meta === "property") {
    meta = {
      nonce: options.nonce,
      getAttribute() {
        return options.nonce;
      },
    };
  } else if (options.meta === "attribute") {
    meta = {
      getAttribute(name) {
        return name === "nonce" ? options.nonce : null;
      },
    };
  }

  const document = {
    getElementsByTagName(name) {
      assert.equal(name, "link");
      return collection;
    },
    querySelector(selector) {
      return selector === "meta[property=csp-nonce]" ? meta : null;
    },
    createElement(name) {
      return new FakeLink(state, name, true);
    },
    head: {
      appendChild(link) {
        state.appended.push(link);
        attach(link);
        return link;
      },
    },
  };

  const window = {
    dispatchEvent(event) {
      state.events.push(event);
      if (options.onPreloadError && event.type === "vite:preloadError") {
        options.onPreloadError(event);
      }
      return !event.defaultPrevented;
    },
  };

  for (const spec of options.links || []) addExistingLink(spec);

  return { document, window, Event: FakeEvent, URL, state, addExistingLink };
}

/*
 * Compile the helper exactly as it appears in the bundle. The only harness
 * substitution is import.meta -> an injected object; it is applied identically
 * to the pristine and indexed variants, and the surrounding scope supplies the
 * same y/x/b bindings the bundle factory provides. Everything else (DOM,
 * Event, URL, promises) is the controlled environment.
 */
function compileHelper(helperText, env, options = {}) {
  const importMeta =
    options.resolve === false
      ? { url: IMPORT_META_URL }
      : { url: IMPORT_META_URL, resolve: (url) => url };
  const factory = new Function(
    "document",
    "window",
    "Event",
    "URL",
    "__importMeta",
    "S",
    'let y="modulepreload",x={};const b=function(e,t){return new URL(e,t).href};return (' +
      helperText.split("import.meta").join("__importMeta") +
      ");"
  );
  return factory(env.document, env.window, env.Event, URL, importMeta, undefined);
}

function makeImport(state, mode) {
  return function importModule() {
    state.imports += 1;
    if (mode === "reject") return Promise.reject(new Error("import failed"));
    return Promise.resolve("imported");
  };
}

function snapshot(state) {
  return {
    created: state.created.map((link) => ({
      tagName: link.tagName,
      rel: link.rel,
      as: link.as,
      crossOrigin: link.crossOrigin,
      href: link._href,
      nonce: link.getAttribute("nonce"),
      attributes: Array.from(link._attributes.entries()),
      listeners: Array.from(link._listeners.keys()),
    })),
    appended: state.appended.map((link) => link._href),
    imports: state.imports,
    events: state.events.map((event) => ({
      type: event.type,
      cancelable: event.cancelable,
      defaultPrevented: event.defaultPrevented,
      payload: event.payload ? event.payload.message : null,
    })),
  };
}

async function settle(promise) {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (error) {
    return { status: "rejected", message: error && error.message };
  }
}

const EXISTING_LINKS = [
  { href: BASE + "already.css", rel: "stylesheet" },
  { href: BASE + "plain.css", rel: "preload", as: "style" },
  { href: BASE + "alt.css", rel: "stylesheet alternate" },
  { href: BASE + "already.js", rel: "modulepreload" },
  { href: BASE + "odd.js", rel: "stylesheet" },
  { href: BASE + "dup.css", rel: "stylesheet" },
  { href: BASE + "dup.css", rel: "stylesheet" },
];

const FIRST_DEPS = [
  "./already.css",
  "./plain.css",
  "./alt.css",
  "./already.js",
  "./odd.js",
  "./fresh.css",
  "./fresh.js",
  "./fresh.js",
  "./weird.css?cache=.js",
  "./name.js#frag.css",
  "./dup.css",
];

const EXPECTED_CREATED = [
  { rel: "stylesheet", href: BASE + "plain.css" },
  { rel: "stylesheet", href: BASE + "alt.css" },
  { rel: "stylesheet", href: BASE + "fresh.css" },
  { rel: "modulepreload", href: BASE + "fresh.js" },
  { rel: "modulepreload", href: BASE + "weird.css?cache=.js" },
  { rel: "stylesheet", href: BASE + "name.js#frag.css" },
  { rel: "stylesheet", href: BASE + "later.css" },
];

function settleNewCssLinks(env, fromIndex) {
  for (let index = fromIndex; index < env.state.created.length; index += 1) {
    const link = env.state.created[index];
    if (link.rel === "stylesheet") link.dispatch("load");
  }
}

async function runSuccessScenario(helperText, options = {}) {
  const env = createDom({
    meta: "property",
    nonce: "top-secret",
    links: EXISTING_LINKS,
    ...options.dom,
  });
  const S = compileHelper(helperText, env, options.compile);
  const call = (dependencies) =>
    S(makeImport(env.state, options.importMode || "resolve"), dependencies, BASE);
  const results = [];

  let fromIndex = env.state.created.length;
  let promise = call(FIRST_DEPS);
  settleNewCssLinks(env, fromIndex);
  results.push(await promise);

  env.addExistingLink({ href: BASE + "late.css", rel: "stylesheet" });
  env.addExistingLink({ href: BASE + "late.js", rel: "modulepreload" });
  fromIndex = env.state.created.length;
  promise = call(["./late.css", "./late.js", "./fresh.js", "./already.css"]);
  settleNewCssLinks(env, fromIndex);
  results.push(await promise);

  fromIndex = env.state.created.length;
  promise = call(["./later.css"]);
  settleNewCssLinks(env, fromIndex);
  results.push(await promise);

  return { record: snapshot(env.state), results };
}

async function runCssFailure(helperText, options = {}) {
  const env = createDom({
    meta: "attribute",
    nonce: "attr-nonce",
    onPreloadError: options.prevent ? (event) => event.preventDefault() : undefined,
  });
  const S = compileHelper(helperText, env, options.compile);
  const promise = S(makeImport(env.state, "resolve"), ["./ok.css", "./bad.css"], BASE);
  for (const link of env.state.created) {
    if (link._href === BASE + "ok.css") link.dispatch("load");
    if (link._href === BASE + "bad.css") link.dispatch("error");
  }
  const outcome = await settle(promise);
  return { record: snapshot(env.state), outcome };
}

async function runImportFailure(helperText, options = {}) {
  const env = createDom({
    meta: null,
    onPreloadError: options.prevent ? (event) => event.preventDefault() : undefined,
  });
  const S = compileHelper(helperText, env, options.compile);
  const promise = S(makeImport(env.state, "reject"), ["./ok.css"], BASE);
  for (const link of env.state.created) link.dispatch("load");
  const outcome = await settle(promise);
  return { record: snapshot(env.state), outcome };
}

function measureLookup(helperText, linkCount, dependencyCount) {
  const links = [];
  for (let index = 0; index < linkCount; index += 1) {
    links.push({ href: `${BASE}existing-${index}.css`, rel: "stylesheet" });
  }
  const dependencies = [];
  for (let index = 0; index < dependencyCount; index += 1) {
    dependencies.push(`./new-${index}.${index % 5 === 0 ? "css" : "js"}`);
  }
  const env = createDom({ meta: null, links });
  const S = compileHelper(helperText, env);
  S(makeImport(env.state, "resolve"), dependencies, BASE);
  return { hrefReads: env.state.hrefReads, created: env.state.created.length };
}

test("exports the pinned helper constants", () => {
  assert.equal(preload.SUPPORTED_VERSION, "26.1021.22027");
  assert.equal(preload.FILE, "webview/assets/app-initial-13f932cb2f13.js");
  assert.equal(preload.ORIGINAL_HASH, EXPECTED_ORIGINAL_HASH);
  assert.equal(preload.PATCHED_HASH, EXPECTED_PATCHED_HASH);
});

test("pins the exact installed pristine bundle and helper", (t) => {
  if (!needSource(t)) return;
  assert.equal(sha256(source), preload.ORIGINAL_HASH);
  assert.equal(info.patched, false);
  assert.equal(info.helperLength, 1130);
  assert.equal(originalHelper, source.slice(info.helperStart, info.helperEnd));
  assert.ok(originalHelper.startsWith("S=function(e,t,n){"));
  assert.ok(originalHelper.includes("i.href===t&&(!r||i.rel===`stylesheet`)"));
});

test("transform rewrites only the preload helper", (t) => {
  if (!needSource(t)) return;
  assert.equal(sha256(patched), preload.PATCHED_HASH);
  assert.equal(patchedInfo.patched, true);
  assert.equal(patchedInfo.helperStart, info.helperStart);
  assert.equal(
    patched.length,
    source.length + patchedInfo.helperLength - info.helperLength
  );
  assert.equal(patched.slice(0, info.helperStart), source.slice(0, info.helperStart));
  const tailLength = source.length - info.helperEnd;
  assert.equal(
    patched.slice(patched.length - tailLength),
    source.slice(info.helperEnd)
  );
  assert.ok(patched.includes("u=new Set,h=new Set"));
  assert.ok(patched.includes("if(r?h.has(t):u.has(t))return;"));
  assert.equal(patched.includes("i.href===t&&(!r||i.rel===`stylesheet`)"), false);
});

test("exact pinned output is idempotent but changed source is refused", (t) => {
  if (!needSource(t)) return;
  assert.equal(preload.transform(patched), patched);
  assert.throws(() => preload.transform(source + " "), /SHA256/);
  assert.throws(() => preload.transform(""), /SHA256/);
  assert.throws(
    () => preload.transform(source.replace("i.href===t", "i.href!==t")),
    /SHA256/
  );
  assert.throws(() => preload.transform(null), /source must be a string/);
});

test("analyze rejects missing, duplicated and mutated helper seams", (t) => {
  if (!needSource(t)) return;
  assert.throws(() => preload.analyze(""), /known preload helper must occur exactly once/);
  assert.throws(
    () => preload.analyze(source + originalHelper),
    /known preload helper must occur exactly once/
  );
  assert.throws(
    () => preload.analyze(patched + originalHelper),
    /known preload helper must occur exactly once/
  );
  assert.throws(
    () => preload.analyze(source.replace("i.href===t", "i.href!==t")),
    /known preload helper must occur exactly once/
  );
  assert.throws(() => preload.analyze(null), /source must be a string/);
});

test("patched bundle remains valid native ES module syntax", (t) => {
  if (!needSource(t)) return;
  const check = spawnSync(process.execPath, ["--input-type=module", "--check", "-"], {
    input: patched,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(check.status, 0, check.stderr);
});

test(
  "indexed helper reproduces every pristine preload operation",
  { timeout: 20000 },
  async (t) => {
    if (!needSource(t)) return;
    const pristine = await runSuccessScenario(originalHelper);
    const indexed = await runSuccessScenario(indexedHelper);

    assert.deepEqual(indexed.record, pristine.record);
    assert.deepEqual(indexed.results, pristine.results);
    assert.deepEqual(indexed.results, ["imported", "imported", "imported"]);

    assert.deepEqual(
      indexed.record.created.map((link) => ({ rel: link.rel, href: link.href })),
      EXPECTED_CREATED
    );
    assert.equal(indexed.record.imports, 3);
    assert.deepEqual(indexed.record.events, []);
    for (const link of indexed.record.created) {
      assert.equal(link.crossOrigin, "");
      assert.equal(link.nonce, "top-secret");
      assert.deepEqual(link.attributes, [["nonce", "top-secret"]]);
      assert.deepEqual(link.listeners, link.rel === "stylesheet" ? ["load", "error"] : []);
      assert.equal(link.as, link.rel === "stylesheet" ? undefined : "script");
    }
  }
);

test(
  "CSS load failure and cancelable preload error keep pristine semantics",
  { timeout: 20000 },
  async (t) => {
    if (!needSource(t)) return;
    for (const prevent of [false, true]) {
      const pristine = await runCssFailure(originalHelper, { prevent });
      const indexed = await runCssFailure(indexedHelper, { prevent });
      assert.deepEqual(indexed, pristine);

      const error = `Unable to preload CSS for ${BASE}bad.css`;
      assert.equal(indexed.record.imports, prevent ? 1 : 0);
      assert.deepEqual(indexed.record.events, [
        {
          type: "vite:preloadError",
          cancelable: true,
          defaultPrevented: prevent,
          payload: error,
        },
      ]);
      assert.deepEqual(
        indexed.outcome,
        prevent
          ? { status: "fulfilled", value: "imported" }
          : { status: "rejected", message: error }
      );
      for (const link of indexed.record.created) {
        assert.equal(link.nonce, "attr-nonce");
      }
    }
  }
);

test(
  "import failure, nonce fallback and URL fallback keep pristine semantics",
  { timeout: 20000 },
  async (t) => {
    if (!needSource(t)) return;
    for (const prevent of [false, true]) {
      const pristine = await runImportFailure(originalHelper, {
        prevent,
        compile: { resolve: false },
      });
      const indexed = await runImportFailure(indexedHelper, {
        prevent,
        compile: { resolve: false },
      });
      assert.deepEqual(indexed, pristine);
      assert.equal(indexed.record.imports, 1);
      assert.deepEqual(indexed.record.events, [
        {
          type: "vite:preloadError",
          cancelable: true,
          defaultPrevented: prevent,
          payload: "import failed",
        },
      ]);
      assert.deepEqual(
        indexed.outcome,
        prevent
          ? { status: "fulfilled", value: undefined }
          : { status: "rejected", message: "import failed" }
      );
      assert.deepEqual(
        indexed.record.created.map((link) => link.nonce),
        [null]
      );
    }
  }
);

test("existing-link lookup is linear in links, not dependencies", (t) => {
  if (!needSource(t)) return;

  const small = measureLookup(indexedHelper, 400, 1600);
  const large = measureLookup(indexedHelper, 800, 1600);
  assert.equal(small.hrefReads, 400);
  assert.equal(large.hrefReads, 800);
  assert.equal(small.created, 1600);
  assert.equal(large.created, 1600);

  const productionWorkload = measureLookup(indexedHelper, 1600, 3203);
  assert.equal(productionWorkload.hrefReads, 1600);
  assert.equal(productionWorkload.created, 3203);

  const pristine = measureLookup(originalHelper, 800, 1600);
  assert.ok(
    pristine.hrefReads > 100 * large.hrefReads,
    `pristine scan read ${pristine.hrefReads} hrefs, indexed helper read ${large.hrefReads}`
  );
});
