import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import {
  BRIDGE_FOCUS_TAB_COMMAND,
  BRIDGE_GET_STATE_COMMAND,
  FOCUS_WINDOW_COMMAND,
  WORKFLOW_EVENT_COMMAND,
  WorkflowUi,
  type BridgeEvent,
  type OfficialOpenTab,
  type WorkflowUiDependencies,
} from '../../src/workflowUi';
import type { NotificationSettings, NotificationSound } from '../../src/workflowNotifications';
import {
  PATCH_NOTICE_KEY,
  PatchCompatibilityUi,
  type CompatibilityStatusItem,
  type CompatibilityUiDependencies,
} from '../../src/patchCompatibilityUi';

const artifacts = join(process.cwd(), '.artifacts', 'workflow-v15', 'ui', 'fixtures');
const INSTANCE = 'bridge-a';

type Calls = {
  claims: string[];
  inApp: Array<{ message: string; openLabel: string }>;
  native: Array<{ title: string; message: string }>;
  sounds: NotificationSound[];
  statusEvents: BridgeEvent[];
  commands: Array<{ command: string; args: unknown[] }>;
  revealed: Array<{ uri: string; column: number }>;
  errors: unknown[];
};

interface HarnessOptions {
  handshake?: boolean;
  sequence?: number;
  focused?: boolean;
  local?: boolean;
  compatible?: boolean;
  settings?: Partial<NotificationSettings>;
  claim?: (eventId: string) => Promise<boolean>;
  nativeResult?: boolean;
  commands?: readonly string[];
  openTabs?: readonly OfficialOpenTab[];
  onStatusEvent?: (event: BridgeEvent) => void;
}

function bridgeState(sequence = 10, instanceId = INSTANCE) {
  return {
    apiVersion: 1,
    instanceId,
    sequence,
    capabilities: { statuses: true, projectModel: true },
    tabs: [],
    projectModel: null,
  };
}

function statusEvent(
  sequence: number,
  eventId: string,
  overrides: {
    instanceId?: string;
    live?: boolean;
    status?: string;
    previousStatus?: string;
    panelId?: string;
    threadId?: string | null;
    hostId?: string;
    title?: string;
  } = {},
): Record<string, unknown> {
  return {
    apiVersion: 1,
    kind: 'status',
    instanceId: overrides.instanceId ?? INSTANCE,
    sequence,
    live: overrides.live ?? true,
    eventId,
    tab: {
      panelId: overrides.panelId ?? 'panel-1',
      threadId: overrides.threadId === undefined ? 'thread-1' : overrides.threadId,
      hostId: overrides.hostId ?? 'local',
      route: '/local/thread-1',
      title: overrides.title ?? 'Fix build',
      status: overrides.status ?? 'done',
      turnId: 'turn-1',
      updatedAt: 1,
    },
    previousStatus: overrides.previousStatus ?? 'running',
  };
}

