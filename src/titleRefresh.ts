import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { OFFICIAL_EXTENSION, VERIFIED_EDITOR_VERSIONS } from './officialCodex';
import { OFFICIAL_EDITOR } from './officialTabs';
import { isThreadId } from './projectHistoryWorker';

export const REFRESH_TITLE_COMMAND = 'codexCompanion.refreshTitle';
const REFRESH_PARAM = 'companionTitleRefresh';
const WAIT_MS = 8_000;
const POLL_MS = 100;

/** Reopens a saved official chat in a new tab so its window title is rebuilt. */
export class TitleRefreshUi implements vscode.Disposable {
  private readonly subscription: vscode.Disposable;
  private busy = false;

  constructor(private readonly ru: boolean) {
    this.subscription = vscode.commands.registerCommand(REFRESH_TITLE_COMMAND, () => this.refresh());
  }

  private tr(russian: string, english: string): string {
    return this.ru ? russian : english;
  }

  private async refresh(): Promise<void> {
    if (this.busy) return;
    if (vscode.env.remoteName || !vscode.workspace.isTrusted || process.platform !== 'win32') {
      void vscode.window.showWarningMessage(this.tr(
        'Обновление названия окна доступно только в локальном доверенном окне VS Code на Windows.',
        'Window title refresh is available only in a local trusted VS Code window on Windows.'));
      return;
    }
    const extension = vscode.extensions.getExtension(OFFICIAL_EXTENSION);
    const version = String(extension?.packageJSON.version ?? '');
    if (!extension) {
      void vscode.window.showErrorMessage(this.tr(
        'Установите или включите официальное расширение Codex (OpenAI).',
        'Install or enable the official Codex extension (OpenAI).'));
      return;
    }
    if (!VERIFIED_EDITOR_VERSIONS.has(version)) {
      void vscode.window.showErrorMessage(this.tr(
        `Обновление названия окна поддерживается только в проверенных версиях Codex ${verifiedVersionText()}. Установлена версия: ${version}.`,
        `Window title refresh requires a verified Codex version ${verifiedVersionText()}. Installed version: ${version}.`));
      return;
    }
    const original = vscode.window.tabGroups.activeTabGroup.activeTab;
    const uri = original ? officialChatUri(original.input) : undefined;
    if (!original || !uri) {
      void vscode.window.showInformationMessage(this.tr(
        'Откройте сохранённый чат официального Codex, чтобы обновить название окна. Главный экран, удалённые вкладки и неофициальные редакторы не поддерживаются; ничего не закрыто.',
        'Open a saved official Codex chat to refresh its window title. Home, remote, and non-official tabs are not supported; nothing was closed.'));
      return;
    }

    this.busy = true;
    try {
      const proceed = this.tr('Переоткрыть', 'Reopen');
      const answer = await vscode.window.showWarningMessage(this.tr(
        'Переоткрыть сохранённый чат и обновить название окна? Используйте после завершения задачи. Если внутри вкладки вы переключились на другой чат, сначала откройте нужный чат заново через «Историю проекта».',
        'Reopen the saved chat associated with this tab and refresh its title? Use this only on an idle chat. If you switched to a different chat inside the tab, open the intended chat again from Project History first.'),
        { modal: true }, proceed, this.tr('Отмена', 'Cancel'));
      if (answer !== proceed) return;
      if (vscode.window.tabGroups.activeTabGroup.activeTab !== original || !officialChatUri(original.input)) {
        void vscode.window.showInformationMessage(this.tr(
          'Активная вкладка изменилась во время подтверждения. Ничего не закрыто; повторите команду на нужном чате.',
          'The active tab changed during confirmation. Nothing was closed; run the command again on the desired chat.'));
        return;
      }
      if (original.isDirty) {
        void vscode.window.showErrorMessage(this.tr(
          'Вкладка сообщает о несохранённых изменениях. Завершите работу и повторите; ничего не закрыто.',
          'The tab reports unsaved changes. Finish your work and try again; nothing was closed.'));
        return;
      }

      try {
        await extension.activate();
      } catch {
        void vscode.window.showErrorMessage(this.tr(
          'Не удалось активировать официальное расширение Codex. Исходная вкладка оставлена открытой.',
          'Could not activate the official Codex extension. The original tab was left open.'));
        return;
      }

      if (vscode.window.tabGroups.activeTabGroup.activeTab !== original || original.isDirty
        || !vscode.window.tabGroups.all.some(group => group.tabs.includes(original))) {
        void vscode.window.showInformationMessage(this.tr(
          'Вкладка изменилась во время открытия Codex. Повторите команду на нужном чате; ничего не закрыто.',
          'The tab changed while Codex was activating. Run the command again on the intended chat; nothing was closed.'));
        return;
      }

      const replacement = uri.with({ query: refreshQuery(uri.query) });
      try {
        await vscode.commands.executeCommand('vscode.openWith', replacement, OFFICIAL_EDITOR, {
          viewColumn: original.group.viewColumn,
          preview: false,
        });
      } catch {
        void vscode.window.showErrorMessage(this.tr(
          'Не удалось открыть чат в новой вкладке. Исходная вкладка оставлена открытой.',
          'Could not open the chat in a new tab. The original tab was left open.'));
        return;
      }
      if (!(await waitForReplacement(replacement))) {
        void vscode.window.showErrorMessage(this.tr(
          'Новая вкладка Codex не появилась. Исходная вкладка оставлена открытой.',
          'The new Codex tab did not appear. The original tab was left open.'));
        return;
      }

      if (!vscode.window.tabGroups.all.some(group => group.tabs.includes(original))) return;
      const active = vscode.window.tabGroups.activeTabGroup.activeTab;
      if (original.isDirty || !(active?.input instanceof vscode.TabInputCustom)
        || active.input.viewType !== OFFICIAL_EDITOR || active.input.uri.toString() !== replacement.toString()) {
        void vscode.window.showWarningMessage(this.tr(
          'Во время переоткрытия вы переключили вкладку или изменили исходную. Обе вкладки оставлены открытыми.',
          'The active tab or original contents changed during reopening. Both tabs were left open.'));
        return;
      }

      let closed = false;
      try {
        closed = await vscode.window.tabGroups.close(original);
      } catch {
        closed = false;
      }
      if (!closed) {
        void vscode.window.showWarningMessage(this.tr(
          'Новая вкладка открыта, но исходную вкладку закрыть не удалось. Обе вкладки оставлены открытыми.',
          'The new tab is open, but the original tab could not be closed. Both tabs were left open.'));
      }
    } finally {
      this.busy = false;
    }
  }

