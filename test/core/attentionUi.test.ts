import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setImmediate as waitImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import {
  AttentionUi,
  NEXT_ATTENTION_CHAT_COMMAND,
  NEXT_WAITING_CHAT_COMMAND,
  type AttentionFocusPayload,
  type AttentionStatusItem,
  type AttentionUiDependencies,
  type DisposableLike,
} from '../../src/attentionUi';
import type { OpenChatStatus } from '../../src/openChatsModel';

function rawTab(
  panelId: string,
  status: OpenChatStatus = 'idle',
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    panelId,
    threadId: `thread-${panelId}`,
    hostId: 'local',
    route: `/local/${panelId}`,
    title: `Chat ${panelId}`,
    status,
    updatedAt: 1,
    ...overrides,
  };
}

function bridge(
  sequence = 1,
  instanceId = 'instance-a',
  tabs: readonly unknown[] = [],
): Record<string, unknown> {
  return {
    apiVersion: 1,
    instanceId,
    sequence,
    capabilities: { statuses: true },
    tabs,
  };
}

class FakeStatusItem implements AttentionStatusItem {
  text = '';
  tooltip: unknown = '';
  command: unknown;
  visible = false;
  disposed = false;
  shows = 0;
  hides = 0;

  show(): void {
    this.visible = true;
    this.shows++;
  }

  hide(): void {
    this.visible = false;
    this.hides++;
  }

  dispose(): void {
    this.disposed = true;
  }
}

function subscription(dispose: () => void): DisposableLike {
  return { dispose };
}

interface HarnessOptions {
  ru?: boolean;
  allowed?: boolean;
  getState?: () => Promise<unknown>;
  focus?: (payload: AttentionFocusPayload) => Promise<unknown>;
}

function harness(options: HarnessOptions = {}) {
  const item = new FakeStatusItem();
  const calls = {
    getState: 0,
    focus: [] as AttentionFocusPayload[],
    warnings: [] as string[],
    errors: [] as string[],
    registered: [] as string[],
    tabSubscriptions: 0,
    disposals: 0,
  };
  const tabListeners = new Set<() => void>();
  const handlers = new Map<string, () => unknown>();
  let allowed = options.allowed ?? true;
  let getStateImpl = options.getState ?? (async () => bridge(1, 'instance-a', []));
  const focusImpl: (payload: AttentionFocusPayload) => Promise<unknown> =
    options.focus ?? (async () => true);
  let activeRequests = 0;
  let maxActiveRequests = 0;

  const deps: AttentionUiDependencies = {
    allowed: () => allowed,
    getState: async () => {
      calls.getState++;
      activeRequests++;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      try {
        return await getStateImpl();
      } finally {
        activeRequests--;
      }
    },
    focusTab: async payload => {
      calls.focus.push(payload);
      return focusImpl(payload);
    },
    createStatusItem: () => item,
    onDidChangeTabs: listener => {
      calls.tabSubscriptions++;
      tabListeners.add(listener);
      return subscription(() => {
        calls.disposals++;
        tabListeners.delete(listener);
      });
    },
    registerCommand: (command, handler) => {
      calls.registered.push(command);
      handlers.set(command, handler);
      return subscription(() => {
        calls.disposals++;
        handlers.delete(command);
      });
    },
    showWarning: message => calls.warnings.push(message),
    showError: message => calls.errors.push(message),
    onError: () => undefined,
  };
  const ui = new AttentionUi(deps, options.ru ?? false);
  return {
    ui,
    item,
    calls,
    maxActiveRequests: () => maxActiveRequests,
    setAllowed: (value: boolean) => { allowed = value; },
    setGetState: (value: () => Promise<unknown>) => { getStateImpl = value; },
    fireTabs: () => {
      for (const listener of [...tabListeners]) listener();
    },
  };
}

async function settle(): Promise<void> {
  await waitImmediate();
  await waitImmediate();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await waitImmediate();
  }
  assert.fail('condition was not reached');
}