function harness(options: HarnessOptions = {}) {
  const calls: Calls = {
    claims: [],
    inApp: [],
    native: [],
    sounds: [],
    statusEvents: [],
    commands: [],
    revealed: [],
    errors: [],
  };
  const settings: NotificationSettings = {
    enabled: true,
    windows: true,
    sound: true,
    ...options.settings,
  };
  let handler: ((argument?: unknown) => unknown) | undefined;
  let registrationDisposed = false;
  const commands = options.commands ?? [BRIDGE_GET_STATE_COMMAND, BRIDGE_FOCUS_TAB_COMMAND, FOCUS_WINDOW_COMMAND];
  const dependencies: WorkflowUiDependencies = {
    russian: false,
    extensionPath: 'C:\\extension',
    claimDir: 'C:\\unused-claims',
    local: () => options.local ?? true,
    focused: () => options.focused ?? true,
    settings: () => settings,
    registerCommand: (command, registered) => {
      assert.equal(command, WORKFLOW_EVENT_COMMAND);
      handler = registered;
      return {
        dispose: () => {
          registrationDisposed = true;
        },
      };
    },
    executeCommand: async (command, ...args) => {
      calls.commands.push({ command, args });
      if (command === BRIDGE_GET_STATE_COMMAND) {
        return options.handshake === false ? undefined : bridgeState(options.sequence ?? 10);
      }
      if (command === BRIDGE_FOCUS_TAB_COMMAND) return true;
      return undefined;
    },
    getCommands: async () => options.handshake === false ? [] : commands,
    inApp: async (message, openLabel) => {
      calls.inApp.push({ message, openLabel });
      return false;
    },
    native: async (title, message) => {
      calls.native.push({ title, message });
      return options.nativeResult ?? false;
    },
    claimEvent: async eventId => {
      calls.claims.push(eventId);
      return options.claim ? options.claim(eventId) : true;
    },
    sound: async sound => {
      calls.sounds.push(sound);
    },
    openOfficialTabs: () => options.openTabs ?? [],
    revealOfficialTab: async (uri, column) => {
      calls.revealed.push({ uri, column });
    },
    projectName: () => 'Alpha',
    onStatusEvent: event => {
      calls.statusEvents.push(event);
      options.onStatusEvent?.(event);
    },
    onError: error => {
      calls.errors.push(error);
    },
  };
  const ui = new WorkflowUi(dependencies);
  ui.setCompatibilityGate(() => options.compatible ?? true);
  return {
    ui,
    calls,
    emit: (argument?: unknown) => {
      assert.ok(handler, 'event sink is registered');
      handler(argument);
    },
    registrationDisposed: () => registrationDisposed,
  };
}

async function settle(ui: WorkflowUi): Promise<void> {
  await ui.whenReady();
  await ui.flush();
}

test('a valid live running-to-done transition claims once and sounds once', async () => {
  const h = harness();
  await h.ui.whenReady();
  h.emit(statusEvent(11, 'done-1'));
  await h.ui.flush();

  assert.deepEqual(h.calls.claims, ['done-1']);
  assert.deepEqual(h.calls.sounds, ['done']);
  assert.equal(h.calls.inApp.length, 1);
  assert.match(h.calls.inApp[0]!.message, /Alpha: Fix build . done/);
  assert.deepEqual(h.calls.errors, []);
  h.ui.dispose();
  assert.equal(h.registrationDisposed(), true);
});

test('wrong schema, host, instance and stale sequences are ignored', async () => {
  const h = harness();
  await h.ui.whenReady();
  h.emit(statusEvent(9, 'stale'));
  h.emit({ ...statusEvent(10, 'schema'), apiVersion: 2 });
  h.emit(statusEvent(11, 'instance', { instanceId: 'other-bridge' }));
  h.emit(statusEvent(12, 'foreign', { hostId: 'remote' }));
  await h.ui.flush();

  assert.equal(h.calls.claims.length, 0);
  assert.deepEqual(h.calls.sounds, []);
  assert.equal(h.calls.inApp.length, 0);
  assert.equal(h.calls.statusEvents.length, 0);

  h.emit(statusEvent(13, 'valid-after-ignored'));
  await h.ui.flush();
  assert.deepEqual(h.calls.claims, ['valid-after-ignored']);
  assert.deepEqual(h.calls.statusEvents.map(event => event.eventId), ['valid-after-ignored']);
  h.ui.dispose();
});

test('snapshot/restoration events never notify or play sound', async () => {
  const h = harness();
  await h.ui.whenReady();
  h.emit(statusEvent(11, 'snapshot', { live: false }));
  await h.ui.flush();

  assert.equal(h.calls.claims.length, 0);
  assert.deepEqual(h.calls.sounds, []);
  assert.equal(h.calls.inApp.length, 0);
  // Accepted snapshots still refresh the attention/status view silently.
  assert.deepEqual(h.calls.statusEvents.map(event => event.eventId), ['snapshot']);
  assert.equal(h.calls.statusEvents[0]!.live, false);
  h.ui.dispose();
});

