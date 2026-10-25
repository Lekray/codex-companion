import assert from 'node:assert/strict';
import Module from 'node:module';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { after, test } from 'node:test';
import type {
  ChildProcessLike,
  ProjectEnvironmentDeps,
  ProjectEnvironmentFs,
  SpawnOptionsLike,
  WorkspaceSnapshot,
} from '../../src/projectEnvironment';
import type { ExtensionContext } from 'vscode';

let uiRoots: string[] = [];
let foldersChanged: (() => void) | undefined;
const uiWarnings: string[] = [];
const vscodeMock = {
  Disposable: { from: (...items: { dispose(): void }[]) => ({ dispose() { items.forEach(item => item.dispose()); } }) },
  commands: { registerCommand: () => ({ dispose() {} }) },
  env: { remoteName: undefined },
  workspace: {
    isTrusted: true,
    workspaceFile: undefined,
    get workspaceFolders() { return uiRoots.map(root => ({ uri: { scheme: 'file', fsPath: root } })); },
    onDidChangeWorkspaceFolders: (callback: () => void) => { foldersChanged = callback; return { dispose() {} }; },
  },
  window: { showWarningMessage: (message: string) => { uiWarnings.push(message); } },
};
const moduleInternals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = function (request, parent, isMain): unknown {
  return request === 'vscode' ? vscodeMock : originalLoad.call(Module, request, parent, isMain);
};
const {
  CODEX_HOME_DIR,
  MARKER_NAME,
  PROJECT_ENVIRONMENT_COMMAND,
  ProjectEnvironmentLauncher,
  ProjectEnvironmentUi,
  USER_DATA_DIR,
  canonicalRoots,
  childArguments,
  childEnvironment,
  isIsolatedProfile,
  isKnownVSCodeExecutable,
  markerDocument,
  normalizeWindowsRoot,
  openOnceOnIsolatedStartup,
  parseProjectMarker,
  projectKey,
  projectProfilePath,
  resolveWorkspace,
} = require('../../src/projectEnvironment') as typeof import('../../src/projectEnvironment');

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    const fromTemp = relative(resolve(tmpdir()), resolve(dir));
    assert.ok(fromTemp && !fromTemp.startsWith('..') && !isAbsolute(fromTemp)
      && basename(dir).startsWith('companion-pe-'), 'Cleanup must stay in owned temporary directories');
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
});

