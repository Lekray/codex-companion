import * as vscode from 'vscode';
import type { QuotaMonitor, QuotaState } from './quotaMonitor';
import { quotaFreshness, type QuotaFreshness } from './quotaDisplay';
import { quotaReport, quotaSections, quotaStamp } from './quotaPresentation';
import { ClosedOfficialTabs } from './officialTabs';

function freshnessLabel(freshness: QuotaFreshness, ru: boolean): string {
  switch (freshness) {
    case 'fresh': return ru ? 'актуально' : 'fresh';
    case 'stale': return ru ? 'устарело' : 'stale';
    case 'refresh-needed': return ru ? 'нужно обновить' : 'refresh-needed';
    case 'unavailable': return ru ? 'недоступно' : 'unavailable';
  }
}

function updatedLabel(state: QuotaState, ru: boolean): string {
  if (state.updatedAt === null) return ru ? 'никогда' : 'never';
  if (!Number.isFinite(state.updatedAt) || state.updatedAt < 0) return ru ? 'неизвестно' : 'unknown';
  return quotaStamp(state.updatedAt, true);
}

export function quotaTooltip(state: QuotaState, ru: boolean, now = Date.now()): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = { enabledCommands: [
    'codexCompanion.usage',
    'codexCompanion.open',
    'codexCompanion.refreshQuotas',
    'codexCompanion.openChats',
  ] };
  md.appendMarkdown('**Codex**\n\n');
  const freshness = quotaFreshness(state, now);
  const sections = quotaSections(state, ru, now);
  if (freshness === 'stale') md.appendText(ru ? '⚠ Данные устарели.\n\n' : '⚠ Data is stale.\n\n');
  if (freshness === 'refresh-needed') md.appendText(ru
    ? '↻ Время сброса прошло; нужно обновить данные. Показан последний снимок сервера.\n\n'
    : '↻ A reset time has passed; refresh needed. Showing the last server snapshot.\n\n');
  if (freshness === 'unavailable') md.appendText(ru ? 'Лимиты недоступны.\n\n' : 'Quotas unavailable.\n\n');
  if (!sections.length && freshness !== 'unavailable') {
    md.appendText(ru ? 'Метрические окна квот не сообщены.\n\n' : 'No metered quota windows were reported.\n\n');
  }
  for (const section of sections) {
    md.appendText(section.title);
    md.appendMarkdown(`\n\n**${section.usedPercent}%** ${ru ? 'использовано' : 'used'} · ` +
      `**${section.remainingPercent}%** ${ru ? 'осталось' : 'remaining'}\n\n`);
    const filled = Math.round(Math.min(100, Math.max(0, section.usedPercent)) / 100 * 16);
    md.appendMarkdown('`' + '█'.repeat(filled) + '░'.repeat(16 - filled) + '`\n\n');
    md.appendText(section.resetText + (section.paceText ? '\n' + section.paceText : ''));
    md.appendMarkdown('\n\n---\n\n');
  }
  for (const bucket of state.buckets) {
    const credits = bucket.credits;
    if (!credits || (!credits.unlimited && credits.balance === null)) continue;
    const name = ` (${bucket.name || bucket.id})`;
    const value = credits.unlimited ? '∞' : credits.balance;
    md.appendText(`${ru ? 'Кредиты' : 'Credits'}${name}: ${value}\n\n`);
  }
  md.appendText(`${ru ? 'Актуальность' : 'Freshness'}: ${freshnessLabel(freshness, ru)}\n\n`);
  md.appendText(`${ru ? 'Обновлено' : 'Updated'}: ${updatedLabel(state, ru)}\n\n`);
  md.appendMarkdown(`[$(graph) ${ru ? 'Отчёт по лимитам' : 'Usage report'}](command:codexCompanion.usage) · ` +
    `[$(refresh) ${ru ? 'Обновить' : 'Refresh'}](command:codexCompanion.refreshQuotas)\n\n`);
  md.appendMarkdown(`[$(add) ${ru ? 'Новая вкладка' : 'New tab'}](command:codexCompanion.open) · ` +
    `[$(comment-discussion) ${ru ? 'Открыть чаты' : 'Open chats'}](command:codexCompanion.openChats)`);
  return md;
}

interface MenuItem extends vscode.QuickPickItem { action?: 'refresh' | 'open' | 'reopen' | 'history' | 'chats' }

export class QuotaUi implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly changes = new vscode.EventEmitter<vscode.Uri>();
  private readonly closed: ClosedOfficialTabs;
  private readonly reportUri = vscode.Uri.parse('codex-companion-report:/Codex Usage.txt');
  private menuOpen = false;

  constructor(context: vscode.ExtensionContext, private readonly monitor: QuotaMonitor, private readonly ru: boolean) {
    this.closed = new ClosedOfficialTabs(context.workspaceState);
    this.subscriptions.push(this.closed, this.changes,
      vscode.workspace.registerTextDocumentContentProvider('codex-companion-report', {
        onDidChange: this.changes.event,
        provideTextDocumentContent: () => quotaReport(this.monitor.state, this.ru),
      }),
      vscode.commands.registerCommand('codexCompanion.menu', () => this.showMenu()),
      vscode.commands.registerCommand('codexCompanion.reopenClosed', () => this.closed.reopen(this.ru)),
      vscode.commands.registerCommand('codexCompanion.usage', async () => {
        await this.monitor.refresh();
        this.refresh();
        await vscode.window.showTextDocument(this.reportUri, { preview: false, viewColumn: vscode.ViewColumn.Beside });
      }),
    );
  }

  refresh(): void { this.changes.fire(this.reportUri); }

  private async showMenu(): Promise<void> {
    if (this.menuOpen) return;
    this.menuOpen = true;
    try {
      while (true) {
        const items: MenuItem[] = [
          { label: `$(refresh) ${this.ru ? 'Обновить лимиты' : 'Refresh quota'}`, action: 'refresh' },
          { label: `$(add) ${this.ru ? 'Новая вкладка' : 'New tab'}`, action: 'open' },
          { label: `$(comment-discussion) ${this.ru ? 'Открыть чаты' : 'Open chats'}`, action: 'chats' },
          { label: `$(history) ${this.ru ? 'История проекта' : 'Project History'}`, action: 'history' },
          { label: `$(history) ${this.ru ? 'Вернуть закрытую вкладку' : 'Reopen closed tab'}`, action: 'reopen' },
        ];
        const picked = await vscode.window.showQuickPick(items, { title: 'Codex', matchOnDescription: true });
        if (!picked) return;
        if (picked.action === 'refresh') { await this.monitor.refresh(); continue; }
        if (picked.action === 'open') await vscode.commands.executeCommand('codexCompanion.open');
        if (picked.action === 'chats') await vscode.commands.executeCommand('codexCompanion.openChats');
        if (picked.action === 'history') await vscode.commands.executeCommand('codexCompanion.projectHistory');
        if (picked.action === 'reopen') await this.closed.reopen(this.ru);
        return;
      }
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    } finally { this.menuOpen = false; }
  }

  async flush(): Promise<void> { await this.closed.flush(); }
  dispose(): void { this.subscriptions.forEach(subscription => subscription.dispose()); }
}