test('a silent snapshot is not remembered, so a later identical live event notifies once', async () => {
  const h = harness();
  await h.ui.whenReady();
  const eventId = 'local|thread-1|turn-1|done';
  h.emit(statusEvent(11, eventId, { live: false, status: 'done', previousStatus: 'running' }));
  await h.ui.flush();

  assert.deepEqual(
    h.calls.statusEvents.map(event => [event.eventId, event.live]),
    [[eventId, false]]
  );
  assert.equal(h.calls.claims.length, 0);
  assert.deepEqual(h.calls.sounds, []);
  assert.equal(h.calls.inApp.length, 0);

  h.emit(statusEvent(12, eventId, { live: true, status: 'done', previousStatus: 'running' }));
  await h.ui.flush();
  assert.deepEqual(h.calls.claims, [eventId]);
  assert.deepEqual(h.calls.sounds, ['done']);
  assert.equal(h.calls.inApp.length, 1);
  assert.deepEqual(
    h.calls.statusEvents.map(event => [event.eventId, event.live]),
    [
      [eventId, false],
      [eventId, true],
    ]
  );
  h.ui.dispose();
});

test('a duplicate logical event id is not repeated and distinct transitions are not cooled down', async () => {
  const h = harness();
  await h.ui.whenReady();
  h.emit(statusEvent(11, 'same-logical'));
  h.emit(statusEvent(12, 'same-logical'));
  await h.ui.flush();
  assert.deepEqual(h.calls.claims, ['same-logical']);
  assert.deepEqual(h.calls.sounds, ['done']);

  h.emit(statusEvent(13, 'next-turn'));
  await h.ui.flush();
  assert.deepEqual(h.calls.claims, ['same-logical', 'next-turn']);
  assert.deepEqual(h.calls.sounds, ['done', 'done']);
  h.ui.dispose();
});

test('cancelled is not done; error stays mute and waiting plays the waiting sound', async () => {
  const h = harness();
  await h.ui.whenReady();
  h.emit(statusEvent(11, 'cancelled', { status: 'cancelled' }));
  h.emit(statusEvent(12, 'error', { status: 'error', previousStatus: 'running' }));
  h.emit(statusEvent(13, 'waiting', { status: 'waiting', previousStatus: 'running' }));
  await h.ui.flush();

  assert.deepEqual(h.calls.claims, ['error', 'waiting']);
  assert.deepEqual(h.calls.sounds, ['waiting']);
  assert.equal(h.calls.inApp.length, 2);
  h.ui.dispose();
});

test('a live idle-to-waiting transition notifies needs-your-answer with the waiting sound', async () => {
  const h = harness();
  await h.ui.whenReady();
  h.emit(statusEvent(11, 'wait-from-idle', { status: 'waiting', previousStatus: 'idle' }));
  await h.ui.flush();

  assert.deepEqual(h.calls.claims, ['wait-from-idle']);
  assert.deepEqual(h.calls.sounds, ['waiting']);
  assert.equal(h.calls.inApp.length, 1);
  assert.match(h.calls.inApp[0]!.message, /Alpha: Fix build . needs your answer/);
  assert.deepEqual(h.calls.statusEvents.map(event => event.eventId), ['wait-from-idle']);
  assert.deepEqual(h.calls.errors, []);
  h.ui.dispose();
});

test('snapshot, stale, invalid, replayed and repeated waiting events stay silent', async () => {
  const h = harness();
  await h.ui.whenReady();
  h.emit(statusEvent(11, 'wait-snapshot', {
    live: false,
    status: 'waiting',
    previousStatus: 'idle',
  }));
  h.emit(statusEvent(9, 'wait-stale', { status: 'waiting', previousStatus: 'idle' }));
  h.emit({
    ...statusEvent(12, 'wait-invalid', { status: 'waiting', previousStatus: 'idle' }),
    apiVersion: 2,
  });
  h.emit(statusEvent(13, 'wait-duplicate', { status: 'waiting', previousStatus: 'idle' }));
  h.emit(statusEvent(14, 'wait-duplicate', { status: 'waiting', previousStatus: 'idle' }));
  h.emit(statusEvent(15, 'wait-repeat', { status: 'waiting', previousStatus: 'waiting' }));
  await h.ui.flush();

  assert.deepEqual(h.calls.claims, ['wait-duplicate']);
  assert.deepEqual(h.calls.sounds, ['waiting']);
  assert.equal(h.calls.inApp.length, 1);
  h.ui.dispose();
});