function realFs(): ProjectEnvironmentFs {
  return {
    exists: path => existsSyncCompat(path),
    isDirectory: path => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    },
    isFile: path => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },
    readText: path => {
      try {
        return readFileSync(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    writeExclusive: (path, text) => {
      writeFileSync(path, text, { encoding: 'utf8', flag: 'wx' });
    },
    mkdir: path => {
      mkdirSync(path, { recursive: true });
    },
    realpath: path => realpathSync.native(path),
  };
}

function existsSyncCompat(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function workspaceFor(
  roots: string[],
  workspaceFile?: { scheme: string; path: string },
): WorkspaceSnapshot {
  return {
    trusted: true,
    remote: false,
    platform: 'win32',
    folders: roots.map(path => ({ scheme: 'file', path })),
    ...(workspaceFile ? { workspaceFile } : {}),
  };
}

interface FakeChild {
  child: ChildProcessLike;
  succeed(): void;
  fail(error: Error): void;
  unrefs(): number;
}

function fakeChild(): FakeChild {
  let spawnListener: (() => void) | undefined;
  let errorListener: ((error?: Error) => void) | undefined;
  let unrefs = 0;
  const child: ChildProcessLike = {
    once(event, listener) {
      if (event === 'spawn') spawnListener = listener as () => void;
      else errorListener = listener;
      return child;
    },
    unref() {
      unrefs += 1;
    },
  };
  return {
    child,
    succeed: () => spawnListener?.(),
    fail: error => errorListener?.(error),
    unrefs: () => unrefs,
  };
}

interface SpawnRecord {
  file: string;
  args: string[];
  options: SpawnOptionsLike;
}

function depsFor(
  localAppData: string,
  spawn: ProjectEnvironmentDeps['spawn'],
  env: NodeJS.ProcessEnv = { KEEP_ME: '1' },
): ProjectEnvironmentDeps {
  return {
    platform: 'win32',
    env,
    localAppData,
    execPath: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    fs: realFs(),
    spawn,
  };
}

test('project keys normalize Windows case, separators, trailing slashes and extended paths', () => {
  assert.equal(normalizeWindowsRoot('\\\\?\\C:\\Work\\App\\'), 'C:\\Work\\App');
  assert.equal(normalizeWindowsRoot('\\\\?\\UNC\\Server\\Share\\Folder\\'), '\\\\Server\\Share\\Folder');
  assert.equal(normalizeWindowsRoot('c:/Work/App/'), 'C:\\Work\\App');
  assert.equal(projectKey(['C:\\Work\\App\\']), projectKey(['c:\\work\\app']));
  assert.equal(projectKey(['\\\\?\\c:\\work\\app']), projectKey(['C:\\work\\app\\']));
  assert.match(projectKey(['C:\\Work\\App']), /^[0-9a-f]{32}$/);
  assert.equal(projectProfilePath('C:\\Local', projectKey(['C:\\Work\\App'])), join('C:\\Local', 'CodexCompanion', 'projects', projectKey(['C:\\Work\\App'])));
  assert.equal(parseProjectMarker('{"schemaVersion":2,"roots":["C:\\\\A"]}'), undefined);
});

test('project identity keeps root order and separate roots distinct', () => {
  assert.notEqual(projectKey(['C:\\A']), projectKey(['C:\\B']));
  assert.notEqual(projectKey(['C:\\A', 'C:\\B']), projectKey(['C:\\B', 'C:\\A']));
});

test('workspace guards reject unsupported and unsaved multi-root workspaces', () => {
  const fs = realFs();
  const root = tempDir('companion-pe-guards-');
  const other = tempDir('companion-pe-guards-');
  const workspaceFile = join(root, 'project.code-workspace');
  writeFileSync(workspaceFile, '{}');
  const base = workspaceFor([root]);

  assert.deepEqual(resolveWorkspace({ ...base, platform: 'linux' }, fs), { ok: false, reason: 'unsupported-platform' });
  assert.deepEqual(resolveWorkspace({ ...base, remote: true }, fs), { ok: false, reason: 'remote' });
  assert.deepEqual(resolveWorkspace({ ...base, trusted: false }, fs), { ok: false, reason: 'untrusted' });
  assert.deepEqual(resolveWorkspace({ ...base, folders: [] }, fs), { ok: false, reason: 'no-workspace' });
  assert.deepEqual(resolveWorkspace({ ...base, folders: [{ scheme: 'vscode-remote', path: root }] }, fs), {
    ok: false,
    reason: 'non-file-root',
  });
  assert.deepEqual(resolveWorkspace(workspaceFor([root, other]), fs), { ok: false, reason: 'unsaved-multi-root' });
  assert.deepEqual(resolveWorkspace({ ...base, folders: [{ scheme: 'file', path: 'relative' }] }, fs), {
    ok: false,
    reason: 'relative-root',
  });
  assert.deepEqual(resolveWorkspace({ ...base, folders: [{ scheme: 'file', path: join(root, 'missing') }] }, fs), {
    ok: false,
    reason: 'missing-root',
  });
  assert.deepEqual(resolveWorkspace({ ...base, workspaceFile: { scheme: 'untitled', path: '' } }, fs), {
    ok: false,
    reason: 'unsupported-workspace-file',
  });
  assert.deepEqual(resolveWorkspace({
    ...base,
    workspaceFile: { scheme: 'file', path: join(root, 'missing.code-workspace') },
  }, fs), { ok: false, reason: 'missing-workspace-file' });

  assert.deepEqual(
    resolveWorkspace(workspaceFor([root, other], { scheme: 'file', path: workspaceFile }), fs),
    {
      ok: true,
      target: normalizeWindowsRoot(workspaceFile),
      roots: [normalizeWindowsRoot(root), normalizeWindowsRoot(other)],
    },
  );
  assert.deepEqual(resolveWorkspace(base, fs), {
    ok: true,
    target: normalizeWindowsRoot(root),
    roots: [normalizeWindowsRoot(root)],
  });
});

test('existing marker mismatch or malformed marker rejects without launching or overwriting', async () => {
  const rootA = tempDir('companion-pe-marker-a-');
  const rootB = tempDir('companion-pe-marker-b-');
  const local = tempDir('companion-pe-marker-local-');
  const fs = realFs();
  const canonicalA = canonicalRoots(fs, [rootA]);
  const key = projectKey(canonicalA);
  const profile = projectProfilePath(local, key);
  const markerPath = join(profile, MARKER_NAME);
  mkdirSync(profile, { recursive: true });

  let spawns = 0;
  const launcher = new ProjectEnvironmentLauncher(depsFor(local, () => {
    spawns += 1;
    return fakeChild().child;
  }));

  const mismatch = markerDocument(canonicalRoots(fs, [rootB]));
  writeFileSync(markerPath, mismatch);
  assert.deepEqual(await launcher.launch(workspaceFor([rootA])), { status: 'error', reason: 'marker-mismatch' });
  assert.equal(spawns, 0);
  assert.equal(readFileSync(markerPath, 'utf8'), mismatch);

  writeFileSync(markerPath, '{not json');
  assert.deepEqual(await launcher.launch(workspaceFor([rootA])), { status: 'error', reason: 'marker-invalid' });
  assert.equal(spawns, 0);
  assert.equal(readFileSync(markerPath, 'utf8'), '{not json');
});

test('marker EEXIST race is validated instead of overwritten', async () => {
  const root = tempDir('companion-pe-race-root-');
  const local = tempDir('companion-pe-race-local-');
  const base = realFs();
  const canonical = canonicalRoots(base, [root]);
  const key = projectKey(canonical);
  const profile = projectProfilePath(local, key);
  const markerPath = join(profile, MARKER_NAME);
  const marker = markerDocument(canonical);
  let reads = 0;
  let exclusiveWrites = 0;
  const fs: ProjectEnvironmentFs = {
    ...base,
    readText: path => {
      if (path !== markerPath) return base.readText(path);
      reads += 1;
      return reads === 1 ? undefined : marker;
    },
    writeExclusive: (path, text) => {
      if (path !== markerPath) {
        base.writeExclusive(path, text);
        return;
      }
      exclusiveWrites += 1;
      const error = new Error('EEXIST') as NodeJS.ErrnoException;
      error.code = 'EEXIST';
      throw error;
    },
  };
  const fake = fakeChild();
  let spawns = 0;
  const launcher = new ProjectEnvironmentLauncher({
    platform: 'win32',
    env: { KEEP_ME: '1' },
    localAppData: local,
    execPath: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    fs,
    spawn: () => {
      spawns += 1;
      return fake.child;
    },
  });

  const pending = launcher.launch(workspaceFor([root]));
  await Promise.resolve();
  fake.succeed();
  const result = await pending;
  assert.equal(result.status, 'launched');
  assert.equal(exclusiveWrites, 1);
  assert.equal(reads, 2);
  assert.equal(spawns, 1);
  assert.ok(statSync(profile).isDirectory());
});

test('launch writes only marker/directories and spawns the exact safe command', async () => {
  const root = tempDir('companion-pe-launch-root-');
  const local = tempDir('companion-pe-launch-local-');
  const baseEnv: NodeJS.ProcessEnv = { KEEP_ME: 'keep', PATH: 'C:\\Windows' };
  const records: SpawnRecord[] = [];
  const fake = fakeChild();
  const launcher = new ProjectEnvironmentLauncher(depsFor(local, (file, args, options) => {
    records.push({ file, args: [...args], options });
    return fake.child;
  }, baseEnv));

  const pending = launcher.launch(workspaceFor([root]));
  await Promise.resolve();
  fake.succeed();
  const result = await pending;
  assert.equal(result.status, 'launched');
  if (result.status !== 'launched') return;

  const fs = realFs();
  const canonical = canonicalRoots(fs, [root]);
  const key = projectKey(canonical);
  const profile = projectProfilePath(local, key);
  const codexHome = join(profile, CODEX_HOME_DIR);
  const userData = join(profile, USER_DATA_DIR);

  assert.equal(records.length, 1);
  const call = records[0]!;
  assert.equal(call.file, 'C:\\Program Files\\Microsoft VS Code\\Code.exe');
  assert.deepEqual(call.args, childArguments(userData, normalizeWindowsRoot(root)));
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, false);
  assert.equal(call.options.detached, true);
  assert.equal(call.options.stdio, 'ignore');
  assert.equal(call.options.cwd, canonical[0]);
  assert.deepEqual(call.options.env, childEnvironment(baseEnv, codexHome, key));
  assert.equal(baseEnv.CODEX_HOME, undefined);
  assert.equal(fake.unrefs(), 1);

  assert.deepEqual(readdirSync(profile).sort(), [CODEX_HOME_DIR, MARKER_NAME, USER_DATA_DIR].sort());
  assert.ok(statSync(codexHome).isDirectory());
  assert.ok(statSync(userData).isDirectory());
  const marker = parseProjectMarker(readFileSync(join(profile, MARKER_NAME), 'utf8'));
  assert.ok(marker);
  assert.deepEqual(marker.roots, canonical);
  assert.equal(result.key, key);
  assert.equal(result.profile, profile);
});

test('spawn failure is surfaced without unref and without raw details', async () => {
  const root = tempDir('companion-pe-spawn-root-');
  const local = tempDir('companion-pe-spawn-local-');
  const fake = fakeChild();
  const launcher = new ProjectEnvironmentLauncher(depsFor(local, () => fake.child));

  const pending = launcher.launch(workspaceFor([root]));
  await Promise.resolve();
  fake.fail(new Error('EACCES: raw spawn detail'));
  const result = await pending;
  assert.deepEqual(result, { status: 'error', reason: 'spawn' });
  assert.equal(fake.unrefs(), 0);
  assert.equal(JSON.stringify(result).includes('EACCES'), false);
});

test('reentrant calls return busy and spawn only once', async () => {
  const root = tempDir('companion-pe-busy-root-');
  const local = tempDir('companion-pe-busy-local-');
  const fake = fakeChild();
  let spawns = 0;
  const launcher = new ProjectEnvironmentLauncher(depsFor(local, () => {
    spawns += 1;
    return fake.child;
  }));

  const first = launcher.launch(workspaceFor([root]));
  const second = await launcher.launch(workspaceFor([root]));
  assert.deepEqual(second, { status: 'busy' });
  assert.equal(spawns, 1);
  fake.succeed();
  assert.equal((await first).status, 'launched');
});

test('valid marker with matching isolated environment does not launch a child', async () => {
  const root = tempDir('companion-pe-isolated-root-');
  const local = tempDir('companion-pe-isolated-local-');
  const fs = realFs();
  const fake = fakeChild();
  let spawns = 0;
  const first = new ProjectEnvironmentLauncher(depsFor(local, () => {
    spawns += 1;
    return fake.child;
  }));
  const pending = first.launch(workspaceFor([root]));
  await Promise.resolve();
  fake.succeed();
  await pending;

  const canonical = canonicalRoots(fs, [root]);
  const key = projectKey(canonical);
  const profile = projectProfilePath(local, key);
  const codexHome = join(profile, CODEX_HOME_DIR);
  const isolatedEnv: NodeJS.ProcessEnv = {
    KEEP_ME: '1',
    CODEX_HOME: codexHome,
    CODEX_SQLITE_HOME: codexHome,
    CODEX_COMPANION_PROJECT_ID: key,
  };
  assert.equal(isIsolatedProfile(isolatedEnv, key, codexHome), true);
  assert.equal(isIsolatedProfile(isolatedEnv, key, `${codexHome}\\`), true);
  assert.equal(isIsolatedProfile({ ...isolatedEnv, CODEX_HOME: 'C:\\Other' }, key, codexHome), false);
  assert.equal(isIsolatedProfile({ ...isolatedEnv, CODEX_SQLITE_HOME: 'C:\\Other' }, key, codexHome), false);
  assert.equal(isIsolatedProfile({ ...isolatedEnv, CODEX_COMPANION_PROJECT_ID: 'd'.repeat(32) }, key, codexHome), false);

  const second = new ProjectEnvironmentLauncher(depsFor(local, () => {
    spawns += 1;
    return fakeChild().child;
  }, isolatedEnv));
  assert.deepEqual(await second.launch(workspaceFor([root])), { status: 'already-isolated', key, profile });
  assert.equal(spawns, 1);
});

test('initial isolated startup opens Codex once and records the flag before opening', async () => {
  let opened = 0;
  let flag = false;
  let markedBeforeOpen = false;
  const run = () => openOnceOnIsolatedStartup({
    isolated: true,
    key: 'a'.repeat(32),
    alreadyOpened: flag,
    markOpened: async () => {
      flag = true;
    },
    open: async () => {
      markedBeforeOpen = flag;
      opened += 1;
    },
  });

  assert.equal(await run(), true);
  assert.equal(await run(), false);
  assert.equal(opened, 1);
  assert.equal(markedBeforeOpen, true);
  assert.equal(await openOnceOnIsolatedStartup({
    isolated: false,
    key: 'b'.repeat(32),
    alreadyOpened: false,
    markOpened: async () => {
      assert.fail('must not mark a non-isolated profile');
    },
    open: async () => {
      assert.fail('must not open a non-isolated profile');
    },
  }), false);
});

test('executable check accepts only VS Code binaries, never shell launchers', () => {
  assert.equal(isKnownVSCodeExecutable('C:\\Program Files\\Microsoft VS Code\\Code.exe'), true);
  assert.equal(isKnownVSCodeExecutable('C:\\Program Files\\Microsoft VS Code Insiders\\Code - Insiders.exe'), true);
  assert.equal(isKnownVSCodeExecutable('C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd'), false);
  assert.equal(isKnownVSCodeExecutable('C:\\Program Files\\Microsoft VS Code\\Code.exe.cmd'), false);
  assert.equal(isKnownVSCodeExecutable('C:\\Program Files\\nodejs\\node.exe'), false);
});

test('child environment overrides Codex locations and removes Electron/CLI routing flags', () => {
  const base: NodeJS.ProcessEnv = {
    PATH: 'C:\\Windows',
    KEEP_ME: 'keep',
    CODEX_HOME: 'old',
    CODEX_SQLITE_HOME: 'old',
    CODEX_COMPANION_PROJECT_ID: 'old',
    ELECTRON_RUN_AS_NODE: '1',
    VSCODE_IPC_HOOK_CLI: 'old-instance-pipe',
  };
  const key = 'c'.repeat(32);
  const env = childEnvironment(base, 'C:\\Companion\\codex-home', key);

  assert.equal(env.PATH, 'C:\\Windows');
  assert.equal(env.KEEP_ME, 'keep');
  assert.equal(env.CODEX_HOME, 'C:\\Companion\\codex-home');
  assert.equal(env.CODEX_SQLITE_HOME, 'C:\\Companion\\codex-home');
  assert.equal(env.CODEX_COMPANION_PROJECT_ID, key);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.VSCODE_IPC_HOOK_CLI, undefined);
  assert.equal(base.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(base.CODEX_HOME, 'old');
  assert.equal(base.CODEX_COMPANION_PROJECT_ID, 'old');
  assert.equal(PROJECT_ENVIRONMENT_COMMAND, 'codexCompanion.openProjectEnvironment');
});

test('changing workspace folders in an isolated window warns and blocks Companion opening', () => {
  const rootA = tempDir('companion-pe-bound-a-');
  const rootB = tempDir('companion-pe-bound-b-');
  const local = tempDir('companion-pe-bound-local-');
  const roots = canonicalRoots(realFs(), [rootA]);
  const key = projectKey(roots);
  const profile = projectProfilePath(local, key);
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, MARKER_NAME), markerDocument(roots));
  const fields = ['LOCALAPPDATA', 'CODEX_HOME', 'CODEX_SQLITE_HOME', 'CODEX_COMPANION_PROJECT_ID'] as const;
  const before = Object.fromEntries(fields.map(field => [field, process.env[field]]));
  let ui: InstanceType<typeof ProjectEnvironmentUi> | undefined;
  try {
    process.env.LOCALAPPDATA = local;
    process.env.CODEX_HOME = join(profile, CODEX_HOME_DIR);
    process.env.CODEX_SQLITE_HOME = process.env.CODEX_HOME;
    process.env.CODEX_COMPANION_PROJECT_ID = key;
    uiRoots = [rootA];
    uiWarnings.length = 0;
    ui = new ProjectEnvironmentUi({} as ExtensionContext, false);
    assert.equal(ui.guardCurrentWorkspace(), true);
    uiRoots = [rootB];
    foldersChanged!();
    assert.equal(ui.guardCurrentWorkspace(), false);
    assert.equal(uiWarnings.length, 1);
    uiRoots = [rootA];
    assert.equal(ui.guardCurrentWorkspace(), true);
  } finally {
    ui?.dispose();
    uiRoots = [];
    for (const field of fields) {
      if (before[field] === undefined) delete process.env[field];
      else process.env[field] = before[field];
    }
  }
});
