import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppServerClient } from './appServer';
import { quotaDisplay } from './quotaDisplay';
import { openOfficialCodex, OFFICIAL_EXTENSION, OFFICIAL_NEW_EDITOR_PATH } from './officialCodex';
import { QuotaMonitor } from './quotaMonitor';
import { LEGACY_VIEW, preserveLegacyDraft } from './legacyMigration';
import { QuotaUi, quotaTooltip } from './quotaUi';
import { officialTabs, OFFICIAL_EDITOR, revealOfficialTab } from './officialTabs';
import { ProjectEnvironmentUi } from './projectEnvironment';
import { ProjectHistoryUi } from './projectHistoryUi';
import { TitleRefreshUi } from './titleRefresh';
import { WindowNamesUi, RENAME_WINDOW_COMMAND } from './windowNamesUi';
import { CHECK_COMPATIBILITY_COMMAND, PatchCompatibilityUi } from './patchCompatibilityUi';
import { WorkflowUi, type OfficialOpenTab } from './workflowUi';
import { OPEN_CHATS_COMMAND, OpenChatsUi } from './openChatsUi';
import { AttentionUi } from './attentionUi';
import type { OpenChatItem } from './openChatsModel';
import {
  INSTALL_PATCH_COMMAND, RESTORE_PATCH_COMMAND, PatchMaintenanceUi,
  type MaintenanceEngine,
} from './patchMaintenance';

