import assert from 'node:assert/strict';
import { setImmediate as waitImmediate } from 'node:timers/promises';
import { test } from 'node:test';

import {
  buildOpenChatItems,
  isStaleSameInstance,
  parseOpenChatsState,
  type OpenChatItem,
  type OpenChatStatus,
  type OpenChatTab,
} from '../../src/openChatsModel';
import {
  OPEN_CHATS_COMMAND,
  OpenChatsUi,
  type DisposableLike,
  type OpenChatQuickPick,
  type OpenChatsTimer,
  type OpenChatsUiDependencies,
} from '../../src/openChatsUi';

interface RawTab {
  panelId?: unknown;
  threadId?: unknown;
  route?: unknown;
  title?: unknown;
  status?: unknown;
  hostId?: unknown;
  turnId?: unknown;
  updatedAt?: unknown;
}

function rawTab(overrides: RawTab = {}): Record<string, unknown> {
  return {
    panelId: 'panel-1',
    threadId: 'thread-1',
    hostId: 'local',
    route: '/local/thread-1',
    title: 'Chat',
    status: 'idle',
    turnId: null,
    updatedAt: 10,
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
    capabilities: { statuses: true, projectModel: true },
    tabs,
    projectModel: null,
  };
}

function chatTab(
  panelId: string,
  status: OpenChatStatus = 'idle',
  overrides: Partial<OpenChatTab> = {},
): OpenChatTab {
  return {
    panelId,
    threadId: `thread-${panelId}`,
    route: `/local/${panelId}`,
    title: `Chat ${panelId}`,
    status,
    updatedAt: 10,
    ...overrides,
  };
}

function subscription(remove: () => void): DisposableLike {
  return { dispose: remove };
}

class FakePicker implements OpenChatQuickPick {
  title = '';
  placeholder = '';
  matchOnDescription = true;
  matchOnDetail = true;
  busy = false;
  value = '';
  items: readonly OpenChatItem[] = [];
  activeItems: readonly OpenChatItem[] = [];
  disposed = false;
  shown = 0;
  hidden = 0;
  private readonly acceptListeners = new Set<() => void>();
  private readonly hideListeners = new Set<() => void>();

  onDidAccept(listener: () => void): DisposableLike {
    this.acceptListeners.add(listener);
    return subscription(() => this.acceptListeners.delete(listener));
  }

  onDidHide(listener: () => void): DisposableLike {
    this.hideListeners.add(listener);
    return subscription(() => this.hideListeners.delete(listener));
  }

  show(): void {
    this.shown++;
  }

  hide(): void {
    this.hidden++;
    for (const listener of [...this.hideListeners]) listener();
  }

  dispose(): void {
    this.disposed = true;
    this.acceptListeners.clear();
    this.hideListeners.clear();
  }

  pressEnter(): void {
    for (const listener of [...this.acceptListeners]) listener();
  }

  closeByUser(): void {
    this.hide();
  }
}

interface FakeTimer extends OpenChatsTimer {
  readonly setCalls: number;
  readonly clearCalls: number;
  fire(): void;
}

function fakeTimer(): FakeTimer {
  const handlers = new Map<number, () => void>();
  let nextHandle = 1;
  let setCalls = 0;
  let clearCalls = 0;
  return {
    get setCalls() { return setCalls; },
    get clearCalls() { return clearCalls; },
    set(handler: () => void, _timeout: number): unknown {
      setCalls++;
      const handle = nextHandle++;
      handlers.set(handle, handler);
      return handle;
    },
    clear(handle: unknown): void {
      clearCalls++;
      if (typeof handle === 'number') handlers.delete(handle);
    },
    fire(): void {
      for (const handler of [...handlers.values()]) handler();
    },
  };
}

interface Commands {
  getState: number;
  focus: { panelId: string; threadId?: string }[];
  errors: string[];
  warnings: string[];
  creates: number;
  tabSubscriptions: number;
  registered: string[];
}

interface HarnessOptions {
  ru?: boolean;
  allowed?: boolean;
  getState?: () => Promise<unknown>;
  focus?: (payload: { panelId: string; threadId?: string }) => Promise<unknown>;
  registerCommand?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const picker = new FakePicker();
  const timer = fakeTimer();
  const commands: Commands = {
    getState: 0,
    focus: [],
    errors: [],
    warnings: [],
    creates: 0,
    tabSubscriptions: 0,
    registered: [],
  };
  const tabListeners: (() => void)[] = [];
  let activeRequests = 0;
  let maxActiveRequests = 0;
  let commandHandler: (() => void) | undefined;
  let allowed = options.allowed ?? true;
  let getState = options.getState ?? (async () => bridge(1, 'instance-a', []));
  let focus = options.focus ?? (async (payload) => {
    commands.focus.push(payload);
    return true;
  });

