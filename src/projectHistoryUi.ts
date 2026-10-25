import * as vscode from 'vscode';
import { basename } from 'node:path';
import { OFFICIAL_EXTENSION, VERIFIED_EDITOR_VERSIONS } from './officialCodex';
import { OFFICIAL_EDITOR } from './officialTabs';
import {
  isThreadId,
  loadProjectHistory,
  matchWorkspace,
  resolveCodexHome,
  type HistoryEntry,
  type HistoryFailureCode,
} from './projectHistoryWorker';

export const PROJECT_HISTORY_COMMAND = 'codexCompanion.projectHistory';

interface HistoryQuickPickItem extends vscode.QuickPickItem {
  entry: HistoryEntry;
}

export class ProjectHistoryUi implements vscode.Disposable {
  private readonly subscription: vscode.Disposable;
  private busy = false;

  constructor(private readonly ru: boolean) {
    this.subscription = vscode.commands.registerCommand(PROJECT_HISTORY_COMMAND, () => this.show());
  }

  private tr(russian: string, english: string): string {
    return this.ru ? russian : english;
  }

  async show(): Promise<void> {
    if (this.busy) return;
    if (vscode.env.remoteName) {
      void vscode.window.showWarningMessage(this.tr(
        'История проекта доступна только в локальном окне VS Code.',
        'Project History is available only in a local VS Code window.'));
      return;
    }
    const roots = (vscode.workspace.workspaceFolders ?? [])
      .filter(folder => folder.uri.scheme === 'file')
      .map(folder => folder.uri.fsPath)
      .filter(path => path.length > 0);
    if (!roots.length) {
      void vscode.window.showWarningMessage(this.tr(
        'Откройте локальную папку проекта, чтобы показать историю проекта.',
        'Open a local project folder to show its project history.'));
      return;
    }
    this.busy = true;
    try {
      const result = await loadProjectHistory({ home: resolveCodexHome(), roots });
      if (!result.ok) {
        void vscode.window.showErrorMessage(failureText(result.code, this.ru));
        return;
      }
      if (!result.entries.length) {
        void vscode.window.showInformationMessage(this.tr(
          'В этом проекте нет сохранённых диалогов.',
          'No saved conversations were found for this project.'));
        return;
      }
      const project = vscode.workspace.name || basename(roots[0]!) || this.tr('Проект', 'Project');
      const items: HistoryQuickPickItem[] = result.entries.map(entry => ({
        label: titleOf(entry, this.ru),
        description: entry.folder,
        detail: `${formatUpdatedAt(entry.updatedAt, this.ru)} · ${entry.cwd}`,
        entry,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        title: `${project} — ${this.tr('История проекта', 'Project History')}`,
        placeHolder: this.tr('Найти диалог по названию', 'Search conversations by title'),
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (picked) await this.openEntry(picked.entry);
    } catch {
      void vscode.window.showErrorMessage(this.tr(
        'Не удалось прочитать локальную историю Codex.',
        'Could not read local Codex history.'));
    } finally {
      this.busy = false;
    }
  }

  private async openEntry(entry: HistoryEntry): Promise<void> {
    const roots = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath);
    if (!matchWorkspace(entry.cwd, roots)) {
      void vscode.window.showWarningMessage(this.tr('Рабочие папки изменились. Откройте историю проекта ещё раз.', 'Workspace folders changed. Open Project History again.'));
      return;
    }
    if (!isThreadId(entry.id)) {
      void vscode.window.showErrorMessage(this.tr(
        'Идентификатор диалога повреждён; открытие отменено.',
        'The conversation identifier is invalid; opening was cancelled.'));
      return;
    }
    const extension = vscode.extensions.getExtension(OFFICIAL_EXTENSION);
    if (!extension) {
      void vscode.window.showErrorMessage(this.tr(
        'Установите или включите официальное расширение Codex (OpenAI).',
        'Install or enable the official Codex extension (OpenAI).'));
      return;
    }
    const version = String(extension.packageJSON.version ?? '');
    if (!VERIFIED_EDITOR_VERSIONS.has(version)) {
      void vscode.window.showErrorMessage(this.tr(
        `История проекта поддерживается только в проверенных версиях Codex ${verifiedVersionText()}. Текущая версия: ${version}.`,
        `Project History requires a verified Codex version ${verifiedVersionText()}. Installed version: ${version}.`));
      return;
    }
    try {
      await extension.activate();
      const resource = vscode.Uri.from({ scheme: 'openai-codex', authority: 'route', path: `/local/${entry.id}` });
      await vscode.commands.executeCommand('vscode.openWith', resource, OFFICIAL_EDITOR, {
        viewColumn: vscode.ViewColumn.Active,
        preview: false,
      });
    } catch {
      void vscode.window.showErrorMessage(this.tr(
        'Не удалось открыть выбранный диалог в Codex.',
        'Could not open the selected conversation in Codex.'));
    }
  }

  dispose(): void {
    this.subscription.dispose();
  }
}

function titleOf(entry: HistoryEntry, ru: boolean): string {
  return entry.name || entry.title || (ru ? 'Без названия' : 'Untitled');
}

function formatUpdatedAt(updatedAt: number | null, ru: boolean): string {
  const unknown = ru ? 'Дата неизвестна' : 'Date unknown';
  if (updatedAt === null) return unknown;
  const date = new Date(updatedAt);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(ru ? 'ru-RU' : 'en-US') : unknown;
}

function failureText(code: HistoryFailureCode, ru: boolean): string {
  if (code === 'missing') return ru
    ? 'Локальный индекс Codex не найден. Откройте Codex, чтобы он создал историю, и повторите.'
    : 'The local Codex index was not found. Open Codex so it creates history, then try again.';
  if (code === 'unsupported') return ru
    ? 'Формат локальной истории этой версии Codex пока не поддерживается Companion.'
    : 'Companion does not yet support the local history format of this Codex version.';
  if (code === 'busy') return ru
    ? 'Индекс Codex сейчас занят. Повторите через несколько секунд.'
    : 'The Codex index is busy. Try again in a few seconds.';
  if (code === 'timeout') return ru
    ? 'Чтение истории проекта заняло слишком много времени. Повторите позже.'
    : 'Reading project history took too long. Try again later.';
  return ru
    ? 'Не удалось прочитать локальную историю Codex.'
    : 'Could not read local Codex history.';
}

function verifiedVersionText(): string {
  return [...VERIFIED_EDITOR_VERSIONS].join(' / ');
}
