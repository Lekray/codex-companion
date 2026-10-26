import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  INSTALL_PATCH_COMMAND,
  PatchMaintenanceUi,
  RESTORE_PATCH_COMMAND,
  renderMaintenanceReport,
  type MaintenanceEngine,
  type MaintenanceEngineOptions,
  type MaintenanceReport,
  type MaintenanceUiDependencies,
} from '../../src/patchMaintenance';

const VERSION = '26.1007.21434';
const FEATURES = [
  { id: 'project-history', status: 'installed' as const },
  { id: 'startup-watchdog', status: 'installed' as const },
  { id: 'native-tab-titles', status: 'installed' as const },
  { id: 'project-model', status: 'installed' as const },
  { id: 'tab-status', status: 'installed' as const },
  { id: 'workflow-notifications', status: 'installed' as const },
];

function report(overrides: Partial<MaintenanceReport> = {}): MaintenanceReport {
  return {
    schema: 1,
    version: VERSION,
    supportedVersion: VERSION,
    state: 'original',
    code: 'ok',
    files: [{ path: 'out/extension.js', state: 'original', hash: 'a'.repeat(64) }],
    features: FEATURES,
    backup: {
      path: 'C:/Users/test/AppData/Local/codex-companion/patches/26.1007.21434',
      status: 'valid',
      issues: [],
    },
    canInstall: true,
    canRestore: false,
    issues: [],
    ...overrides,
  };
}

interface HarnessOptions {
  allowed?: boolean;
  options?: MaintenanceEngineOptions | undefined;
  checked?: () => Promise<MaintenanceReport>;
  installed?: () => Promise<MaintenanceReport>;
  restored?: () => Promise<MaintenanceReport>;
  informationChoice?: string | undefined;
  errorChoice?: string | undefined;
  informationPending?: Promise<string | undefined>;
}

function harness(config: HarnessOptions = {}) {
  const calls = { check: 0, install: 0, restore: 0 };
  const engineOptions: MaintenanceEngineOptions[] = [];
  const information: Array<{ message: string; actions: string[] }> = [];
  const errors: Array<{ message: string; actions: string[] }> = [];
  const reports: Array<{ title: string; content: string }> = [];
  let changed = 0;
  const engine: MaintenanceEngine = {
    async check(options) {
      calls.check += 1;
      engineOptions.push(options);
      return config.checked ? config.checked() : report();
    },
    async install(options) {
      calls.install += 1;
      engineOptions.push(options);
      return config.installed ? config.installed() : report({ operation: 'install', changed: true });
    },
    async restore(options) {
      calls.restore += 1;
      engineOptions.push(options);
      return config.restored ? config.restored() : report({ operation: 'restore', changed: true });
    },
  };
  const defaults: MaintenanceEngineOptions = { extDir: 'C:/ext', backupDir: 'C:/backup' };
  const deps: MaintenanceUiDependencies = {
    engine,
    options: () => (Object.prototype.hasOwnProperty.call(config, 'options') ? config.options : defaults),
    allowed: () => config.allowed ?? true,
    showInformation: async (message, ...actions) => {
      information.push({ message, actions });
      return config.informationPending ?? config.informationChoice;
    },
    showError: async (message, ...actions) => {
      errors.push({ message, actions });
      return config.errorChoice;
    },
    openReport: async (title, content) => {
      reports.push({ title, content });
    },
    onChanged: async () => {
      changed += 1;
    },
  };
  return {
    ui: new PatchMaintenanceUi(deps, false),
    calls,
    engineOptions,
    information,
    errors,
    reports,
    changed: () => changed,
  };
}

test('construction and report are read-only and never recheck compatibility', async () => {
  const h = harness();
  assert.deepEqual(h.calls, { check: 0, install: 0, restore: 0 });

  const result = await h.ui.report();

  assert.equal(result?.state, 'original');
  assert.deepEqual(h.calls, { check: 1, install: 0, restore: 0 });
  assert.equal(h.changed(), 0);
  assert.equal(h.reports.length, 1);
  assert.equal(h.reports[0]!.title, 'Codex Companion patch maintenance');
  assert.match(h.reports[0]!.content, /Codex Companion patch maintenance/);
  assert.match(h.reports[0]!.content, /C:\/Users\/test\/AppData/);
});

test('install refuses before any write when the window is not allowed', async () => {
  const h = harness({ allowed: false });

  await h.ui.install();

  assert.deepEqual(h.calls, { check: 0, install: 0, restore: 0 });
  assert.equal(h.changed(), 0);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0]!.message, /trusted local Windows window/i);
});

test('install refuses unknown versions and mixed states even if the engine says canInstall', async () => {
  const unknown = harness({
    checked: async () => report({ version: '99.0.0', state: 'incompatible', canInstall: true }),
  });
  await unknown.ui.install();
  assert.equal(unknown.calls.install, 0);
  assert.match(unknown.errors[0]!.message, /99\.0\.0/);
  assert.match(unknown.errors[0]!.message, /need adaptation for this exact version/i);

  const mixed = harness({
    checked: async () => report({ state: 'mixed', canInstall: true }),
  });
  await mixed.ui.install();
  assert.equal(mixed.calls.install, 0);
  assert.match(mixed.errors[0]!.message, /mixed or foreign changes/i);
});

