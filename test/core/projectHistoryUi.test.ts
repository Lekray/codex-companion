import assert from 'node:assert/strict';
import Module from 'node:module';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { VERIFIED_EDITOR_VERSION, VERIFIED_EDITOR_VERSIONS } from '../../src/officialCodex';
import type { HistoryEntry } from '../../src/projectHistoryWorker';

const A = '11111111-1111-4111-8111-111111111111';
const OPENING_FAILURE = 'Could not open the selected conversation in Codex.';

interface ExtensionMock {
  packageJSON: { version?: string };
  activate(): Promise<void>;
}

const errors: string[] = [];
const warnings: string[] = [];
const infos: string[] = [];
const executed: { command: string; args: unknown[] }[] = [];
const uriCalls: unknown[] = [];
let workspaceRoots: string[] = [];
let extension: ExtensionMock | undefined;
let executeCommandImpl: (command: string, ...args: unknown[]) => Promise<unknown> = async () => undefined;
let quickPickImpl: (items: readonly unknown[]) => Promise<unknown> = async () => undefined;

const vscodeMock = {
  commands: {
    registerCommand: (_command: string, _handler: () => unknown): { dispose(): void } => ({ dispose() {} }),
    executeCommand: async (command: string, ...args: unknown[]): Promise<unknown> => {
      executed.push({ command, args });
      return executeCommandImpl(command, ...args);
    },
  },
  env: { remoteName: undefined as string | undefined },
  workspace: {
    get name(): string {
      return 'App';
    },
    get workspaceFolders(): { uri: { scheme: string; fsPath: string } }[] {
      return workspaceRoots.map(root => ({ uri: { scheme: 'file', fsPath: root } }));
    },
  },
  extensions: {
    getExtension: (_id: string): ExtensionMock | undefined => extension,
  },
  window: {
    showErrorMessage: (message: string): Promise<undefined> => {
      errors.push(message);
      return Promise.resolve(undefined);
    },
    showWarningMessage: (message: string): Promise<undefined> => {
      warnings.push(message);
      return Promise.resolve(undefined);
    },
    showInformationMessage: (message: string): Promise<undefined> => {
      infos.push(message);
      return Promise.resolve(undefined);
    },
    showQuickPick: (items: readonly unknown[], _options?: unknown): Promise<unknown> => quickPickImpl(items),
  },
  Uri: {
    from: (components: unknown): { components: unknown; toString(): string } => {
      uriCalls.push(components);
      return { components, toString: () => 'mock-uri' };
    },
  },
  ViewColumn: { Active: -1 },
};

const moduleInternals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
};
const originalLoad = moduleInternals._load;
moduleInternals._load = function (request, parent, isMain): unknown {
  return request === 'vscode' ? vscodeMock : originalLoad.call(Module, request, parent, isMain);
};
const { ProjectHistoryUi } = require('../../src/projectHistoryUi') as typeof import('../../src/projectHistoryUi');

after(() => {
  moduleInternals._load = originalLoad;
});

function reset(): void {
  errors.length = 0;
  warnings.length = 0;
  infos.length = 0;
  executed.length = 0;
  uriCalls.length = 0;
  workspaceRoots = ['C:\\Work\\App'];
  extension = { packageJSON: { version: VERIFIED_EDITOR_VERSION }, activate: async () => undefined };
  executeCommandImpl = async () => undefined;
  quickPickImpl = async () => undefined;
}

function entry(): HistoryEntry {
  return {
    id: A,
    cwd: 'C:\\Work\\App\\nested',
    name: '',
    title: 'Conversation',
    updatedAt: 0,
    root: 'C:\\Work\\App',
    folder: 'nested',
  };
}

async function openEntry(ui: InstanceType<typeof ProjectHistoryUi>, value: HistoryEntry): Promise<void> {
  await (ui as unknown as { openEntry(entry: HistoryEntry): Promise<void> }).openEntry(value);
}

test('activation rejection is an opening failure, not a history read failure', async () => {
  reset();
  let activations = 0;
  extension = {
    packageJSON: { version: VERIFIED_EDITOR_VERSION },
    activate: async () => {
      activations++;
      throw new Error('activation failed');
    },
  };
  const ui = new ProjectHistoryUi(false);
  await openEntry(ui, entry());
  assert.equal(activations, 1);
  assert.equal(executed.length, 0);
  assert.deepEqual(errors, [OPENING_FAILURE]);
  assert.equal(errors.some(message => /history/i.test(message)), false);
  ui.dispose();
});