  dispose(): void {
    this.subscription.dispose();
  }
}

function officialChatUri(input: unknown): vscode.Uri | undefined {
  if (!(input instanceof vscode.TabInputCustom) || input.viewType !== OFFICIAL_EDITOR) return undefined;
  const uri = input.uri;
  if (uri.scheme !== 'openai-codex' || uri.authority !== 'route') return undefined;
  const match = /^\/local\/([^/]+)$/.exec(uri.path);
  return match && isThreadId(match[1]) ? uri : undefined;
}

function refreshQuery(query: string): string {
  const parts = query.split('&').filter(part => part.length > 0 && !part.startsWith(`${REFRESH_PARAM}=`));
  parts.push(`${REFRESH_PARAM}=${randomUUID()}`);
  return parts.join('&');
}

function verifiedVersionText(): string {
  return [...VERIFIED_EDITOR_VERSIONS].join(' / ');
}

async function waitForReplacement(uri: vscode.Uri): Promise<boolean> {
  const target = uri.toString();
  const find = (): boolean => vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
    tab.input instanceof vscode.TabInputCustom
    && tab.input.viewType === OFFICIAL_EDITOR
    && tab.input.uri.toString() === target));
  if (find()) return true;
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise<void>(resolve => setTimeout(resolve, POLL_MS));
    if (find()) return true;
  }
  return false;
}
