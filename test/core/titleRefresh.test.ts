import assert from 'node:assert/strict';
import Module from 'node:module';
import { after, test } from 'node:test';
import { VERIFIED_EDITOR_VERSION } from '../../src/officialCodex';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const OPEN_COMMAND = 'vscode.openWith';

class MockUri {
  constructor(
    public scheme: string,
    public authority: string,
    public path: string,
    public query = '',
    public fragment = '',
  ) {}

  with(change: { query?: string; fragment?: string }): MockUri {
    return new MockUri(
      this.scheme,
      this.authority,
      this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }

  toString(): string {
    return `${this.scheme}://${this.authority}${this.path}`
      + `${this.query ? `?${this.query}` : ''}${this.fragment ? `#${this.fragment}` : ''}`;
  }
}

class MockTabInputCustom {
  constructor(public uri: MockUri, public viewType = 'chatgpt.conversationEditor') {}
}

class MockTab {
  isDirty = false;

  constructor(public input: MockTabInputCustom, public label = 'Chat') {}

  get group(): { viewColumn: number } {
    return { viewColumn: 1 };
  }
}

interface ExtensionMock {
  packageJSON: { version?: string };
  activate(): Promise<void>;
}

const errors: string[] = [];
const warnings: string[] = [];
const infos: string[] = [];
const registered: { command: string; handler: () => unknown }[] = [];
const executed: { command: string; args: unknown[] }[] = [];
const closed: MockTab[] = [];
let tabs: MockTab[] = [];
let activeTab: MockTab | undefined;
let extension: ExtensionMock | undefined;
let trust = true;
let remote: string | undefined;
let openImpl: (uri: MockUri, viewType: string, options: unknown) => Promise<void>;
let closeImpl: (tab: MockTab) => Promise<boolean>;
let warningImpl: (items: string[]) => Promise<string | undefined>;

const vscodeMock = {
  commands: {
    registerCommand: (command: string, handler: () => unknown): { dispose(): void } => {
      registered.push({ command, handler });
      return { dispose() {} };
    },
    executeCommand: async (command: string, ...args: unknown[]): Promise<undefined> => {
      executed.push({ command, args });
      if (command === OPEN_COMMAND) {
        await openImpl(args[0] as MockUri, args[1] as string, args[2]);
      }
      return undefined;
    },
  },
  env: {
    get remoteName(): string | undefined {
      return remote;
    },
  },
  workspace: {
    get isTrusted(): boolean {
      return trust;
    },
  },
  extensions: {
    getExtension: (_id: string): ExtensionMock | undefined => extension,
  },
  window: {
    tabGroups: {
      get all(): { viewColumn: number; tabs: MockTab[] }[] {
        return [{ viewColumn: 1, tabs }];
      },
      get activeTabGroup(): { viewColumn: number; activeTab: MockTab | undefined } {
        return { viewColumn: 1, activeTab };
      },
      close: async (tab: MockTab): Promise<boolean> => {
        closed.push(tab);
        return closeImpl(tab);
      },
    },
    showErrorMessage: (message: string): Promise<undefined> => {
      errors.push(message);
      return Promise.resolve(undefined);
    },
    showWarningMessage: async (message: string, _options?: unknown, ...items: string[]): Promise<string | undefined> => {
      warnings.push(message);
      return warningImpl(items);
    },
    showInformationMessage: (message: string): Promise<undefined> => {
      infos.push(message);
      return Promise.resolve(undefined);
    },
  },
  TabInputCustom: MockTabInputCustom,
  Uri: MockUri,
};

const moduleInternals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = function (request, parent, isMain): unknown {
  return request === 'vscode' ? vscodeMock : originalLoad.call(Module, request, parent, isMain);
};
const { TitleRefreshUi } = require('../../src/titleRefresh') as typeof import('../../src/titleRefresh');

after(() => {
  moduleInternals._load = originalLoad;
});

function reset(): MockTab {
  errors.length = 0;
  warnings.length = 0;
  infos.length = 0;
  registered.length = 0;
  executed.length = 0;
  closed.length = 0;
  trust = true;
  remote = undefined;
  const original = new MockTab(
    new MockTabInputCustom(new MockUri('openai-codex', 'route', `/local/${A}`, 'keep=1', 'part')),
  );
  tabs = [original];
  activeTab = original;
  extension = { packageJSON: { version: VERIFIED_EDITOR_VERSION }, activate: async () => undefined };
  openImpl = async (uri, viewType) => {
    const tab = new MockTab(new MockTabInputCustom(uri, viewType));
    tabs.push(tab);
    activeTab = tab;
  };
  closeImpl = async tab => {
    tabs = tabs.filter(item => item !== tab);
    if (activeTab === tab) activeTab = tabs.at(-1);
    return true;
  };
  warningImpl = async items => items[0];
  return original;
}

async function run(ui: InstanceType<typeof TitleRefreshUi>): Promise<void> {
  const registration = registered.find(item => item.command === 'codexCompanion.refreshTitle');
  assert.ok(registration);
  await registration.handler();
}

test('cancel leaves the original tab untouched', async () => {
  const original = reset();
  warningImpl = async () => 'Cancel';
  const ui = new TitleRefreshUi(false);
  await run(ui);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /saved chat associated with this tab/);
  assert.match(warnings[0]!, /idle chat/);
  assert.equal(executed.length, 0);
  assert.equal(closed.length, 0);
  assert.deepEqual(tabs, [original]);
  assert.equal(activeTab, original);
  ui.dispose();
});

