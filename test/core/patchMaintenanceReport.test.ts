import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { PatchAttestation } from '../../src/patchCompatibility';
import { PatchCompatibilityUi } from '../../src/patchCompatibilityUi';
import {
  renderMaintenanceReport,
  type MaintenanceReport,
} from '../../src/patchMaintenance';

const VERSION = '26.1007.21434';
const HASH = 'a'.repeat(64);

const OFFICIAL_FILES: Record<string, string> = {
  'package.json': JSON.stringify({ publisher: 'openai', name: 'chatgpt', version: VERSION }),
  'out/extension.js': 'official extension bundle',
  'webview/assets/app-initial-97d3534ad35f.js': 'first official webview bundle',
  'webview/assets/app-initial-c014f9ee4429.js': 'second official webview bundle',
};

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

const ATTESTATION: PatchAttestation = {
  schema: 1,
  officialVersion: VERSION,
  features: ['project-history', 'native-tab-titles', 'workflow-notifications'],
  files: Object.fromEntries(
    Object.entries(OFFICIAL_FILES).map(([path, content]) => [path, sha256(content)]),
  ),
};

function features(status: 'installed' | 'missing' | 'partial' | 'unverified' = 'installed') {
  return [
    { id: 'project-history', status },
    { id: 'startup-watchdog', status },
    { id: 'native-tab-titles', status },
    { id: 'project-model', status },
    { id: 'tab-status', status },
    { id: 'workflow-notifications', status },
  ] as MaintenanceReport['features'];
}