test('a waiting request claimed before reload stays silent after reload', async () => {
  const claimed = new Set<string>();
  const claim = async (eventId: string): Promise<boolean> => {
    if (claimed.has(eventId)) return false;
    claimed.add(eventId);
    return true;
  };

  const first = harness({ claim });
  await first.ui.whenReady();
  first.emit(statusEvent(11, 'wait-reload', { status: 'waiting', previousStatus: 'idle' }));
  await first.ui.flush();
  assert.deepEqual(first.calls.sounds, ['waiting']);
  first.ui.dispose();

  const second = harness({ claim });
  await second.ui.whenReady();
  second.emit(statusEvent(11, 'wait-reload', { status: 'waiting', previousStatus: 'idle' }));
  await second.ui.flush();
  assert.equal(second.calls.claims.length, 1);
  assert.deepEqual(second.calls.sounds, []);
  assert.equal(second.calls.inApp.length, 0);
  second.ui.dispose();
});

test('a new logical waiting request notifies while the same question stays silent', async () => {
  const h = harness();
  await h.ui.whenReady();
  h.emit(statusEvent(11, 'local|thread-1|turn-1|waiting|req-1', {
    status: 'waiting',
    previousStatus: 'idle',
  }));
  h.emit(statusEvent(12, 'local|thread-1|turn-1|waiting|req-1', {
    status: 'waiting',
    previousStatus: 'idle',
  }));
  await h.ui.flush();
  assert.deepEqual(h.calls.claims, ['local|thread-1|turn-1|waiting|req-1']);
  assert.deepEqual(h.calls.sounds, ['waiting']);

  h.emit(statusEvent(13, 'local|thread-2|turn-2|waiting|req-2', {
    panelId: 'panel-2',
    threadId: 'thread-2',
    status: 'waiting',
    previousStatus: 'idle',
  }));
  await h.ui.flush();
  assert.deepEqual(h.calls.claims, [
    'local|thread-1|turn-1|waiting|req-1',
    'local|thread-2|turn-2|waiting|req-2',
  ]);
  assert.deepEqual(h.calls.sounds, ['waiting', 'waiting']);
  assert.equal(h.calls.inApp.length, 2);
  h.ui.dispose();
});

test('onStatusEvent receives accepted current events even when notifications are not eligible', async () => {
  const h = harness();
  await h.ui.whenReady();
  h.emit(statusEvent(11, 'running-1', { status: 'running', previousStatus: 'idle' }));
  await h.ui.flush();

  assert.equal(h.calls.claims.length, 0);
  assert.deepEqual(h.calls.sounds, []);
  assert.deepEqual(h.calls.statusEvents.map(event => event.eventId), ['running-1']);
  assert.equal(h.calls.statusEvents[0]!.tab.status, 'running');

  h.emit(statusEvent(10, 'running-stale', { status: 'running', previousStatus: 'idle' }));
  h.emit(statusEvent(12, 'running-snapshot', {
    live: false,
    status: 'running',
    previousStatus: 'idle',
  }));
  h.emit({
    ...statusEvent(13, 'running-invalid', { status: 'running', previousStatus: 'idle' }),
    live: 'yes',
  });
  await h.ui.flush();
  assert.deepEqual(
    h.calls.statusEvents.map(event => event.eventId),
    ['running-1', 'running-snapshot']
  );
  assert.deepEqual(h.calls.claims, []);
  assert.deepEqual(h.calls.sounds, []);
  h.ui.dispose();
});