  const deps: OpenChatsUiDependencies = {
    allowed: () => allowed,
    getState: async () => {
      commands.getState++;
      activeRequests++;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      try {
        return await getState();
      } finally {
        activeRequests--;
      }
    },
    focusTab: async payload => focus(payload),
    createQuickPick: () => {
      commands.creates++;
      return picker;
    },
    onDidChangeTabs: listener => {
      commands.tabSubscriptions++;
      tabListeners.push(listener);
      return subscription(() => {
        const index = tabListeners.indexOf(listener);
        if (index >= 0) tabListeners.splice(index, 1);
      });
    },
    showError: message => commands.errors.push(message),
    showWarning: message => commands.warnings.push(message),
    timer,
  };
  if (options.registerCommand) {
    deps.registerCommand = (command, handler) => {
      commands.registered.push(command);
      commandHandler = handler;
      return subscription(() => { commandHandler = undefined; });
    };
  }
  const ui = new OpenChatsUi(deps, options.ru ?? true);
  return {
    ui,
    picker,
    timer,
    commands,
    tabListeners,
    maxActiveRequests: () => maxActiveRequests,
    setAllowed: (value: boolean) => { allowed = value; },
    setGetState: (value: () => Promise<unknown>) => { getState = value; },
    setFocus: (value: (payload: { panelId: string; threadId?: string }) => Promise<unknown>) => {
      focus = value;
    },
    runCommand: () => commandHandler?.(),
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
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await waitImmediate();
  }
  assert.fail('condition was not reached');
}

test('parser keeps empty panels, drops foreign and malformed tabs, and dedups panel ids', () => {
  const parsed = parseOpenChatsState(bridge(3, 'instance-a', [
    rawTab({ panelId: 'empty', threadId: null, route: null, title: '', updatedAt: 1 }),
    rawTab({ panelId: 'empty', title: 'duplicate panel' }),
    rawTab({ panelId: 'foreign', hostId: 'remote' }),
    rawTab({ panelId: 'unknown-status', status: 'mystery' }),
    rawTab({ panelId: 'kept', title: 'Keep me' }),
  ]));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.snapshot.tabs.map(tab => tab.panelId), ['empty', 'kept']);
  assert.equal(parsed.snapshot.tabs[0]?.threadId, null);
  assert.equal(parsed.snapshot.tabs[0]?.route, null);
  assert.equal(parsed.snapshot.tabs[0]?.title, '');
  assert.equal(parsed.snapshot.tabs[1]?.title, 'Keep me');
});

test('parser rejects incompatible top-level payloads and never invents done state', () => {
  const cases: [unknown, string][] = [
    [null, 'schema'],
    [{ ...bridge(), apiVersion: 2 }, 'api-version'],
    [{ ...bridge(), instanceId: '' }, 'instance'],
    [{ ...bridge(), sequence: -1 }, 'sequence'],
    [{ ...bridge(), sequence: 1.5 }, 'sequence'],
    [{ ...bridge(), capabilities: { statuses: false } }, 'capabilities'],
    [{ ...bridge(), tabs: {} }, 'tabs'],
  ];
  for (const [value, reason] of cases) {
    const parsed = parseOpenChatsState(value);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(parsed.reason, reason);
  }
  const unknown = parseOpenChatsState(bridge(1, 'instance-a', [
    rawTab({ panelId: 'x', status: 'unknown' }),
  ]));
  assert.equal(unknown.ok, true);
  if (unknown.ok) assert.deepEqual(unknown.snapshot.tabs, []);
});

test('ordering prioritizes waiting and error and keeps native order without timestamps', () => {
  const snapshot = {
    instanceId: 'instance-a',
    sequence: 1,
    tabs: [
      chatTab('done', 'done'),
      chatTab('idle', 'idle'),
      chatTab('wait-1', 'waiting', { title: '', threadId: null, route: null, updatedAt: 9e15 }),
      chatTab('run-1', 'running'),
      chatTab('error', 'error'),
      chatTab('wait-2', 'waiting', { updatedAt: 1 }),
      chatTab('run-2', 'running'),
    ],
  };
  const items = buildOpenChatItems(snapshot, true);
  assert.deepEqual(items.map(item => item.panelId), [
    'wait-1', 'wait-2', 'error', 'run-1', 'run-2', 'idle', 'done',
  ]);
  assert.equal(items[0]?.description, 'Ожидает');
  assert.equal(items[2]?.description, 'Ошибка');
});