function maintenance(overrides: Partial<MaintenanceReport> = {}): MaintenanceReport {
  return {
    schema: 1,
    version: VERSION,
    supportedVersion: VERSION,
    state: 'original',
    code: 'ok',
    files: [{ path: 'out/extension.js', state: 'original', hash: HASH }],
    features: features(),
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

function findProjectRoot(start: string): string {
  let current = start;
  for (;;) {
    if (existsSync(join(current, 'package.json'))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error('Cannot locate the project root');
    current = parent;
  }
}

const FIXTURE_ROOT = join(findProjectRoot(__dirname), '.artifacts', 'stable-020', 'ui', 'report-fixtures');

async function fixture(t: TestContext, files: Record<string, string>): Promise<string> {
  await mkdir(FIXTURE_ROOT, { recursive: true });
  const directory = await mkdtemp(join(FIXTURE_ROOT, 'fixture-'));
  for (const [name, content] of Object.entries(files)) {
    const target = join(directory, ...name.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function compatibilityHarness(
  extensionPath: string,
  officialPath: string,
  report: MaintenanceReport,
) {
  const reports: Array<{ title: string; content: string }> = [];
  const information: Array<{ message: string; actions: string[] }> = [];
  const warnings: Array<{ message: string; actions: string[] }> = [];
  const store = new Map<string, unknown>();
  let maintenanceReads = 0;
  const ui = new PatchCompatibilityUi({
    extensionPath,
    officialExtensionPath: () => officialPath,
    officialVersion: () => VERSION,
    bridgeState: () => 'ready',
    hasOfficialTabs: () => true,
    globalState: {
      get<T>(key: string, defaultValue: T): T {
        return store.has(key) ? store.get(key) as T : defaultValue;
      },
      update(key, value) {
        store.set(key, value);
        return Promise.resolve();
      },
    },
    showWarning: async (message, ...actions) => {
      warnings.push({ message, actions });
      return undefined;
    },
    showInformation: async (message, ...actions) => {
      information.push({ message, actions });
      return 'Подробнее';
    },
    openReport: async (title, content) => {
      reports.push({ title, content });
    },
    readMaintenance: async () => {
      maintenanceReads += 1;
      return report;
    },
    readAttestation: async () => ATTESTATION,
  }, true);
  return {
    ui,
    reports,
    information,
    warnings,
    maintenanceReads: () => maintenanceReads,
  };
}

test('Russian and English reports include versions, translated features, backup and install action', () => {
  const report = maintenance();
  const ru = renderMaintenanceReport(report, true);
  const en = renderMaintenanceReport(report, false);

  assert.match(ru, /Обслуживание патчей Codex Companion/);
  assert.match(ru, /Версия Codex.*26\.1007\.21434/);
  assert.match(ru, /Поддерживаемая версия.*26\.1007\.21434/);
  assert.match(ru, /История проектов/);
  assert.match(ru, /Восстановление запуска вкладок/);
  assert.match(ru, /Заголовки вкладок/);
  assert.match(ru, /Модель и effort проекта/);
  assert.match(ru, /Статус вкладок/);
  assert.match(ru, /Уведомления о ходе работы/);
  assert.match(ru, /Резервная копия.*доступна/);
  assert.match(ru, /Codex: Установить \/ обновить дополнения Companion/);

  assert.match(en, /Codex Companion patch maintenance/);
  assert.match(en, /Codex version.*26\.1007\.21434/);
  assert.match(en, /Supported version.*26\.1007\.21434/);
  assert.match(en, /Project history/);
  assert.match(en, /Native tab titles/);
  assert.match(en, /Workflow notifications/);
  assert.match(en, /Backup.*available/);
  assert.match(en, /Codex: Install \/ Update Companion Enhancements/);

  assert.ok(!ru.includes(HASH));
  assert.ok(!en.includes(HASH));
});

test('unknown versions ask for adaptation instead of install', () => {
  const text = renderMaintenanceReport(maintenance({
    version: '99.0.0',
    state: 'incompatible',
    canInstall: false,
  }), false);

  assert.match(text, /99\.0\.0/);
  assert.match(text, /need adaptation for this exact version/i);
  assert.match(text, /installation is disabled/i);
  assert.doesNotMatch(text, /Install the patches with/);
});

test('mixed and foreign files are never overwritten', () => {
  const text = renderMaintenanceReport(maintenance({
    state: 'mixed',
    canInstall: true,
  }), false);

  assert.match(text, /Do not overwrite files/i);
  assert.doesNotMatch(text, /Install the patches with/);
});

test('a patched tree without a backup explains why full restore is unavailable', () => {
  const text = renderMaintenanceReport(maintenance({
    state: 'workflow',
    canInstall: false,
    canRestore: false,
    backup: {
      path: 'C:/Users/test/AppData/Local/codex-companion/patches/26.1007.21434',
      status: 'missing',
      issues: ['backup.json not found'],
    },
  }), false);

  assert.match(text, /full restore is unavailable until verified original files are provided/i);
  assert.match(text, /backup\.json not found/);
  assert.match(text, /C:\/Users\/test\/AppData/);
});

test('workflow readiness requires both installed bytes and a ready bridge', () => {
  const report = maintenance({ state: 'workflow', canRestore: true });

  const diskOnly = renderMaintenanceReport(report, false);
  assert.doesNotMatch(diskOnly, /notifications active/i);

  const pending = renderMaintenanceReport(report, false, { bridge: 'absent' });
  assert.match(pending, /reload pending/i);
  assert.doesNotMatch(pending, /notifications active/i);

  const notReady = renderMaintenanceReport(report, false, { bridge: 'ready', runtimeReady: false });
  assert.doesNotMatch(notReady, /notifications active/i);

  const ready = renderMaintenanceReport(report, false, { bridge: 'ready', runtimeReady: true });
  assert.match(ready, /notifications active/i);
  assert.doesNotMatch(ready, /Project history[^\n]*active/i);

  const mixed = renderMaintenanceReport({ ...report, state: 'mixed' }, false, { bridge: 'ready', runtimeReady: true });
  assert.doesNotMatch(mixed, /notifications active/i);
  const bridgeOnly = renderMaintenanceReport(report, false, { bridge: 'ready' });
  assert.doesNotMatch(bridgeOnly, /notifications active/i);
  assert.match(ready, /All enhancements are already installed/);
});

test('ready manual check offers Details and reads maintenance only when the report opens', async t => {
  const officialPath = await fixture(t, OFFICIAL_FILES);
  const extensionPath = await fixture(t, {});
  const h = compatibilityHarness(extensionPath, officialPath, maintenance({ state: 'workflow' }));

  await h.ui.check(true, true);
  assert.equal(h.maintenanceReads(), 0);
  assert.equal(h.reports.length, 0);

  await h.ui.showStatus();

  assert.equal(h.information.length, 1);
  assert.deepEqual(h.information[0]!.actions, ['Подробнее']);
  assert.equal(h.maintenanceReads(), 1);
  assert.equal(h.reports.length, 1);
  const content = h.reports[0]!.content;
  assert.match(content, /Обслуживание патчей/);
  assert.match(content, /Версия Codex.*26\.1007\.21434/);
  assert.match(content, /Поддерживаемая версия/);
  assert.match(content, /Уведомления о ходе работы/);
  assert.match(content, /уведомления активны/);
  h.ui.dispose();
});

test('workflow predecessor reports draft upgrade while the complete drafts stage is ready',()=>{
 const report=maintenance({state:'workflow',features:[...features(),{id:'independent-drafts',status:'missing'}]});
 const older=renderMaintenanceReport(report,false,{bridge:'ready',runtimeReady:false});
 assert.match(older,/Independent tab drafts/);assert.match(older,/Install \/ Update Companion Enhancements/);
 assert.doesNotMatch(older,/notifications active/);
 const current=renderMaintenanceReport({...report,state:'drafts',features:[...features(),{id:'independent-drafts',status:'installed'}]},false,{bridge:'ready',runtimeReady:true});
 assert.match(current,/All enhancements are already installed/);assert.match(current,/notifications active/);
 const legacy=renderMaintenanceReport({...report,backup:{path:'C:/backup/drafts-v1',status:'missing',issues:[]},canInstall:true,canRestore:false},false);
 assert.match(legacy,/complete backup will be created before changes/);
 assert.match(legacy,/Install \/ Update Companion Enhancements/);
});