test('counter shows only waiting chats and hides when empty, gated, failed or malformed', async () => {
  const h = harness({
    getState: async () => bridge(1, 'instance-a', [
      rawTab('wait-1', 'waiting'),
      rawTab('wait-2', 'waiting'),
      rawTab('error-1', 'error'),
      rawTab('run-1', 'running'),
      rawTab('idle-1', 'idle'),
    ]),
  });
  await h.ui.refresh();
  assert.equal(h.item.visible, true);
  assert.equal(h.item.text, '[? 2]');
  assert.equal(h.item.command, NEXT_WAITING_CHAT_COMMAND);
  const tooltip = String(h.item.tooltip);
  assert.match(tooltip, /Waiting: 2/);
  assert.match(tooltip, /Errors: 1/);
  assert.match(tooltip, /Running: 1/);

  h.setGetState(async () => bridge(2, 'instance-a', [
    rawTab('error-1', 'error'),
    rawTab('run-1', 'running'),
  ]));
  await h.ui.refresh();
  assert.equal(h.item.visible, false);

  h.setGetState(async () => bridge(3, 'instance-a', [rawTab('wait-1', 'waiting')]));
  h.setAllowed(false);
  const beforeGate = h.calls.getState;
  await h.ui.refresh();
  assert.equal(h.calls.getState, beforeGate);
  assert.equal(h.item.visible, false);

  h.setAllowed(true);
  await h.ui.refresh();
  assert.equal(h.item.visible, true);

  h.setGetState(async () => { throw new Error('bridge unavailable'); });
  await h.ui.refresh();
  assert.equal(h.item.visible, false);

  h.setGetState(async () => ({ apiVersion: 2, instanceId: 'instance-a', sequence: 4, tabs: [] }));
  await h.ui.refresh();
  assert.equal(h.item.visible, false);
  h.ui.dispose();
});

test('counter tooltip and command labels are localized', async () => {
  const h = harness({
    ru: true,
    getState: async () => bridge(1, 'instance-a', [
      rawTab('wait-1', 'waiting'),
      rawTab('error-1', 'error'),
      rawTab('run-1', 'running'),
    ]),
  });
  await h.ui.refresh();
  assert.equal(h.item.text, '[? 1]');
  const tooltip = String(h.item.tooltip);
  assert.match(tooltip, /Ожидают: 1/);
  assert.match(tooltip, /Ошибки: 1/);
  assert.match(tooltip, /Выполняются: 1/);
  h.ui.dispose();
});

test('nextWaitingChat cycles current waiting chats deterministically and wraps', async () => {
  const h = harness({
    getState: async () => bridge(7, 'instance-a', [
      rawTab('error-1', 'error'),
      rawTab('wait-1', 'waiting'),
      rawTab('wait-2', 'waiting'),
      rawTab('wait-3', 'waiting', { threadId: null, route: null }),
    ]),
  });
  await h.ui.nextWaiting();
  await h.ui.nextWaiting();
  await h.ui.nextWaiting();
  await h.ui.nextWaiting();
  assert.deepEqual(h.calls.focus, [
    { panelId: 'wait-1', threadId: 'thread-wait-1' },
    { panelId: 'wait-2', threadId: 'thread-wait-2' },
    { panelId: 'wait-3' },
    { panelId: 'wait-1', threadId: 'thread-wait-1' },
  ]);
  assert.deepEqual(h.calls.registered, [NEXT_WAITING_CHAT_COMMAND, NEXT_ATTENTION_CHAT_COMMAND]);
  assert.equal(h.calls.errors.length, 0);
  h.ui.dispose();
});

test('nextAttentionChat visits waiting chats before errors and cycles both groups', async () => {
  const h = harness({
    getState: async () => bridge(8, 'instance-a', [
      rawTab('error-2', 'error'),
      rawTab('wait-2', 'waiting'),
      rawTab('run-1', 'running'),
      rawTab('error-1', 'error'),
      rawTab('wait-1', 'waiting'),
    ]),
  });
  for (let index = 0; index < 5; index++) await h.ui.nextAttention();
  assert.deepEqual(h.calls.focus.map(payload => payload.panelId), [
    'wait-2', 'wait-1', 'error-2', 'error-1', 'wait-2',
  ]);
  assert.equal(h.calls.errors.length, 0);
  h.ui.dispose();
});