test('vscode.openWith rejection is an opening failure, not a history read failure', async () => {
  reset();
  executeCommandImpl = async () => {
    throw new Error('openWith failed');
  };
  const ui = new ProjectHistoryUi(false);
  await openEntry(ui, entry());
  assert.deepEqual(executed.map(call => call.command), ['vscode.openWith']);
  assert.deepEqual(errors, [OPENING_FAILURE]);
  assert.equal(errors.some(message => /history/i.test(message)), false);
  ui.dispose();
});

test('incompatible version is rejected before activation', async () => {
  reset();
  let activations = 0;
  extension = {
    packageJSON: { version: '1.2.3' },
    activate: async () => {
      activations++;
    },
  };
  const ui = new ProjectHistoryUi(false);
  await openEntry(ui, entry());
  assert.equal(activations, 0);
  assert.equal(executed.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /26\.1007\.21434/);
  assert.match(errors[0]!, /26\.1021\.22027/);
  assert.match(errors[0]!, /1\.2\.3/);
  ui.dispose();
});

test('both verified Codex versions pass the history guard', async () => {
  for (const version of VERIFIED_EDITOR_VERSIONS) {
    reset();
    let activations = 0;
    extension = {
      packageJSON: { version },
      activate: async () => {
        activations++;
      },
    };
    const ui = new ProjectHistoryUi(false);
    await openEntry(ui, entry());
    assert.equal(activations, 1, version);
    assert.equal(errors.length, 0, version);
    assert.equal(executed.filter(call => call.command === 'vscode.openWith').length, 1, version);
    assert.deepEqual(uriCalls, [{ scheme: 'openai-codex', authority: 'route', path: `/local/${A}` }], version);
    ui.dispose();
  }
});

test('successful opening activates once and uses the official route URI', async () => {
  reset();
  let activations = 0;
  extension = {
    packageJSON: { version: VERIFIED_EDITOR_VERSION },
    activate: async () => {
      activations++;
    },
  };
  const ui = new ProjectHistoryUi(false);
  await openEntry(ui, entry());
  assert.equal(activations, 1);
  assert.equal(errors.length, 0);
  assert.equal(executed.length, 1);
  assert.equal(executed[0]!.command, 'vscode.openWith');
  assert.deepEqual(uriCalls, [{ scheme: 'openai-codex', authority: 'route', path: `/local/${A}` }]);
  assert.equal(executed[0]!.args[1], 'chatgpt.conversationEditor');
  assert.deepEqual(executed[0]!.args[2], { viewColumn: -1, preview: false });
  ui.dispose();
});

test('missing timestamps render a localized unknown date through the worker', async () => {
  reset();
  const root = mkdtempSync(join(tmpdir(), 'companion-project-history-ui-'));
  const previousHome = process.env.CODEX_HOME;
  try {
    const cwd = join(root, 'project');
    mkdirSync(cwd, { recursive: true });
    const database = new DatabaseSync(join(root, 'state_5.sqlite'));
    try {
      database.exec(`CREATE TABLE threads (
        "id" TEXT, "cwd" TEXT, "name" TEXT,
        "updated_at" INTEGER, "updated_at_ms" INTEGER, "recency_at_ms" INTEGER
      )`);
      database.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)')
        .run(A, cwd, 'No timestamp', null, null, null);
    } finally {
      database.close();
    }
    workspaceRoots = [root];
    process.env.CODEX_HOME = root;

    for (const locale of [{ ru: true, text: 'Дата неизвестна' }, { ru: false, text: 'Date unknown' }]) {
      let items: { detail?: string }[] | undefined;
      quickPickImpl = async picked => {
        items = picked as { detail?: string }[];
        return undefined;
      };
      const ui = new ProjectHistoryUi(locale.ru);
      await ui.show();
      assert.equal(items?.length, 1);
      assert.equal(items![0]!.detail, `${locale.text} · ${cwd}`);
      assert.equal(items![0]!.detail!.includes('1970'), false);
      assert.equal(errors.length, 0);
      ui.dispose();
    }
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