test('repeated running identity refreshes attention after an answer without repeating notices', async () => {
  const h = harness();
  await h.ui.whenReady();
  h.emit(statusEvent(11, 'local|thread-1|turn-1|running', {
    status: 'running', previousStatus: 'idle',
  }));
  h.emit(statusEvent(12, 'local|thread-1|turn-1|waiting|question-1', {
    status: 'waiting', previousStatus: 'running',
  }));
  h.emit(statusEvent(13, 'local|thread-1|turn-1|running', {
    status: 'running', previousStatus: 'waiting',
  }));
  await h.ui.flush();
  assert.deepEqual(h.calls.statusEvents.map(event => event.tab.status), ['running', 'waiting', 'running']);
  assert.deepEqual(h.calls.claims, ['local|thread-1|turn-1|waiting|question-1']);
  assert.deepEqual(h.calls.sounds, ['waiting']);
  h.ui.dispose();
});

test('onStatusEvent errors are isolated and do not block waiting notification or exact focus', async () => {
  const failure = new Error('attention update failed');
  const h = harness({
    focused: false,
    nativeResult: true,
    onStatusEvent: () => {
      throw failure;
    },
  });
  await h.ui.whenReady();
  h.emit(statusEvent(11, 'wait-callback-error', { status: 'waiting', previousStatus: 'idle' }));
  await h.ui.flush();

  assert.deepEqual(h.calls.claims, ['wait-callback-error']);
  assert.deepEqual(h.calls.sounds, ['waiting']);
  assert.equal(h.calls.native.length, 1);
  assert.deepEqual(h.calls.errors, [failure]);
  const focusTab = h.calls.commands.find(call => call.command === BRIDGE_FOCUS_TAB_COMMAND);
  assert.ok(focusTab);
  assert.deepEqual(focusTab.args[0], { panelId: 'panel-1', threadId: 'thread-1' });
  assert.equal(h.calls.commands.some(call => call.command === FOCUS_WINDOW_COMMAND), true);
  h.ui.dispose();
});

test('malformed UI inputs are ignored without throwing', async () => {
  const h = harness();
  await h.ui.whenReady();
  for (const value of [
    undefined,
    null,
    'text',
    42,
    [],
    {},
    { ...statusEvent(11, 'bad-tab'), tab: null },
    { ...statusEvent(12, 'bad-seq'), sequence: Number.NaN },
    { ...statusEvent(13, 'bad-live'), live: 'yes' },
    { ...statusEvent(14, 'bad-event'), eventId: '' },
    { ...statusEvent(15, 'bad-previous'), previousStatus: 'cancelled' },
  ]) {
    h.emit(value);
  }
  await h.ui.flush();
  assert.equal(h.calls.claims.length, 0);
  assert.deepEqual(h.calls.sounds, []);
  assert.equal(h.calls.inApp.length, 0);
  assert.deepEqual(h.calls.errors, []);
  h.ui.dispose();
});

test('a pre-handshake event is buffered and processed once the bridge is ready', async () => {
  const h = harness();
  h.emit(statusEvent(11, 'early'));
  await settle(h.ui);
  assert.deepEqual(h.calls.claims, ['early']);
  assert.deepEqual(h.calls.sounds, ['done']);
  h.ui.dispose();
});

test('local, compatibility and bridge gates suppress transition handling', async () => {
  const remote = harness({ local: false });
  await remote.ui.whenReady();
  remote.emit(statusEvent(11, 'remote'));
  await remote.ui.flush();
  assert.equal(remote.calls.claims.length, 0);
  assert.equal(remote.calls.statusEvents.length, 0);
  remote.ui.dispose();

  const incompatible = harness({ compatible: false });
  await incompatible.ui.whenReady();
  incompatible.emit(statusEvent(11, 'incompatible'));
  await incompatible.ui.flush();
  assert.equal(incompatible.calls.claims.length, 0);
  assert.equal(incompatible.calls.statusEvents.length, 0);
  incompatible.ui.dispose();

  const noBridge = harness({ handshake: false });
  await noBridge.ui.whenReady();
  noBridge.emit(statusEvent(11, 'no-bridge'));
  await noBridge.ui.flush();
  assert.equal(noBridge.ui.bridgeState(), 'absent');
  assert.equal(noBridge.calls.claims.length, 0);
  assert.equal(noBridge.calls.statusEvents.length, 0);
  noBridge.ui.dispose();
});