test('duplicate and empty titles get view numbers and expose no raw identifiers', () => {
  const snapshot = {
    instanceId: 'instance-a',
    sequence: 1,
    tabs: [
      chatTab('p-1', 'idle', { title: '  ', threadId: null, route: null }),
      chatTab('p-2', 'idle', { title: ' ', threadId: null, route: null }),
      chatTab('p-3', 'idle', { title: 'Fix build' }),
      chatTab('p-4', 'idle', { title: 'Fix build' }),
    ],
  };
  const items = buildOpenChatItems(snapshot, true);
  const labels = items.map(item => item.label);
  assert.deepEqual(labels, [
    'Новый чат (вид 1)',
    'Новый чат (вид 2)',
    'Fix build (вид 1)',
    'Fix build (вид 2)',
  ]);
  for (const item of items) {
    assert.equal(item.label.includes(item.panelId), false);
    assert.equal(item.description.includes(item.panelId), false);
    assert.equal(item.label.includes('thread-'), false);
  }
});

test('equal sequence is fresh while a lower same-instance sequence is stale', () => {
  assert.equal(isStaleSameInstance({ instanceId: 'a', sequence: 5 }, { instanceId: 'a', sequence: 5 }), false);
  assert.equal(isStaleSameInstance({ instanceId: 'a', sequence: 5 }, { instanceId: 'a', sequence: 4 }), true);
  assert.equal(isStaleSameInstance({ instanceId: 'a', sequence: 5 }, { instanceId: 'b', sequence: 0 }), false);
});

test('show reuses one picker and one tabs subscription', async () => {
  const h = harness({
    registerCommand: true,
    getState: async () => bridge(1, 'instance-a', [rawTab({ panelId: 'p1', title: 'One' })]),
  });
  await h.ui.show();
  await h.ui.show();
  assert.equal(h.commands.creates, 1);
  assert.equal(h.commands.tabSubscriptions, 1);
  assert.equal(h.picker.disposed, false);
  assert.deepEqual(h.commands.registered, [OPEN_CHATS_COMMAND]);
  assert.equal(h.picker.title, 'Открытые чаты текущего окна');
  assert.equal(h.picker.matchOnDescription, false);
  assert.equal(h.picker.matchOnDetail, false);
  h.runCommand();
  await settle();
  assert.equal(h.commands.creates, 1);
  h.ui.dispose();
  assert.equal(h.picker.disposed, true);
});

test('refresh preserves search text and the active panel while updating items in place', async () => {
  let current: unknown = bridge(5, 'instance-a', [
    rawTab({ panelId: 'p2', threadId: 't2', title: 'Other', status: 'waiting' }),
    rawTab({ panelId: 'p1', threadId: 't1', title: 'Fix build', status: 'running' }),
  ]);
  const h = harness({ getState: async () => current });
  await h.ui.show();
  const fix = h.picker.items.find(item => item.panelId === 'p1');
  assert.ok(fix);
  h.picker.value = 'Fix';
  h.picker.activeItems = [fix!];
  current = bridge(5, 'instance-a', [
    rawTab({ panelId: 'p2', threadId: 't2', title: 'Other renamed', status: 'waiting' }),
    rawTab({ panelId: 'p1', threadId: 't1', title: 'Fix build renamed', status: 'running' }),
  ]);
  h.fireTabs();
  await settle();
  assert.equal(h.picker.value, 'Fix');
  assert.equal(h.picker.activeItems[0]?.panelId, 'p1');
  assert.ok(h.picker.items.some(item => item.label === 'Fix build renamed'));
  h.ui.dispose();
});

test('equal sequence rename and close apply, lower sequence is ignored', async () => {
  let current: unknown = bridge(8, 'instance-a', [
    rawTab({ panelId: 'p1', title: 'Before' }),
    rawTab({ panelId: 'p2', title: 'Closed soon' }),
  ]);
  const h = harness({ getState: async () => current });
  await h.ui.show();
  assert.equal(h.picker.items.length, 2);
  current = bridge(8, 'instance-a', [rawTab({ panelId: 'p1', title: 'After' })]);
  h.fireTabs();
  await settle();
  assert.deepEqual(h.picker.items.map(item => item.panelId), ['p1']);
  assert.equal(h.picker.items[0]?.label, 'After');
  current = bridge(7, 'instance-a', [rawTab({ panelId: 'p3', title: 'Stale' })]);
  h.fireTabs();
  await settle();
  assert.deepEqual(h.picker.items.map(item => item.panelId), ['p1']);
  h.ui.dispose();
});