let cleanup: (() => Promise<void>) | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const ru = vscode.env.language.toLowerCase().startsWith('ru');
  const tr = (russian: string, english: string) => ru ? russian : english;
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.name = 'Codex Companion';
  status.command = 'codexCompanion.menu';
  status.text = '$(codex-companion-logo) · …';
  context.subscriptions.push(status);

  function executable(): string {
    const configured = vscode.workspace.getConfiguration('codexCompanion').get<string>('cliPath', '').trim();
    if (configured) return configured;
    const official = vscode.extensions.getExtension('openai.chatgpt');
    if (official && process.platform === 'win32') {
      const path = join(official.extensionPath, 'bin', process.arch === 'arm64' ? 'windows-aarch64' : 'windows-x86_64', 'codex.exe');
      if (existsSync(path)) return path;
    }
    return 'codex';
  }

  let quotaUi: QuotaUi | undefined;
  let projectEnvironment: ProjectEnvironmentUi | undefined;
  const monitor = new QuotaMonitor(() => {
    if (!cwd || !vscode.workspace.isTrusted || vscode.env.remoteName || process.platform !== 'win32') {
      throw new Error('Quota reads require a trusted local Windows workspace');
    }
    return new AppServerClient({ executable: executable(), cwd });
  }, render);

  function render(): void {
    const display = quotaDisplay(monitor.state, ru);
    status.text = display.text;
    status.backgroundColor = display.severity === 'error'
      ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : display.severity === 'warning' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    status.tooltip = quotaTooltip(monitor.state, ru);
    quotaUi?.refresh();
  }

  context.subscriptions.push(vscode.commands.registerCommand('codexCompanion.open', async () => {
    if (projectEnvironment && !projectEnvironment.guardCurrentWorkspace()) return;
    try {
      const mode = await openOfficialCodex({
        extension: id => {
          const extension = vscode.extensions.getExtension(id);
          return extension ? { activate: () => extension.activate(), version: String(extension.packageJSON.version) } : undefined;
        },
        commands: () => vscode.commands.getCommands(true),
        execute: command => vscode.commands.executeCommand(command),
        openDistinctEditor: instanceId => vscode.commands.executeCommand('vscode.openWith',
          vscode.Uri.from({ scheme: 'openai-codex', authority: 'route', path: OFFICIAL_NEW_EDITOR_PATH, query: `companion=${instanceId}` }),
          OFFICIAL_EDITOR, { viewColumn: vscode.ViewColumn.Active, preserveFocus: false, preview: false }),
      }, ru);
      if (mode === 'standard') void vscode.window.showWarningMessage(tr(
        'Для этой версии Codex отдельные вкладки ещё не проверены. Открыта стандартная панель; она может использовать существующую вкладку.',
        'Separate tabs have not been verified for this Codex version. The standard panel was opened and may reuse an existing tab.'));
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : tr('Не удалось открыть Codex.', 'Could not open Codex.'));
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand('codexCompanion.refreshQuotas', () => monitor.refresh()));
  quotaUi = new QuotaUi(context, monitor, ru);
  context.subscriptions.push(quotaUi, new ProjectHistoryUi(ru), new TitleRefreshUi(ru));
  projectEnvironment = new ProjectEnvironmentUi(context, ru);
  context.subscriptions.push(projectEnvironment);

  // Compatibility cleanup only: no custom panel is created, no thread is resumed.
  // The original companion.tabs.v1/counter remain untouched for recovery/rollback.
  let migration = Promise.resolve();
  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(LEGACY_VIEW, {
    async deserializeWebviewPanel(panel, state: unknown) {
      const save = migration.then(() => preserveLegacyDraft(context.workspaceState, state));
      migration = save.catch(() => {});
      await save;
      panel.dispose();
    },
  }));
  // A fresh isolated profile opens the existing Codex panel once; globalState prevents reloads.
  void projectEnvironment.openInitialIfIsolated();

  const isLocal = (): boolean =>
    !!cwd && vscode.workspace.isTrusted && !vscode.env.remoteName && process.platform === 'win32';
  const local = isLocal();
  let patchCompatibility: PatchCompatibilityUi | undefined;
  let attentionUi: AttentionUi | undefined;
  let attentionCompatibilityDigest: string | undefined;
  type PatchEngineModule = MaintenanceEngine & {
    defaultBackupPathForVersion(version: string): string;
    supportedVersions?(): string[];
  };
  const patchEngine = (): PatchEngineModule =>
    require(join(context.extensionPath, 'scripts', 'companionPatches.cjs')) as PatchEngineModule;
  const maintenance = new PatchMaintenanceUi({
    engine: {
      check: async options => patchEngine().check(options),
      install: async options => patchEngine().install(options),
      restore: async options => patchEngine().restore(options),
    },
    options: () => {
      const official = vscode.extensions.getExtension(OFFICIAL_EXTENSION);
      if (!official) return undefined;
      const version = official.packageJSON.version;
      return {
        extDir: official.extensionPath,
        backupDir: patchEngine().defaultBackupPathForVersion(
          typeof version === 'string' ? version : '',
        ),
      };
    },
    allowed: isLocal,
    showInformation: async (message, ...actions) => vscode.window.showInformationMessage(message, ...actions),
    showError: async (message, ...actions) => vscode.window.showErrorMessage(message, ...actions),
    openReport: async (_title, content) => {
      const document = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
      await vscode.window.showTextDocument(document, { preview: false });
    },
    onChanged: async () => { await patchCompatibility?.check(true, true); },
  }, ru);
  const workflowUi = new WorkflowUi({
    russian: ru,
    extensionPath: context.extensionPath,
    claimDir: join(context.globalStorageUri.fsPath, 'workflow-notification-claims'),
    local: isLocal,
    focused: () => vscode.window.state.focused,
    settings: () => {
      const configuration = vscode.workspace.getConfiguration('codexCompanion');
      return {
        enabled: configuration.get<boolean>('notifications', true),
        windows: configuration.get<boolean>('windowsNotifications', true),
        sound: configuration.get<boolean>('notificationSound', true),
      };
    },
    registerCommand: (command, handler) => vscode.commands.registerCommand(command, handler),
    executeCommand: async (command, ...args) => vscode.commands.executeCommand(command, ...args),
    getCommands: async () => vscode.commands.getCommands(true),
    inApp: async (message, openLabel) =>
      (await vscode.window.showInformationMessage(message, openLabel)) === openLabel,
    openOfficialTabs: (): OfficialOpenTab[] => officialTabs().map(tab => {
      const match = /^\/local\/([^/]+)$/.exec(tab.uri.path);
      return {
        uri: tab.uri.toString(),
        column: tab.column,
        threadId: match ? match[1]! : null,
      };
    }),
    revealOfficialTab: async (uri, column) => {
      if (!officialTabs().some(tab => tab.uri.toString() === uri)) return;
      await revealOfficialTab(vscode.Uri.parse(uri), column as vscode.ViewColumn);
    },
    projectName: () => vscode.workspace.name,
    onBridgeState: state => {
      if (state !== 'unknown') void patchCompatibility?.check(false);
    },
    onStatusEvent: () => { void attentionUi?.refresh(); },
    onError: error => console.warn('[codex-companion] workflow notification failed', error),
  });
  const compatibilityItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  compatibilityItem.name = 'Codex Compatibility';
  compatibilityItem.command = CHECK_COMPATIBILITY_COMMAND;
  patchCompatibility = new PatchCompatibilityUi({
    extensionPath: context.extensionPath,
    officialExtensionPath: () => vscode.extensions.getExtension(OFFICIAL_EXTENSION)?.extensionPath,
    readMaintenance: () => maintenance.readReport(),
    officialVersion: () => {
      const version = vscode.extensions.getExtension(OFFICIAL_EXTENSION)?.packageJSON.version;
      return typeof version === 'string' ? version : undefined;
    },
    bridgeState: () => workflowUi.bridgeState(),
    hasOfficialTabs: () => officialTabs().length > 0,
    globalState: context.globalState,
    showWarning: async (message, ...actions) => vscode.window.showWarningMessage(message, ...actions),
    showInformation: async (message, ...actions) => vscode.window.showInformationMessage(message, ...actions),
    openReport: async (_title, content) => {
      const document = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
      await vscode.window.showTextDocument(document, { preview: false });
    },
    statusItem: compatibilityItem,
    onDidChangeExtensions: handler => vscode.extensions.onDidChange(handler),
    onDidChangeWindowFocus: handler => vscode.window.onDidChangeWindowState(event => {
      if (event.focused) handler();
    }),
    schedule: (handler, milliseconds) => {
      const timer = setInterval(handler, milliseconds);
      return { dispose: () => clearInterval(timer) };
    },
    onStatus: status => {
      workflowUi.noteCompatibilityChanged();
      if (attentionCompatibilityDigest === status.digest) return;
      attentionCompatibilityDigest = status.digest;
      void attentionUi?.refresh();
    },
    onError: error => console.warn('[codex-companion] compatibility check failed', error),
  }, ru);
  workflowUi.setCompatibilityGate(() => patchCompatibility?.notificationsAllowed() ?? false);
  const windowNamesUi = new WindowNamesUi({
    allowed: async () => {
      await workflowUi.retryBridge();
      await patchCompatibility?.check(false, true);
      return isLocal() && patchCompatibility?.status()?.runtimeReady === true;
    },
    getWindows: () => vscode.commands.executeCommand('chatgpt.companion.v1.getWindowNames'),
    pick: items => vscode.window.showQuickPick(items, { placeHolder: tr('Выберите окно Codex', 'Select a Codex window') }),
    input: value => vscode.window.showInputBox({
      title: tr('Переименовать окно Codex', 'Rename Codex Window'),
      prompt: tr('Название окна', 'Window name'), value, ignoreFocusOut: true,
    }),
    rename: input => vscode.commands.executeCommand('chatgpt.companion.v1.renameWindow', input),
    warn: message => { void vscode.window.showWarningMessage(message); },
  }, ru);
  const openChatsUi = new OpenChatsUi({
    allowed: () => isLocal() && patchCompatibility?.status()?.runtimeReady === true,
    getState: () => vscode.commands.executeCommand('chatgpt.companion.v1.getState'),
    focusTab: payload => vscode.commands.executeCommand('chatgpt.companion.v1.focusTab', payload),
    createQuickPick: () => vscode.window.createQuickPick<OpenChatItem>(),
    onDidChangeTabs: handler => {
      const tabs = vscode.window.tabGroups.onDidChangeTabs(handler);
      const groups = vscode.window.tabGroups.onDidChangeTabGroups(handler);
      return { dispose: () => { tabs.dispose(); groups.dispose(); } };
    },
    showError: message => { void vscode.window.showErrorMessage(message); },
    showWarning: message => { void vscode.window.showWarningMessage(message); },
  }, ru);
  attentionUi = new AttentionUi({
    allowed: () => isLocal() && patchCompatibility?.status()?.runtimeReady === true,
    getState: () => vscode.commands.executeCommand('chatgpt.companion.v1.getState'),
    focusTab: payload => vscode.commands.executeCommand('chatgpt.companion.v1.focusTab', payload),
    createStatusItem: () => {
      const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
      item.name = 'Codex Attention';
      return item;
    },
    onDidChangeTabs: handler => {
      const tabs = vscode.window.tabGroups.onDidChangeTabs(handler);
      const groups = vscode.window.tabGroups.onDidChangeTabGroups(handler);
      return { dispose: () => { tabs.dispose(); groups.dispose(); } };
    },
    registerCommand: (command, handler) => vscode.commands.registerCommand(command, handler),
    showWarning: message => { void vscode.window.showWarningMessage(message); },
    showError: message => { void vscode.window.showErrorMessage(message); },
    onError: error => console.warn('[codex-companion] attention refresh failed', error),
  }, ru);
  void attentionUi.refresh();
  context.subscriptions.push(
    workflowUi,
    patchCompatibility,
    openChatsUi,
    attentionUi,
    vscode.commands.registerCommand(RENAME_WINDOW_COMMAND, () => windowNamesUi.rename()),
    vscode.commands.registerCommand(OPEN_CHATS_COMMAND, async () => {
      await workflowUi.retryBridge();
      await patchCompatibility?.check(false, true);
      await openChatsUi.show();
    }),
    vscode.commands.registerCommand('codexCompanion.openLegacyDraft', async () => {
      const compatibility = await patchCompatibility?.check(false, true);
      if (!isLocal() || !compatibility?.report.ok) {
        void vscode.window.showWarningMessage(tr(
          'Прежний черновик доступен в доверенном локальном проекте после проверки совместимости Codex.',
          'The previous draft is available in a trusted local project after Codex compatibility is verified.'));
        return;
      }
      try {
        await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.from({
          scheme: 'openai-codex', authority: 'route', path: OFFICIAL_NEW_EDITOR_PATH,
          query: `companionLegacyDraft=${randomUUID()}`,
        }), OFFICIAL_EDITOR, { viewColumn: vscode.ViewColumn.Active, preserveFocus: false, preview: false });
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    }),
    vscode.commands.registerCommand(CHECK_COMPATIBILITY_COMMAND, () => patchCompatibility?.showStatus()),
    vscode.commands.registerCommand(INSTALL_PATCH_COMMAND, () => maintenance.install()),
    vscode.commands.registerCommand(RESTORE_PATCH_COMMAND, () => maintenance.restore()),
    vscode.extensions.onDidChange(() => { void workflowUi.retryBridge(); }),
  );
  if (local) { status.show(); void monitor.refresh(); }
  const poll = setInterval(() => { if (local) void monitor.refresh(); }, 60_000);
  const countdown = setInterval(render, 30_000);
  cleanup = async () => {
    clearInterval(poll);
    clearInterval(countdown);
    attentionUi?.dispose();
    attentionUi = undefined;
    workflowUi.dispose();
    patchCompatibility?.dispose();
    await monitor.dispose();
    await migration;
    await quotaUi?.flush();
  };
}

export async function deactivate(): Promise<void> { await cleanup?.(); cleanup = undefined; }