test('unsupported version is rejected without confirmation or mutation', async () => {
  const original = reset();
  extension = { packageJSON: { version: '1.2.3' }, activate: async () => undefined };
  const ui = new TitleRefreshUi(false);
  await run(ui);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /26\.1007\.21434/);
  assert.match(errors[0]!, /1\.2\.3/);
  assert.equal(warnings.length, 0);
  assert.equal(executed.length, 0);
  assert.equal(closed.length, 0);
  assert.deepEqual(tabs, [original]);
  ui.dispose();
});

test('home and invalid chat URIs show an explanation only', async () => {
  for (const path of ['/', '/local/not-a-uuid', '/remote/chat']) {
    const original = reset();
    original.input = new MockTabInputCustom(new MockUri('openai-codex', 'route', path));
    const ui = new TitleRefreshUi(false);
    await run(ui);
    assert.equal(infos.length, 1, path);
    assert.equal(warnings.length, 0, path);
    assert.equal(executed.length, 0, path);
    assert.equal(closed.length, 0, path);
    assert.deepEqual(tabs, [original], path);
    ui.dispose();
  }
});

test('active tab change during confirmation aborts without mutation', async () => {
  const original = reset();
  const other = new MockTab(new MockTabInputCustom(new MockUri('openai-codex', 'route', `/local/${B}`)));
  tabs.push(other);
  warningImpl = async () => {
    activeTab = other;
    return 'Reopen';
  };
  const ui = new TitleRefreshUi(false);
  await run(ui);
  assert.equal(infos.length, 1);
  assert.match(infos[0]!, /active tab changed/);
  assert.equal(executed.length, 0);
  assert.equal(closed.length, 0);
  assert.deepEqual(tabs, [original, other]);
  ui.dispose();
});

test('dirty original aborts without mutation', async () => {
  const original = reset();
  original.isDirty = true;
  const ui = new TitleRefreshUi(false);
  await run(ui);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /unsaved changes/);
  assert.equal(executed.length, 0);
  assert.equal(closed.length, 0);
  assert.deepEqual(tabs, [original]);
  ui.dispose();
});

test('a tab switch during official activation aborts before opening a replacement', async () => {
  const original = reset();
  extension!.activate = async () => { activeTab = undefined; };
  const ui = new TitleRefreshUi(false);
  await run(ui);
  assert.equal(executed.length, 0);
  assert.equal(closed.length, 0);
  assert.deepEqual(tabs, [original]);
  ui.dispose();
});

test('a tab switch while opening preserves the original and the replacement', async () => {
  const original = reset();
  openImpl = async (uri, viewType) => {
    tabs.push(new MockTab(new MockTabInputCustom(uri, viewType)));
    activeTab = original;
  };
  const ui = new TitleRefreshUi(false);
  await run(ui);
  assert.equal(tabs.length, 2);
  assert.equal(closed.length, 0);
  assert.match(warnings.at(-1)!, /Both tabs were left open/);
  ui.dispose();
});

test('open failure preserves the original and hides internal error text', async () => {
  const original = reset();
  openImpl = async () => {
    throw new Error('private draft text');
  };
  const ui = new TitleRefreshUi(false);
  await run(ui);
  assert.equal(executed.filter(call => call.command === OPEN_COMMAND).length, 1);
  assert.equal(closed.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /original tab was left open/);
  assert.equal(errors[0]!.includes('private draft text'), false);
  assert.deepEqual(tabs, [original]);
  ui.dispose();
});

test('close refusal keeps both tabs and reports it', async () => {
  const original = reset();
  closeImpl = async () => false;
  const ui = new TitleRefreshUi(false);
  await run(ui);
  assert.equal(closed.length, 1);
  assert.equal(closed[0], original);
  assert.equal(tabs.length, 2);
  assert.equal(tabs.includes(original), true);
  assert.match(warnings.at(-1)!, /Both tabs were left open/);
  assert.equal(errors.length, 0);
  ui.dispose();
});

test('success closes only the captured original after the replacement exists', async () => {
  const original = reset();
  let replacementExisted = false;
  closeImpl = async tab => {
    replacementExisted = tabs.some(item => item !== original);
    tabs = tabs.filter(item => item !== tab);
    if (activeTab === tab) activeTab = tabs.at(-1);
    return true;
  };
  const ui = new TitleRefreshUi(false);
  await run(ui);

  assert.equal(replacementExisted, true);
  assert.deepEqual(closed, [original]);
  assert.equal(tabs.length, 1);
  assert.notEqual(tabs[0], original);
  const open = executed.find(call => call.command === OPEN_COMMAND);
  assert.ok(open);
  const uri = open.args[0] as MockUri;
  assert.match(uri.query, new RegExp(`^keep=1&companionTitleRefresh=[0-9a-f-]{36}$`));
  assert.equal(uri.fragment, 'part');
  assert.equal(open.args[1], 'chatgpt.conversationEditor');
  assert.deepEqual(open.args[2], { viewColumn: 1, preview: false });
  assert.equal(executed.some(call => call.command === 'workbench.action.closeActiveEditor'), false);
  assert.equal(warnings.length, 1);
  ui.dispose();
});

test('duplicate command is a no-op while the first run is busy', async () => {
  const original = reset();
  let release: (value: string) => void = () => undefined;
  warningImpl = () => new Promise<string>(resolve => {
    release = resolve;
  });
  const ui = new TitleRefreshUi(false);
  const registration = registered.find(item => item.command === 'codexCompanion.refreshTitle');
  assert.ok(registration);
  const first = Promise.resolve(registration.handler());
  const second = Promise.resolve(registration.handler());
  await Promise.resolve();
  assert.equal(warnings.length, 1);
  assert.equal(executed.length, 0);
  release('Reopen');
  await Promise.all([first, second]);
  assert.equal(executed.filter(call => call.command === OPEN_COMMAND).length, 1);
  assert.equal(closed.length, 1);
  assert.equal(closed[0], original);
  ui.dispose();
});