test('a disposed controller ignores a late getState response', async () => {
  let resolveState: ((value: unknown) => void) | undefined;
  const h = harness({
    getState: () => new Promise(resolve => { resolveState = resolve; }),
  });
  const showing = h.ui.show();
  await waitFor(() => h.commands.getState === 1);
  h.ui.dispose();
  resolveState?.(bridge(1, 'instance-a', [rawTab({ panelId: 'p1' })]));
  await showing;
  await settle();
  assert.equal(h.picker.items.length, 0);
  assert.deepEqual(h.commands.errors, []);
  assert.equal(h.picker.disposed, true);
});

test('selecting a closed panel gives a notice and performs zero focus calls', async () => {
  let current: unknown = bridge(9, 'instance-a', [
    rawTab({ panelId: 'p1', threadId: 't1', route: '/local/t1', title: 'Gone' }),
  ]);
  const h = harness({ getState: async () => current });
  await h.ui.show();
  const item = h.picker.items[0];
  assert.ok(item);
  h.picker.activeItems = [item!];
  current = bridge(9, 'instance-a', []);
  h.picker.pressEnter();
  await waitFor(() => h.commands.warnings.length > 0);
  assert.deepEqual(h.commands.focus, []);
  assert.equal(h.commands.warnings[0], 'Этот чат уже закрыт.');
  assert.equal(h.picker.disposed, true);
});

test('focus uses the exact panel id and only non-null thread ids', async () => {
  const h = harness({
    getState: async () => bridge(2, 'instance-a', [
      rawTab({ panelId: 'p1', threadId: 'shared', route: '/local/shared', title: 'View one' }),
      rawTab({ panelId: 'p2', threadId: 'shared', route: '/local/shared', title: 'View two' }),
      rawTab({ panelId: 'p3', threadId: null, route: null, title: 'New chat' }),
    ]),
  });
  await h.ui.show();
  const second = h.picker.items.find(item => item.panelId === 'p2');
  assert.ok(second);
  h.picker.activeItems = [second!];
  h.picker.pressEnter();
  await waitFor(() => h.commands.focus.length === 1);
  assert.deepEqual(h.commands.focus[0], { panelId: 'p2', threadId: 'shared' });
  h.ui.dispose();

  const empty = harness({
    getState: async () => bridge(2, 'instance-a', [
      rawTab({ panelId: 'empty', threadId: null, route: null, title: '' }),
    ]),
  });
  await empty.ui.show();
  const emptyItem = empty.picker.items[0];
  assert.ok(emptyItem);
  empty.picker.activeItems = [emptyItem!];
  empty.picker.pressEnter();
  await waitFor(() => empty.commands.focus.length === 1);
  assert.deepEqual(empty.commands.focus[0], { panelId: 'empty' });
  empty.ui.dispose();
});

test('a changed route or instance refuses focus instead of opening the wrong chat', async () => {
  let current: unknown = bridge(4, 'instance-a', [
    rawTab({ panelId: 'p1', threadId: 't1', route: '/local/t1', title: 'Target' }),
  ]);
  const h = harness({ getState: async () => current });
  await h.ui.show();
  const item = h.picker.items[0];
  assert.ok(item);
  h.picker.activeItems = [item!];
  current = bridge(4, 'instance-a', [
    rawTab({ panelId: 'p1', threadId: 't1', route: '/local/t2', title: 'Target' }),
  ]);
  h.picker.pressEnter();
  await waitFor(() => h.commands.warnings.length > 0);
  assert.deepEqual(h.commands.focus, []);
  assert.match(h.commands.warnings[0] ?? '', /изменился|переназначен/);

  const moved = harness({
    getState: async () => bridge(4, 'instance-b', [
      rawTab({ panelId: 'p1', threadId: 't1', route: '/local/t1', title: 'Target' }),
    ]),
  });
  await moved.ui.show();
  // Seed the picker from instance-a, then verify against instance-b.
  moved.setGetState(async () => bridge(0, 'instance-a', [
    rawTab({ panelId: 'p1', threadId: 't1', route: '/local/t1', title: 'Target' }),
  ]));
  await moved.ui.show();
  const movedItem = moved.picker.items[0];
  assert.ok(movedItem);
  moved.picker.activeItems = [movedItem!];
  moved.setGetState(async () => bridge(0, 'instance-b', [
    rawTab({ panelId: 'p1', threadId: 't1', route: '/local/t1', title: 'Target' }),
  ]));
  moved.picker.pressEnter();
  await waitFor(() => moved.commands.warnings.length > 0);
  assert.deepEqual(moved.commands.focus, []);
  moved.ui.dispose();
  h.ui.dispose();
});