test('events buffered while compatibility settles are delivered after it becomes ready', async () => {
  const h = harness({ compatible: false });
  await h.ui.whenReady();
  h.emit(statusEvent(11, 'settling'));
  await h.ui.flush();
  assert.equal(h.calls.claims.length, 0);

  h.ui.setCompatibilityGate(() => true);
  await h.ui.flush();
  assert.deepEqual(h.calls.claims, ['settling']);
  assert.deepEqual(h.calls.sounds, ['done']);
  h.ui.dispose();
});

test('native activation focuses the exact existing tab through the official bridge', async () => {
  const h = harness({ focused: false, nativeResult: true });
  await h.ui.whenReady();
  h.emit(statusEvent(11, 'focused'));
  await h.ui.flush();

  assert.equal(h.calls.native.length, 1);
  assert.deepEqual(h.calls.sounds, ['done']);
  const focusTab = h.calls.commands.find(call => call.command === BRIDGE_FOCUS_TAB_COMMAND);
  assert.ok(focusTab);
  assert.deepEqual(focusTab.args[0], { panelId: 'panel-1', threadId: 'thread-1' });
  assert.equal(h.calls.commands.some(call => call.command === FOCUS_WINDOW_COMMAND), true);
  h.ui.dispose();
});

test('without focusTab only one exact currently open official tab is revealed', async () => {
  const openTab: OfficialOpenTab = { uri: 'openai-codex://route/local/thread-1', column: 1, threadId: 'thread-1' };
  const h = harness({
    focused: false,
    nativeResult: true,
    commands: [BRIDGE_GET_STATE_COMMAND, FOCUS_WINDOW_COMMAND],
    openTabs: [openTab],
  });
  await h.ui.whenReady();
  h.emit(statusEvent(11, 'fallback'));
  await h.ui.flush();
  assert.deepEqual(h.calls.revealed, [{ uri: openTab.uri, column: 1 }]);
  h.ui.dispose();
});

test('dispose cancels a pending handshake and suppresses later transitions', async () => {
  const h = harness();
  h.ui.dispose();
  h.emit(statusEvent(11, 'after-dispose'));
  await settle(h.ui);
  assert.equal(h.calls.claims.length, 0);
  assert.equal(h.registrationDisposed(), true);
});

const VERSION = '26.1007.21434';
const FILES = [
  'package.json',
  'out/extension.js',
  'webview/assets/app-initial-97d3534ad35f.js',
  'webview/assets/app-initial-c014f9ee4429.js',
] as const;

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function officialFiles(): Record<string, string> {
  return {
    'package.json': JSON.stringify({ publisher: 'openai', name: 'chatgpt', version: VERSION }),
    'out/extension.js': 'official bundle',
    'webview/assets/app-initial-97d3534ad35f.js': 'webview one',
    'webview/assets/app-initial-c014f9ee4429.js': 'webview two',
  };
}

function attestation(files: Record<string, string>, version = VERSION) {
  return {
    schema: 1,
    officialVersion: version,
    features: ['history', 'tab-titles'],
    files: Object.fromEntries(FILES.map(file => [file, sha256(files[file] ?? '')])),
  };
}

async function fixture(t: TestContext, files: Record<string, string>): Promise<string> {
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, 'compat-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const target = join(directory, ...name.split('/'));
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content);
  }
  return directory;
}

async function snapshot(directory: string): Promise<Record<string, string>> {
  const entries = await readdir(directory, { recursive: true });
  const result: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.endsWith('package.json') || entry.endsWith('.js')) {
      result[entry] = await readFile(join(directory, entry), 'utf8');
    }
  }
  return result;
}

