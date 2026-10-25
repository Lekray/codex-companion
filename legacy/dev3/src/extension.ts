import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { WindowsNotifications } from './windowsNotifications';
import { AppServerClient } from './appServer';
import { Sessions, type Session, type SavedTab, isTaskActive, record, tabLabel } from './session';
import { chatHtml } from './webview';
import { parseQuotas, type QuotaBucket } from './quotas';
import { quotaText } from './formatQuotas';

const viewType = 'codexCompanion.chat';
const storageKey = 'companion.tabs.v1';
let cleanup: (() => Promise<void>) | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const ru = vscode.env.language.toLowerCase().startsWith('ru');
  const tr = (russian: string, english: string) => ru ? russian : english;
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const project = vscode.workspace.name ?? (cwd ? basename(cwd) : 'Codex');
  const panels = new Map<string, vscode.WebviewPanel>();
  let saved: SavedTab[] = context.workspaceState.get<SavedTab[]>(storageKey, []).filter(t => typeof t.id === 'string' && typeof t.title === 'string');
  let counter = context.workspaceState.get<number>('companion.counter', 0);
  let client: AppServerClient | undefined;
  let sessions: Sessions | undefined;
  let connection: Promise<Sessions> | undefined;
  let shuttingDown = false;
  let ready = false;
  let quotas: QuotaBucket[] = [];
  let quotaUpdated = 0;
  let quotaFailed = false;
  let refreshing = false;
  const windowsNotifications = new WindowsNotifications();
  context.subscriptions.push(windowsNotifications);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.name = 'Codex Companion';
  status.command = 'codexCompanion.refreshQuotas';
  status.text = 'Codex · …';
  status.show();
  context.subscriptions.push(status);

  const persist = (): Thenable<void> => {
    if (sessions) saved = [...sessions.all.values()].map(s => ({ id: s.id, title: s.title, open: s.open, ...(s.threadId ? { threadId: s.threadId } : {}) }));
    return context.workspaceState.update(storageKey, saved);
  };
  const showError = (error: unknown) => void vscode.window.showErrorMessage(`Codex: ${error instanceof Error ? error.message : tr('Ошибка', 'Error')}`);
  const update = (session: Session): void => {
    if (sessions?.all.get(session.id) !== session) return;
    const panel = panels.get(session.id);
    if (panel) {
      panel.title = tabLabel(session);
      void panel.webview.postMessage({ type: 'state', session });
    }
  };
  const notify = (session: Session, kind: 'done' | 'error' | 'waiting'): void => {
    if (shuttingDown || sessions?.all.get(session.id) !== session) return;
    const message = { done: tr('Задача завершена', 'Task completed'), error: tr('Ошибка задачи', 'Task failed'), waiting: tr('Нужен ответ или подтверждение', 'Input or approval needed') }[kind];
    const focus = async (): Promise<void> => {
      await openPanel(session.id);
      // Runs in the originating extension host, so it focuses the correct VS Code window.
      const commands = await vscode.commands.getCommands(true);
      if (commands.includes('workbench.action.focusWindow')) await vscode.commands.executeCommand('workbench.action.focusWindow');
    };
    if (vscode.window.state.focused) {
      const button = tr('Открыть', 'Open');
      void vscode.window.showInformationMessage(`${project} · ${session.title}: ${message}`, button).then(value => { if (value === button) void focus().catch(showError); });
    } else if (process.platform === 'win32' && vscode.workspace.getConfiguration('codexCompanion').get('windowsNotifications', true)) {
      const notification = { title: `${project} · ${session.title}`, message,
        id: randomInt(1, 2147483647),
        sound: vscode.workspace.getConfiguration('codexCompanion').get('notificationSound', false),
      };
      void windowsNotifications.show(notification).then(outcome => {
        if (!shuttingDown && outcome === 'activated') return focus();
      }).catch(() => showError(tr('Не удалось обработать уведомление Windows.', 'Could not handle Windows notification.')));
    }
  };

  function executable(): string {
    const setting = vscode.workspace.getConfiguration('codexCompanion').get<string>('cliPath', '').trim();
    if (setting) return setting;
    const official = vscode.extensions.getExtension('openai.chatgpt');
    if (official && process.platform === 'win32') {
      const path = join(official.extensionPath, 'bin', process.arch === 'arm64' ? 'windows-aarch64' : 'windows-x86_64', 'codex.exe');
      if (existsSync(path)) return path;
    }
    return 'codex';
  }

  async function connect(): Promise<Sessions> {
    if (!cwd) throw new Error(tr('Сначала откройте папку проекта.', 'Open a project folder first.'));
    if (!vscode.workspace.isTrusted) throw new Error(tr('Для запуска Codex требуется доверие к рабочей папке.', 'Trust this workspace before starting Codex.'));
    if (vscode.env.remoteName || process.platform !== 'win32') throw new Error(tr('Эта версия рассчитана на локальный Windows.', 'This version supports local Windows only.'));
    if (connection) return connection;
    connection = (async () => {
      await persist();
      const previous = sessions?.all;
      sessions?.dispose();
      await client?.dispose();
      client = new AppServerClient({ executable: executable(), cwd, experimentalApi: true });
      await client.start();
      sessions = new Sessions(client, cwd, saved, update, notify);
      for (const session of sessions.all.values()) {
        const old = previous?.get(session.id);
        if (old) {
          session.items = old.items.map(item => ({ ...item }));
          session.status = old.status === 'running' || old.status === 'waiting' ? 'error' : old.status;
        }
        update(session);
      }
      ready = true;
      client.onClose(() => {
        ready = false;
        connection = undefined;
        quotaFailed = true;
        renderQuota();
      });
      client.onNotification(method => {
        if (method === 'account/rateLimits/updated' || method === 'account/updated') void refreshQuotas();
      });
      return sessions;
    })();
    try { return await connection; }
    catch (error) { connection = undefined; ready = false; throw error; }
  }

  function renderQuota(): void {
    const stale = quotaFailed || (!!quotaUpdated && Date.now() - quotaUpdated > 120_000);
    status.text = quotas.length ? quotaText(quotas, ru) + (stale ? ' ⚠' : '') : `Codex · ${quotaFailed ? tr('квоты недоступны', 'quotas unavailable') : '…'}`;
    status.tooltip = tr('Нажмите для обновления.', 'Click to refresh.') + (quotaUpdated ? '\n' + new Date(quotaUpdated).toLocaleString(ru ? 'ru-RU' : 'en-US') : '') + (stale ? '\n' + tr('Данные устарели.', 'Data is stale.') : '');
  }

  async function refreshQuotas(): Promise<void> {
    if (refreshing || shuttingDown) return;
    refreshing = true;
    try {
      await connect();
      quotas = parseQuotas(await client!.request('account/rateLimits/read'));
      quotaUpdated = Date.now();
      quotaFailed = false;
    } catch { quotaFailed = true; }
    finally { refreshing = false; renderQuota(); }
  }

  async function closePanel(id: string): Promise<void> {
    panels.delete(id);
    if (shuttingDown) return;
    const session = sessions?.all.get(id);
    if (!session) return;
    session.open = false;
    if (isTaskActive(session)) {
      const background = tr('Продолжить в фоне', 'Continue in background');
      const stop = tr('Остановить', 'Stop');
      const cancel = tr('Отмена', 'Cancel');
      const choice = await vscode.window.showWarningMessage(tr(`«${session.title}» ещё работает.`, `“${session.title}” is still running.`), { modal: true }, background, stop, cancel);
      if (choice === stop) {
        try { await sessions!.stop(session); }
        catch (error) { showError(error); await openPanel(id); }
      } else if (choice !== background) await openPanel(id);
    }
    await persist();
  }

  function attach(panel: vscode.WebviewPanel, id: string): void {
    panels.set(id, panel);
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] };
    panel.webview.html = chatHtml(panel.webview, vscode.Uri.joinPath(context.extensionUri, 'media/chat.js'), vscode.Uri.joinPath(context.extensionUri, 'media/chat.css'), ru, id);
    panel.onDidDispose(() => void closePanel(id).catch(showError), undefined, context.subscriptions);
    panel.webview.onDidReceiveMessage(async (raw: unknown) => {
      const message = record(raw);
      try {
        const manager = await connect();
        const session = manager.all.get(id);
        if (!session) return;
        if (message.type === 'ready') update(session);
        else if (message.type === 'send' && typeof message.text === 'string' && message.text.trim() && message.text.length <= 1_000_000) {
          const sent = await manager.send(session, message.text);
          await persist();
          void panel.webview.postMessage({ type: sent ? 'sent' : 'sendFailed', text: message.text });
        } else if (message.type === 'stop') await manager.stop(session);
        else if (message.type === 'answer' && (typeof message.requestId === 'string' || typeof message.requestId === 'number') && typeof message.decision === 'string') {
          manager.answer(session, message.requestId, message.decision, record(message.answers));
        }
      } catch (error) { void panel.webview.postMessage({ type: 'sendFailed' }); showError(error); }
    }, undefined, context.subscriptions);
  }

  async function openPanel(id?: string, restoredPanel?: vscode.WebviewPanel): Promise<void> {
    const manager = await connect();
    let session = id ? manager.all.get(id) : undefined;
    if (!session) {
      const number = ++counter;
      await context.workspaceState.update('companion.counter', number);
      session = manager.add({ id: randomUUID(), title: `Codex ${number}`, open: true });
    }
    const existing = panels.get(session.id);
    if (existing) { restoredPanel?.dispose(); existing.reveal(); return; }
    session.open = true;
    const panel = restoredPanel ?? vscode.window.createWebviewPanel(viewType, tabLabel(session), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    attach(panel, session.id);
    await persist();
    update(session);
    // App Server does not durably store empty threads. Allocate the actual thread
    // on the first explicit Send; an empty tab has its own persisted local ID.
    if (session.threadId && !session.loaded && !session.items.length) await manager.history(session);
  }

  async function selected(): Promise<Session | undefined> {
    const manager = await connect();
    for (const [id, panel] of panels) if (panel.active) return manager.all.get(id);
    const choice = await vscode.window.showQuickPick([...manager.all.values()].map(s => ({ label: tabLabel(s), id: s.id })));
    return choice ? manager.all.get(choice.id) : undefined;
  }
  const command = (id: string, action: (...args: unknown[]) => Promise<unknown>): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, (...args: unknown[]) => action(...args).catch(showError)));
  };
  command('codexCompanion.open', () => openPanel());
  command('codexCompanion.rename', async (requestedTitle?: unknown) => {
    const session = await selected();
    if (!session) return;
    const invalid = (value: string) => !value.trim() || value.length > 80 || /[\r\n\x00-\x1f]/.test(value) ? tr('Введите название от 1 до 80 символов.', 'Enter a name of 1–80 characters.') : undefined;
    const title = typeof requestedTitle === 'string' ? requestedTitle : await vscode.window.showInputBox({ title: tr('Название вкладки Codex', 'Codex tab name'), value: session.title, validateInput: invalid });
    if (title === undefined) return;
    if (invalid(title)) throw new Error(invalid(title));
    session.title = title.trim();
    update(session);
    await persist();
  });
  command('codexCompanion.history', async () => {
    const manager = await connect();
    const choice = await vscode.window.showQuickPick([...manager.all.values()].reverse().map(s => ({ label: tabLabel(s), description: s.open ? tr('Открыта', 'Open') : '', id: s.id })), { placeHolder: tr('Диалоги этого проекта', 'Conversations in this project') });
    if (choice) await openPanel(choice.id);
  });
  command('codexCompanion.refreshQuotas', refreshQuotas);
  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer(viewType, {
    async deserializeWebviewPanel(panel, state: unknown) {
      const id = record(state).id;
      if (typeof id !== 'string' || !saved.some(s => s.id === id)) { panel.dispose(); return; }
      try { await openPanel(id, panel); }
      catch (error) { panel.dispose(); showError(error); }
    },
  }));

  // Saved metadata also restores tabs if VS Code did not serialize a webview.
  const restore = setTimeout(() => {
    if (shuttingDown || !cwd || !vscode.workspace.isTrusted || !saved.some(s => s.open)) return;
    void (async () => {
      await connect();
      for (const tab of saved.filter(s => s.open)) if (!panels.has(tab.id)) await openPanel(tab.id);
    })().catch(showError);
  }, 1500);
  const poll = setInterval(() => { if (ready) void refreshQuotas(); }, 60_000);
  const countdown = setInterval(renderQuota, 30_000);
  if (cwd && vscode.workspace.isTrusted) void refreshQuotas();
  cleanup = async () => {
    shuttingDown = true;
    windowsNotifications.dispose();
    clearTimeout(restore); clearInterval(poll); clearInterval(countdown);
    try { await persist(); }
    finally { sessions?.dispose(); await client?.dispose(); }
  };
}

export async function deactivate(): Promise<void> { await cleanup?.(); cleanup = undefined; }