test('polling has at most one request in flight, coalesces triggers, and stops on hide', async () => {
  const resolvers: ((value: unknown) => void)[] = [];
  const h = harness({
    getState: () => new Promise(resolve => { resolvers.push(resolve); }),
  });
  const showing = h.ui.show();
  await waitFor(() => h.commands.getState === 1);
  h.timer.fire();
  h.timer.fire();
  h.fireTabs();
  assert.equal(h.commands.getState, 1);
  assert.equal(h.maxActiveRequests(), 1);
  resolvers[0]?.(bridge(1, 'instance-a', [rawTab({ panelId: 'p1' })]));
  await waitFor(() => h.commands.getState === 2);
  assert.equal(h.maxActiveRequests(), 1);
  resolvers[1]?.(bridge(1, 'instance-a', [rawTab({ panelId: 'p1' })]));
  await showing;
  await settle();
  assert.equal(h.commands.getState, 2);
  h.picker.closeByUser();
  const afterHide = h.commands.getState;
  h.timer.fire();
  await settle();
  assert.equal(h.commands.getState, afterHide);
  assert.ok(h.timer.clearCalls >= 1);
  h.ui.dispose();
});

test('bridge errors produce one compatibility message and an informative empty picker', async () => {
  const h = harness({ getState: async () => { throw new Error('command missing'); } });
  await h.ui.show();
  assert.equal(h.picker.items.length, 0);
  assert.equal(h.commands.errors.length, 1);
  assert.match(h.commands.errors[0] ?? '', /Мост открытых чатов Codex недоступен/);
  assert.match(h.picker.placeholder ?? '', /Мост открытых чатов Codex недоступен/);
  assert.equal(h.picker.busy, false);
  h.timer.fire();
  await settle();
  assert.equal(h.commands.errors.length, 1);
  assert.deepEqual(h.commands.focus, []);
  h.ui.dispose();
});

test('a transient bridge error does not lower the last accepted sequence', async () => {
  const current: unknown = bridge(10, 'instance-a', [rawTab({ panelId: 'p1', title: 'Current' })]);
  const h = harness({ getState: async () => current });
  await h.ui.show();
  h.setGetState(async () => { throw new Error('temporary failure'); });
  h.fireTabs();
  await settle();
  assert.equal(h.picker.items.length, 0);
  assert.equal(h.commands.errors.length, 1);
  h.setGetState(async () => bridge(9, 'instance-a', [rawTab({ panelId: 'old', title: 'Old' })]));
  h.fireTabs();
  await settle();
  assert.equal(h.picker.items.length, 0);
  h.setGetState(async () => bridge(10, 'instance-a', [rawTab({ panelId: 'equal', title: 'Equal' })]));
  h.fireTabs();
  await settle();
  assert.deepEqual(h.picker.items.map(item => item.panelId), ['equal']);
  h.ui.dispose();
});

test('the allowed gate blocks the picker entirely', async () => {
  const h = harness({ allowed: false });
  await h.ui.show();
  assert.equal(h.commands.creates, 0);
  assert.equal(h.commands.getState, 0);
  assert.match(h.commands.errors[0] ?? '', /доверенный локальный проект/);
  h.ui.dispose();
});

test('focus verification cannot act after disposal or a compatibility gate change', async () => {
  for (const action of ['dispose', 'gate'] as const) {
    const snapshot = bridge(1, 'instance-a', [rawTab()]);
    const h = harness({getState:async()=>snapshot});
    await h.ui.show();
    let resolve!: (value: unknown)=>void;
    h.setGetState(()=>new Promise(done=>{resolve=done;}));
    h.picker.activeItems=[h.picker.items[0]!];
    h.picker.pressEnter();
    await waitFor(()=>h.commands.getState===2);
    if(action==='dispose')h.ui.dispose();else h.setAllowed(false);
    resolve(snapshot);await settle();
    assert.deepEqual(h.commands.focus,[],action);
    h.ui.dispose();
  }
});