test('removed tabs and changed instance, thread, route or status are never focused', async () => {
  const first = bridge(5, 'instance-a', [rawTab('wait-1', 'waiting')]);
  const cases: { name: string; second: Record<string, unknown> }[] = [
    { name: 'removed', second: bridge(5, 'instance-a', []) },
    {
      name: 'thread',
      second: bridge(5, 'instance-a', [rawTab('wait-1', 'waiting', { threadId: 'thread-other' })]),
    },
    {
      name: 'route',
      second: bridge(5, 'instance-a', [rawTab('wait-1', 'waiting', { route: '/local/other' })]),
    },
    { name: 'instance', second: bridge(5, 'instance-b', [rawTab('wait-1', 'waiting')]) },
    { name: 'stale', second: bridge(4, 'instance-a', [rawTab('wait-1', 'waiting')]) },
    { name: 'status', second: bridge(5, 'instance-a', [rawTab('wait-1', 'running')]) },
  ];
  for (const item of cases) {
    let reads = 0;
    const h = harness({
      getState: async () => {
        reads++;
        return reads === 1 ? first : item.second;
      },
    });
    await h.ui.nextWaiting();
    assert.deepEqual(h.calls.focus, [], item.name);
    assert.equal(h.calls.warnings.length, 1, item.name);
    assert.match(h.calls.warnings[0]!, /changed|closed/i, item.name);
    assert.equal(h.calls.errors.length, 0, item.name);
    h.ui.dispose();
  }
});

test('malformed and foreign snapshots hide the counter and perform no focus', async () => {
  const h = harness({
    getState: async () => ({ apiVersion: 2, instanceId: 'instance-a', sequence: 1, tabs: [] }),
  });
  await h.ui.refresh();
  assert.equal(h.item.visible, false);
  await h.ui.nextWaiting();
  assert.deepEqual(h.calls.focus, []);
  assert.equal(h.calls.warnings.length, 1);
  assert.match(h.calls.warnings[0]!, /metadata/i);

  h.setGetState(async () => bridge(2, 'instance-a', [
    rawTab('remote-1', 'waiting', { hostId: 'remote' }),
  ]));
  await h.ui.refresh();
  assert.equal(h.item.visible, false);
  await h.ui.nextWaiting();
  assert.deepEqual(h.calls.focus, []);
  assert.match(h.calls.warnings.at(-1)!, /no chats waiting/i);
  h.ui.dispose();
});

test('commands are gated and overlapping runs are ignored', async () => {
  const resolvers: ((value: unknown) => void)[] = [];
  const h = harness({
    getState: () => new Promise(resolve => { resolvers.push(resolve); }),
  });
  const first = h.ui.nextWaiting();
  await waitFor(() => h.calls.getState === 1);
  await h.ui.nextWaiting();
  assert.equal(h.calls.getState, 1);

  resolvers[0]?.(bridge(1, 'instance-a', [rawTab('wait-1', 'waiting')]));
  await waitFor(() => h.calls.getState === 2);
  h.setAllowed(false);
  resolvers[1]?.(bridge(1, 'instance-a', [rawTab('wait-1', 'waiting')]));
  await first;
  assert.deepEqual(h.calls.focus, []);
  assert.equal(h.calls.errors.length, 1);
  assert.match(h.calls.errors[0]!, /unavailable/i);
  assert.equal(h.item.visible, false);
  h.ui.dispose();

  const gated = harness({ allowed: false });
  await gated.ui.refresh();
  assert.equal(gated.calls.getState, 0);
  assert.equal(gated.item.visible, false);
  await gated.ui.nextWaiting();
  assert.equal(gated.calls.getState, 0);
  assert.deepEqual(gated.calls.focus, []);
  assert.match(gated.calls.errors[0]!, /unavailable/i);
  gated.ui.dispose();
});

test('a refused focus is reported and never falls through to another chat', async () => {
  const h = harness({
    getState: async () => bridge(1, 'instance-a', [
      rawTab('wait-1', 'waiting'),
      rawTab('wait-2', 'waiting'),
    ]),
    focus: async () => false,
  });
  await h.ui.nextWaiting();
  assert.deepEqual(h.calls.focus, [{ panelId: 'wait-1', threadId: 'thread-wait-1' }]);
  assert.equal(h.calls.warnings.length, 1);
  assert.match(h.calls.warnings[0]!, /closed/i);
  h.ui.dispose();
});