test('install prechecks, writes once through the engine and rechecks compatibility', async () => {
  const h = harness({
    installed: async () => report({ operation: 'install', changed: true }),
  });

  await h.ui.install();

  assert.deepEqual(h.calls, { check: 1, install: 1, restore: 0 });
  assert.deepEqual(h.engineOptions[0], { extDir: 'C:/ext', backupDir: 'C:/backup' });
  assert.equal(h.changed(), 1);
  assert.equal(h.information.length, 1);
  assert.match(h.information[0]!.message, /Reload the window once/i);
  assert.match(h.information[0]!.message, /current tasks finish/i);
});

test('idempotent install reports no changes and no reload instruction', async () => {
  const h = harness({
    installed: async () => report({ operation: 'install', changed: false }),
  });

  await h.ui.install();

  assert.equal(h.calls.install, 1);
  assert.equal(h.changed(), 1);
  assert.equal(h.information.length, 1);
  assert.match(h.information[0]!.message, /already installed/i);
  assert.doesNotMatch(h.information[0]!.message, /reload/i);
});

test('a second operation cannot start while the first is in flight', async () => {
  let finish: ((value: MaintenanceReport) => void) | undefined;
  const pending = new Promise<MaintenanceReport>(resolve => {
    finish = resolve;
  });
  const h = harness({ installed: () => pending });

  const first = h.ui.install();
  const second = h.ui.install();
  await second;

  assert.equal(h.calls.install, 1);
  assert.equal(h.information.length, 1);
  assert.match(h.information[0]!.message, /already in progress/i);

  finish?.(report({ operation: 'install', changed: true }));
  await first;
  assert.equal(h.calls.install, 1);
  assert.equal(h.changed(), 1);
});

test('engine failures are caught and never escape the controller', async () => {
  const checkFailure = harness({
    checked: async () => {
      throw new Error('check exploded');
    },
  });
  await checkFailure.ui.install();
  assert.equal(checkFailure.calls.install, 0);
  assert.match(checkFailure.errors[0]!.message, /check exploded/);

  const installFailure = harness({
    installed: async () => {
      throw new Error('install exploded');
    },
  });
  await installFailure.ui.install();
  assert.equal(installFailure.calls.install, 1);
  assert.equal(installFailure.changed(), 1);
  assert.match(installFailure.errors[0]!.message, /install exploded/);
});

test('restore requires a valid backup and rechecks compatibility after success', async () => {
  const missing = harness({
    checked: async () => report({
      state: 'workflow',
      canRestore: true,
      backup: { path: 'C:/backup', status: 'missing', issues: [] },
    }),
  });
  await missing.ui.restore();
  assert.equal(missing.calls.restore, 0);
  assert.match(missing.errors[0]!.message, /backup is missing/i);

  const ok = harness({
    checked: async () => report({ state: 'workflow', canRestore: true }),
    restored: async () => report({ operation: 'restore', changed: true }),
  });
  await ok.ui.restore();
  assert.equal(ok.calls.restore, 1);
  assert.equal(ok.changed(), 1);
  assert.match(ok.information[0]!.message, /Reload the window once/i);
});

test('refused prechecks expose Details without applying anything', async () => {
  const h = harness({
    checked: async () => report({ state: 'mixed', canInstall: false }),
    errorChoice: 'Details',
  });

  await h.ui.install();

  assert.equal(h.calls.install, 0);
  assert.deepEqual(h.errors[0]!.actions, ['Details']);
  assert.equal(h.reports.length, 1);
  assert.match(h.reports[0]!.content, /Do not overwrite files/i);
});

test('precheck flags canInstall and canRestore independently of state guards', async () => {
  const install = harness({
    checked: async () => report({ state: 'incompatible', canInstall: false }),
  });
  await install.ui.install();
  assert.equal(install.calls.install, 0);
  assert.match(install.errors[0]!.message, /Installation is unavailable/i);

  const restore = harness({
    checked: async () => report({ state: 'workflow', canRestore: false }),
  });
  await restore.ui.restore();
  assert.equal(restore.calls.restore, 0);
  assert.match(restore.errors[0]!.message, /Restore is unavailable/i);
});

test('command identifiers stay stable for Main registration', () => {
  assert.equal(INSTALL_PATCH_COMMAND, 'codexCompanion.installPatch');
  assert.equal(RESTORE_PATCH_COMMAND, 'codexCompanion.restorePatch');
});

test('preload-index reports an accurate translated feature label', () => {
  const value = report({
    state: 'drafts',
    features: [...FEATURES, { id: 'preload-index', status: 'installed' as const }],
  });
  assert.match(renderMaintenanceReport(value, true), /Ускорение открытия чата/);
  assert.match(renderMaintenanceReport(value, false), /Faster chat opening/);
});

test('autoscroll reports an accurate translated feature label', () => {
  const value = report({
    state: 'drafts',
    features: [...FEATURES, { id: 'autoscroll', status: 'installed' as const }],
  });
  assert.match(renderMaintenanceReport(value, true), /\u0410\u0432\u0442\u043e\u043f\u0440\u043e\u043a\u0440\u0443\u0442\u043a\u0430/);
  assert.match(renderMaintenanceReport(value, false), /Latest-answer autoscroll/);
});

test('a completed operation releases its guard before its information toast is dismissed', async () => {
  let dismiss!: (value: undefined) => void;
  const informationPending = new Promise<undefined>(resolve => { dismiss = resolve; });
  const h = harness({ informationPending });
  await h.ui.install();
  await h.ui.install();
  assert.equal(h.calls.install, 2);
  dismiss(undefined);
});
