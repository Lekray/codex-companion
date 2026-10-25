import {
  isStaleSameInstance,
  parseOpenChatsState,
  type OpenChatStatus,
  type OpenChatTab,
  type OpenChatsSnapshot,
} from './openChatsModel';

export const NEXT_WAITING_CHAT_COMMAND = 'codexCompanion.nextWaitingChat';
export const NEXT_ATTENTION_CHAT_COMMAND = 'codexCompanion.nextAttentionChat';

export interface DisposableLike {
  dispose(): void;
}

export interface AttentionStatusItem {
  text: string;
  tooltip: unknown;
  command: unknown;
  show(): void;
  hide(): void;
  dispose(): void;
}

export interface AttentionFocusPayload {
  panelId: string;
  threadId?: string;
}

export interface AttentionUiDependencies {
  /** Main supplies trusted + local + runtime-ready compatibility gate. */
  allowed(): boolean;
  /** Execute chatgpt.companion.v1.getState for the current window. */
  getState(): PromiseLike<unknown>;
  /** Execute chatgpt.companion.v1.focusTab with exactly this payload. */
  focusTab(payload: AttentionFocusPayload): PromiseLike<unknown>;
  /** vscode.window.createStatusBarItem, already configured by Main. */
  createStatusItem(): AttentionStatusItem;
  /** Combined tabGroups.onDidChangeTabs / groups subscription. */
  onDidChangeTabs(listener: () => void): DisposableLike;
  registerCommand(command: string, handler: () => unknown): DisposableLike;
  showWarning(message: string): void;
  showError(message: string): void;
  onError?: ((error: unknown) => void) | undefined;
}

type AttentionKind = 'waiting' | 'attention';
const TAB_SETTLE_MS = 100;

const TEXTS = {
  ru: {
    gate: 'Переход к чатам недоступен: нужен доверенный локальный проект и проверенная совместимость Codex.',
    unavailable: 'Метаданные открытых чатов Codex недоступны. Проверьте совместимость версии Codex.',
    closed: 'Этот чат уже закрыт.',
    changed: 'Чат изменился. Повторите команду, чтобы выбрать актуальный чат.',
    noWaiting: 'Нет чатов, ожидающих ответа.',
    noAttention: 'Нет чатов, требующих внимания.',
    tooltip: (waiting: number, error: number, running: number): string =>
      `Ожидают: ${waiting}\nОшибки: ${error}\nВыполняются: ${running}\n`
      + 'Нажмите, чтобы перейти к следующему ожидающему чату.',
  },
  en: {
    gate: 'Chat navigation is unavailable: a trusted local project and a compatible Codex version are required.',
    unavailable: 'The metadata of open Codex chats is unavailable. Check the Codex version compatibility.',
    closed: 'This chat is already closed.',
    changed: 'The chat changed. Run the command again to select the current chat.',
    noWaiting: 'There are no chats waiting for a reply.',
    noAttention: 'There are no chats that need attention.',
    tooltip: (waiting: number, error: number, running: number): string =>
      `Waiting: ${waiting}\nErrors: ${error}\nRunning: ${running}\n`
      + 'Click to focus the next waiting chat.',
  },
} as const;

function attentionPriority(status: OpenChatStatus): number {
  if (status === 'waiting') return 0;
  if (status === 'error') return 1;
  return 2;
}

function matchesKind(kind: AttentionKind, status: OpenChatStatus): boolean {
  return kind === 'waiting'
    ? status === 'waiting'
    : status === 'waiting' || status === 'error';
}

/**
 * Compact attention counter and next-chat navigation. It only reads metadata
 * from the current window bridge, never opens, resumes or creates a chat, and
 * leaves all tab changes to the official focus command.
 */