test('refresh coalesces overlapping tab, event and compatibility triggers', async () => {
  const resolvers: ((value: unknown) => void)[] = [];
  const h = harness({
    getState: () => new Promise(resolve => { resolvers.push(resolve); }),
  });
  const first = h.ui.refresh();
  await waitFor(() => h.calls.getState === 1);
  void h.ui.refresh();
  void h.ui.refresh();
  h.fireTabs();
  assert.equal(h.calls.getState, 1);
  assert.equal(h.calls.tabSubscriptions, 1);

  resolvers[0]?.(bridge(1, 'instance-a', [rawTab('wait-1', 'waiting')]));
  await waitFor(() => h.calls.getState === 2);
  assert.equal(h.maxActiveRequests(), 1);
  resolvers[1]?.(bridge(2, 'instance-a', [rawTab('wait-1', 'waiting')]));
  await first;
  await waitFor(() => h.item.visible);
  await settle();
  assert.equal(h.calls.getState, 2);
  assert.equal(h.maxActiveRequests(), 1);
  h.ui.dispose();
});

test('disposed controllers ignore late metadata and remove subscriptions', async () => {
  let resolveState: ((value: unknown) => void) | undefined;
  const h = harness({
    getState: () => new Promise(resolve => { resolveState = resolve; }),
  });
  const pending = h.ui.refresh();
  await waitFor(() => h.calls.getState === 1);
  h.ui.dispose();
  assert.equal(h.item.disposed, true);
  assert.equal(h.item.visible, false);
  assert.ok(h.calls.disposals >= 3);

  resolveState?.(bridge(1, 'instance-a', [rawTab('wait-1', 'waiting')]));
  await pending;
  await settle();
  assert.equal(h.item.visible, false);

  const before = h.calls.getState;
  h.fireTabs();
  await settle();
  assert.equal(h.calls.getState, before);
  await h.ui.nextWaiting();
  assert.equal(h.calls.getState, before);
  assert.deepEqual(h.calls.focus, []);
});

test('tab changes recount after native panel disposal and coalesce bursts', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let tabs = [rawTab('closing', 'waiting')];
  const h = harness({ getState: async () => bridge(1, 'instance-a', tabs) });
  await h.ui.refresh();
  assert.equal(h.item.visible, true);
  const before = h.calls.getState;
  h.fireTabs();
  h.fireTabs();
  assert.equal(h.calls.getState, before, 'tab event must allow the native disposal to finish');
  tabs = [];
  context.mock.timers.tick(100);
  await waitFor(() => !h.item.visible);
  assert.equal(h.calls.getState, before + 1);
  h.fireTabs();
  h.ui.dispose();
  context.mock.timers.tick(1000);
  await settle();
  assert.equal(h.calls.getState, before + 1, 'disposal cancels a scheduled tab recount');
});

test('package contributes both attention commands without default keybindings', () => {
  const root = resolve(__dirname, '../../..');
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    contributes?: {
      commands?: { command?: unknown }[];
      keybindings?: { command?: unknown }[];
    };
  };
  const commands = pkg.contributes?.commands ?? [];
  const ids = commands.map(command => String(command.command));
  assert.ok(ids.includes(NEXT_WAITING_CHAT_COMMAND));
  assert.ok(ids.includes(NEXT_ATTENTION_CHAT_COMMAND));
  const keybindings = pkg.contributes?.keybindings ?? [];
  const attentionIds: string[] = [NEXT_WAITING_CHAT_COMMAND, NEXT_ATTENTION_CHAT_COMMAND];
  assert.equal(keybindings.some(binding => attentionIds.includes(String(binding.command))), false);

  const en = JSON.parse(readFileSync(resolve(root, 'package.nls.json'), 'utf8')) as Record<string, unknown>;
  const ru = JSON.parse(readFileSync(resolve(root, 'package.nls.ru.json'), 'utf8')) as Record<string, unknown>;
  for (const key of ['nextWaitingChat', 'nextAttentionChat']) {
    assert.equal(typeof en[key], 'string');
    assert.equal(typeof ru[key], 'string');
  }
});