interface CompatHarnessOptions {
  bridge: 'ready' | 'absent' | 'unknown';
  officialVersion?: string;
  noticeChoice?: string;
  noticeResponse?: () => Promise<string | undefined>;
  readAttestation?: () => Promise<unknown>;
  hasOfficialTabs?: boolean;
}

function compatibilityHarness(extensionPath: string, officialPath: string, options: CompatHarnessOptions) {
  const warnings: Array<{ message: string; actions: string[] }> = [];
  const reports: Array<{ title: string; content: string }> = [];
  const store = new Map<string, unknown>();
  let shown = 0;
  let hidden = 0;
  let scheduled: (() => void) | undefined;
  const item: CompatibilityStatusItem = {
    text: '',
    tooltip: undefined,
    command: undefined,
    show: () => {
      shown += 1;
    },
    hide: () => {
      hidden += 1;
    },
    dispose: () => undefined,
  };
  const dependencies: CompatibilityUiDependencies = {
    extensionPath,
    officialExtensionPath: () => officialPath,
    bridgeState: () => options.bridge,
    hasOfficialTabs: () => options.hasOfficialTabs ?? true,
    globalState: {
      get<T>(key: string, defaultValue: T): T {
        return (store.has(key) ? store.get(key) as T : defaultValue);
      },
      update(key, value) {
        store.set(key, value);
        return Promise.resolve();
      },
    },
    showWarning: async (message, ...actions) => {
      warnings.push({ message, actions });
      return options.noticeResponse ? options.noticeResponse() : options.noticeChoice;
    },
    openReport: async (title, content) => {
      reports.push({ title, content });
    },
    readAttestation: options.readAttestation,
    officialVersion: () => options.officialVersion ?? VERSION,
    statusItem: item,
    schedule: handler => {
      scheduled = handler;
      return { dispose: () => { scheduled = undefined; } };
    },
  };
  return {
    ui: new PatchCompatibilityUi(dependencies, false),
    warnings,
    reports,
    store,
    shown: () => shown,
    hidden: () => hidden,
    runScheduled: () => scheduled?.(),
  };
}

test('compatibility warning is shown once per version/state and never mutates official files', async t => {
  const officialPath = await fixture(t, officialFiles());
  const extensionPath = await fixture(t, {});
  await mkdir(join(extensionPath, 'resources'), { recursive: true });
  await writeFile(
    join(extensionPath, 'resources', 'patchAttestation.json'),
    JSON.stringify(attestation(officialFiles())),
  );
  const before = await snapshot(officialPath);
  const h = compatibilityHarness(extensionPath, officialPath, { bridge: 'ready' });
  const first = await h.ui.check(true);
  await h.ui.check(true);

  assert.equal(first?.kind, 'ready');
  assert.equal(first?.notificationsAllowed, true);
  assert.equal(h.warnings.length, 0);
  assert.deepEqual(await snapshot(officialPath), before);
  h.ui.dispose();
});

test('an unknown official version is warned once, offers details and applies nothing', async t => {
  const files = officialFiles();
  files['package.json'] = JSON.stringify({ publisher: 'openai', name: 'chatgpt', version: '26.2000.1' });
  const officialPath = await fixture(t, files);
  const extensionPath = await fixture(t, {});
  await mkdir(join(extensionPath, 'resources'), { recursive: true });
  await writeFile(
    join(extensionPath, 'resources', 'patchAttestation.json'),
    JSON.stringify(attestation(officialFiles())),
  );
  const before = await snapshot(officialPath);
  const h = compatibilityHarness(extensionPath, officialPath, {
    bridge: 'ready',
    noticeChoice: 'Details',
  });
  const first = await h.ui.check(true);
  await h.ui.check(true);

  assert.equal(first?.kind, 'incompatible');
  assert.equal(first?.notificationsAllowed, false);
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0]!.message, /26\.2000\.1/);
  assert.deepEqual(h.warnings[0]!.actions, ['Details']);
  assert.equal(h.reports.length, 1);
  assert.match(h.reports[0]!.content, /No changes were applied/);
  assert.ok(h.store.has(PATCH_NOTICE_KEY));
  assert.ok(h.shown() >= 1);
  assert.deepEqual(await snapshot(officialPath), before);
  h.ui.dispose();
});