export class AttentionUi implements DisposableLike {
  private readonly texts: typeof TEXTS.ru | typeof TEXTS.en;
  private readonly statusItem: AttentionStatusItem;
  private readonly tabsSubscription: DisposableLike;
  private readonly commandSubscriptions: DisposableLike[];
  private readonly cursors = new Map<AttentionKind, string>();
  private lastState: Pick<OpenChatsSnapshot, 'instanceId' | 'sequence'> | undefined;
  private cursorInstanceId: string | undefined;
  private disposed = false;
  private busy = false;
  private refreshPromise: Promise<void> | undefined;
  private refreshQueued = false;
  private refreshToken = 0;
  private commandToken = 0;
  private stateChain: Promise<void> = Promise.resolve();
  private tabRefreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: AttentionUiDependencies, private readonly ru: boolean) {
    this.texts = ru ? TEXTS.ru : TEXTS.en;
    this.statusItem = deps.createStatusItem();
    this.statusItem.command = NEXT_WAITING_CHAT_COMMAND;
    this.hideStatus();
    this.tabsSubscription = deps.onDidChangeTabs(() => this.refreshAfterTabsSettle());
    this.commandSubscriptions = [
      deps.registerCommand(NEXT_WAITING_CHAT_COMMAND, () => this.nextWaiting()),
      deps.registerCommand(NEXT_ATTENTION_CHAT_COMMAND, () => this.nextAttention()),
    ];
  }

  /** Event, tab-change and compatibility trigger. Overlapping calls coalesce. */
  refresh(): Promise<void> {
    return this.requestRefresh();
  }

  async nextWaiting(): Promise<void> {
    await this.focusNext('waiting');
  }

  async nextAttention(): Promise<void> {
    await this.focusNext('attention');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.tabRefreshTimer !== undefined) clearTimeout(this.tabRefreshTimer);
    this.tabRefreshTimer = undefined;
    this.refreshQueued = false;
    this.refreshToken++;
    this.commandToken++;
    this.busy = false;
    this.invalidate();
    try {
      this.tabsSubscription.dispose();
    } catch {
      // Disposal is best effort.
    }
    for (const subscription of this.commandSubscriptions) {
      try {
        subscription.dispose();
      } catch {
        // Disposal is best effort.
      }
    }
    try {
      this.statusItem.dispose();
    } catch {
      // Disposal is best effort.
    }
  }

  private requestRefresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.allowed()) {
      this.invalidate();
      return Promise.resolve();
    }
    if (this.refreshPromise) {
      this.refreshQueued = true;
      return this.refreshPromise;
    }
    const token = ++this.refreshToken;
    this.refreshPromise = this.performRefresh(token).finally(() => {
      this.refreshPromise = undefined;
      if (!this.refreshQueued) return;
      this.refreshQueued = false;
      if (!this.disposed) void this.requestRefresh();
    });
    return this.refreshPromise;
  }

  private refreshAfterTabsSettle(): void {
    if (this.disposed) return;
    if (this.tabRefreshTimer !== undefined) clearTimeout(this.tabRefreshTimer);
    // VS Code can announce a tab close before the other extension receives its
    // panel disposal. Read once after that event has settled, without polling.
    this.tabRefreshTimer = setTimeout(() => {
      this.tabRefreshTimer = undefined;
      void this.refresh();
    }, TAB_SETTLE_MS);
  }

  private async performRefresh(token: number): Promise<void> {
    if (!this.allowed()) {
      this.invalidate();
      return;
    }
    let snapshot: OpenChatsSnapshot | undefined;
    try {
      snapshot = await this.readSnapshot();
    } catch (error) {
      if (this.isCurrentRefresh(token)) {
        this.invalidate();
        this.report(error);
      }
      return;
    }
    if (!this.isCurrentRefresh(token)) return;
    if (!this.allowed()) {
      this.invalidate();
      return;
    }
    if (!snapshot) {
      this.invalidate();
      return;
    }
    this.applySnapshot(snapshot);
  }

  private async focusNext(kind: AttentionKind): Promise<void> {
    if (this.disposed || this.busy) return;
    if (!this.allowed()) {
      this.invalidate();
      this.deps.showError(this.texts.gate);
      return;
    }

    this.busy = true;
    const token = ++this.commandToken;
    try {
      let first: OpenChatsSnapshot | undefined;
      try {
        first = await this.readSnapshot();
      } catch (error) {
        if (this.isCurrentCommand(token)) {
          this.invalidate();
          this.report(error);
          this.deps.showWarning(this.texts.unavailable);
        }
        return;
      }
      if (!this.isCurrentCommand(token)) return;
      if (!this.allowed()) {
        this.invalidate();
        this.deps.showError(this.texts.gate);
        return;
      }
      if (!first) {
        this.invalidate();
        this.deps.showWarning(this.texts.unavailable);
        return;
      }
      if (!this.applySnapshot(first)) {
        this.deps.showWarning(this.texts.changed);
        return;
      }

      const target = this.choose(kind, first);
      if (!target) {
        this.deps.showWarning(kind === 'waiting' ? this.texts.noWaiting : this.texts.noAttention);
        return;
      }
      // Advance on every attempt so a chat that keeps changing cannot pin the
      // cycle to the same stale target.
      this.cursors.set(kind, target.panelId);

      // A second metadata read mirrors OpenChatsUi verification: a chat that
      // closed, moved to another thread/route or belongs to another bridge
      // instance is never focused.
      let verified: OpenChatsSnapshot | undefined;
      try {
        verified = await this.readSnapshot();
      } catch (error) {
        if (this.isCurrentCommand(token)) {
          this.invalidate();
          this.report(error);
          this.deps.showWarning(this.texts.unavailable);
        }
        return;
      }
      if (!this.isCurrentCommand(token)) return;
      if (!this.allowed()) {
        this.invalidate();
        this.deps.showError(this.texts.gate);
        return;
      }
      if (!verified) {
        this.invalidate();
        this.deps.showWarning(this.texts.unavailable);
        return;
      }
      if (isStaleSameInstance(this.lastState, verified) || !this.applySnapshot(verified)) {
        this.deps.showWarning(this.texts.changed);
        return;
      }
      if (verified.instanceId !== first.instanceId) {
        this.deps.showWarning(this.texts.changed);
        return;
      }

      const current = verified.tabs.find(tab => tab.panelId === target.panelId);
      if (!current) {
        this.deps.showWarning(this.texts.closed);
        return;
      }
      if (current.threadId !== target.threadId || current.route !== target.route
        || !matchesKind(kind, current.status)) {
        this.deps.showWarning(this.texts.changed);
        return;
      }

      const payload: AttentionFocusPayload = current.threadId === null
        ? { panelId: current.panelId }
        : { panelId: current.panelId, threadId: current.threadId };
      let focused = false;
      try {
        focused = (await this.deps.focusTab(payload)) === true;
      } catch {
        focused = false;
      }
      if (!this.isCurrentCommand(token)) return;
      if (!focused) {
        this.deps.showWarning(this.texts.closed);
        return;
      }
    } finally {
      this.busy = false;
    }
  }

  private choose(kind: AttentionKind, snapshot: OpenChatsSnapshot): OpenChatTab | undefined {
    const candidates = snapshot.tabs.filter(tab => matchesKind(kind, tab.status));
    if (!candidates.length) return undefined;
    candidates.sort((left, right) => attentionPriority(left.status) - attentionPriority(right.status));
    const last = this.cursors.get(kind);
    const index = last === undefined ? -1 : candidates.findIndex(tab => tab.panelId === last);
    return candidates[(index + 1) % candidates.length];
  }

  private applySnapshot(snapshot: OpenChatsSnapshot): boolean {
    if (isStaleSameInstance(this.lastState, snapshot)) return false;
    if (this.cursorInstanceId !== snapshot.instanceId) {
      this.cursors.clear();
      this.cursorInstanceId = snapshot.instanceId;
    }
    this.lastState = { instanceId: snapshot.instanceId, sequence: snapshot.sequence };
    this.render(snapshot);
    return true;
  }

  private render(snapshot: OpenChatsSnapshot): void {
    let waiting = 0;
    let error = 0;
    let running = 0;
    for (const tab of snapshot.tabs) {
      if (tab.status === 'waiting') waiting++;
      else if (tab.status === 'error') error++;
      else if (tab.status === 'running') running++;
    }
    if (waiting === 0) {
      this.hideStatus();
      return;
    }
    this.statusItem.text = `[? ${waiting}]`;
    this.statusItem.tooltip = this.texts.tooltip(waiting, error, running);
    this.statusItem.show();
  }

  private invalidate(): void {
    this.hideStatus();
  }

  private hideStatus(): void {
    try {
      this.statusItem.hide();
    } catch {
      // The native status bar item may already be gone during shutdown.
    }
  }

  private allowed(): boolean {
    try {
      return this.deps.allowed() === true;
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  private isCurrentRefresh(token: number): boolean {
    return !this.disposed && token === this.refreshToken;
  }

  private isCurrentCommand(token: number): boolean {
    return !this.disposed && token === this.commandToken;
  }

  /**
   * Single serialization point for every bridge read. A rejected request is
   * swallowed in the chain so one bridge failure cannot poison later calls.
   */
  private loadRawState(): Promise<unknown> {
    const request = this.stateChain.then(() => this.deps.getState());
    this.stateChain = request.then(() => undefined, () => undefined);
    return request;
  }

  private async readSnapshot(): Promise<OpenChatsSnapshot | undefined> {
    const raw = await this.loadRawState();
    const parsed = parseOpenChatsState(raw);
    return parsed.ok ? parsed.snapshot : undefined;
  }

  private report(error: unknown): void {
    try {
      this.deps.onError?.(error);
    } catch {
      // Diagnostics must not break navigation.
    }
  }
}