test('a missing patch set warns visibly without enabling notifications', async t => {
  const officialPath = await fixture(t, officialFiles());
  const extensionPath = await fixture(t, {});
  const h = compatibilityHarness(extensionPath, officialPath, { bridge: 'ready' });
  const status = await h.ui.check(true);

  assert.equal(status?.kind, 'incompatible');
  assert.equal(status?.notificationsAllowed, false);
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0]!.message, /compatibility is not verified/i);
  h.ui.dispose();
});

test('good disk hashes with an absent bridge are pending-reload, not ready', async t => {
  const officialPath = await fixture(t, officialFiles());
  const extensionPath = await fixture(t, {});
  await mkdir(join(extensionPath, 'resources'), { recursive: true });
  await writeFile(
    join(extensionPath, 'resources', 'patchAttestation.json'),
    JSON.stringify(attestation(officialFiles())),
  );
  const h = compatibilityHarness(extensionPath, officialPath, { bridge: 'absent' });
  const status = await h.ui.check(true);

  assert.equal(status?.kind, 'pending-reload');
  assert.equal(status?.runtimeReady, false);
  assert.equal(status?.notificationsAllowed, false);
  assert.match(status?.summary ?? '', /Reload the window after running tasks finish/);
  assert.equal(h.warnings.length, 1);
  h.ui.dispose();
});

test('changed bundle bytes invalidate cached compatibility without a package version change', async t => {
  const files = officialFiles();
  const officialPath = await fixture(t, files);
  const extensionPath = await fixture(t, {});
  await mkdir(join(extensionPath, 'resources'), { recursive: true });
  await writeFile(join(extensionPath, 'resources', 'patchAttestation.json'), JSON.stringify(attestation(files)));
  const h = compatibilityHarness(extensionPath, officialPath, { bridge: 'ready' });
  assert.equal((await h.ui.check(true))?.kind, 'ready');
  await writeFile(join(officialPath, 'out', 'extension.js'), 'replaced by an unpatched bundle');
  const changed = await h.ui.check(false);
  assert.equal(changed?.kind, 'incompatible');
  assert.equal(changed?.notificationsAllowed, false);
  assert.equal(await readFile(join(officialPath, 'out', 'extension.js'), 'utf8'), 'replaced by an unpatched bundle');
  h.ui.dispose();
});

test('an undismissed warning does not block a later ready compatibility result', { timeout: 3000 }, async t => {
  const files = officialFiles();
  const officialPath = await fixture(t, files);
  const extensionPath = await fixture(t, {});
  await mkdir(join(extensionPath, 'resources'), { recursive: true });
  await writeFile(join(extensionPath, 'resources', 'patchAttestation.json'), JSON.stringify(attestation(files)));
  let dismiss: ((choice: string | undefined) => void) | undefined;
  const options: CompatHarnessOptions = {
    bridge: 'absent',
    noticeResponse: () => new Promise(resolve => { dismiss = resolve; }),
  };
  const h = compatibilityHarness(extensionPath, officialPath, options);
  try {
    assert.equal((await h.ui.check(true))?.kind, 'pending-reload');
    options.bridge = 'ready';
    const next = await h.ui.check(false);
    assert.equal(next?.kind, 'ready');
    assert.equal(next?.notificationsAllowed, true);
  } finally {
    dismiss?.(undefined);
    h.ui.dispose();
  }
});

test('dispose stops scheduled compatibility checks and UI side effects', async t => {
  const officialPath = await fixture(t, officialFiles());
  const extensionPath = await fixture(t, {});
  const h = compatibilityHarness(extensionPath, officialPath, { bridge: 'ready' });
  await h.ui.check(true);
  const warnings = h.warnings.length;
  h.ui.dispose();
  h.runScheduled();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(h.warnings.length, warnings);
});
