import {
  buildOpenChatItems,
  isStaleSameInstance,
  parseOpenChatsState,
  type OpenChatItem,
  type OpenChatsSnapshot,
} from './openChatsModel';

export const OPEN_CHATS_COMMAND = 'codexCompanion.openChats';
export const OPEN_CHATS_POLL_INTERVAL_MS = 1000;

export interface DisposableLike {
  dispose(): void;
}

export interface OpenChatQuickPick {
  title: string | undefined;
  placeholder: string | undefined;
  matchOnDescription: boolean;
  matchOnDetail: boolean;
  busy: boolean;
  value: string;
  items: readonly OpenChatItem[];
  activeItems: readonly OpenChatItem[];
  onDidAccept(listener: () => void): DisposableLike;
  onDidHide(listener: () => void): DisposableLike;
  show(): void;
  hide(): void;
  dispose(): void;
}

export interface OpenChatsTimer {
  set(handler: () => void, timeout: number): unknown;
  clear(handle: unknown): void;
}

export interface OpenChatsUiDependencies {
  /** Main supplies trusted + local + verified-compatibility gate. */
  allowed(): boolean;
  /** Execute chatgpt.companion.v1.getState and return its raw result. */
  getState(): PromiseLike<unknown>;
  /** Execute chatgpt.companion.v1.focusTab with exactly this payload. */
  focusTab(payload: { panelId: string; threadId?: string }): PromiseLike<unknown>;
  /** vscode.window.createQuickPick. */
  createQuickPick(): OpenChatQuickPick;
  /** Combined tabGroups.onDidChangeTabs / groups subscription. */
  onDidChangeTabs(listener: () => void): DisposableLike;
  showError(message: string): void;
  showWarning(message: string): void;
  /** Optional so Main may register codexCompanion.openChats itself. */
  registerCommand?: ((command: string, handler: () => void) => DisposableLike) | undefined;
  /** Native timers by default; injectable for deterministic tests. */
  timer?: OpenChatsTimer | undefined;
}

const TEXTS = {
  ru: {
    title: 'Открытые чаты текущего окна',
    search: 'Поиск по названию чата',
    empty: 'В этом окне нет открытых чатов Codex.',
    gate: 'Список открытых чатов недоступен: нужен доверенный локальный проект и совместимая версия Codex.',
    unavailable: 'Мост открытых чатов Codex недоступен. Проверьте совместимость версии Codex.',
    closed: 'Этот чат уже закрыт.',
    changed: 'Чат изменился. Откройте список и выберите чат снова.',
  },
  en: {
    title: 'Open Chats in This Window',
    search: 'Search chats by title',
    empty: 'There are no open Codex chats in this window.',
    gate: 'Open Chats is unavailable: a trusted local project and a compatible Codex version are required.',
    unavailable: 'The Codex open-chats bridge is unavailable. Check the Codex version compatibility.',
    closed: 'This chat is already closed.',
    changed: 'The chat changed. Open the list and select the chat again.',
  },
} as const;

const nativeTimer: OpenChatsTimer = {
  set: (handler, timeout) => setInterval(handler, timeout),
  clear: handle => clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * Native QuickPick controller for local open Codex chats. It owns no chat and
 * only reads metadata through the injected bridge, refreshing while visible.
 */
export class OpenChatsUi implements DisposableLike {
  private readonly texts: typeof TEXTS.ru | typeof TEXTS.en;
  private readonly timer: OpenChatsTimer;
  private readonly tabsSubscription: DisposableLike;
  private readonly commandSubscription: DisposableLike | undefined;
  private picker: OpenChatQuickPick | undefined;
  private pickerSubscriptions: DisposableLike[] = [];
  private lastState: Pick<OpenChatsSnapshot, 'instanceId' | 'sequence'> | undefined;
  private open = false;
  private disposed = false;
  private accepting = false;
  private refreshPromise: Promise<void> | undefined;
  private stateChain: Promise<void> = Promise.resolve();
  private refreshQueued = false;
  private token = 0;
  private polling = false;
  private timerHandle: unknown;
  private unavailableReported = false;

  constructor(private readonly deps: OpenChatsUiDependencies, private readonly ru: boolean) {
    this.texts = ru ? TEXTS.ru : TEXTS.en;
    this.timer = deps.timer ?? nativeTimer;
    this.tabsSubscription = deps.onDidChangeTabs(() => {
      if (this.open) void this.requestRefresh();
    });
    this.commandSubscription = deps.registerCommand?.(OPEN_CHATS_COMMAND, () => {
      void this.show();
    });
  }

  async show(): Promise<void> {
    if (this.disposed) return;
    if (!this.deps.allowed()) {
      this.deps.showError(this.texts.gate);
      return;
    }
    if (this.picker && this.open) {
      // Reuse the live picker: keeps its query, selection and subscriptions.
      this.picker.show();
      await this.requestRefresh();
      return;
    }
    if (this.picker) this.disposePicker();

    const picker = this.deps.createQuickPick();
    picker.title = this.texts.title;
    picker.placeholder = this.texts.search;
    picker.matchOnDescription = false;
    picker.matchOnDetail = false;
    picker.busy = true;
    picker.items = [];
    this.picker = picker;
    this.open = true;
    this.lastState = undefined;
    this.unavailableReported = false;
    this.pickerSubscriptions = [
      picker.onDidAccept(() => { void this.accept(picker.activeItems[0]); }),
      picker.onDidHide(() => { this.handleHide(); }),
    ];
    this.startPolling();
    picker.show();
    await this.requestRefresh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.open = false;
    this.token++;
    this.refreshQueued = false;
    this.stopPolling();
    this.tabsSubscription.dispose();
    this.commandSubscription?.dispose();
    this.disposePicker();
  }

  private async requestRefresh(): Promise<void> {
    if (this.disposed || !this.open) return;
    if (this.refreshPromise) {
      this.refreshQueued = true;
      return this.refreshPromise;
    }
    const token = ++this.token;
    this.refreshPromise = this.performRefresh(token).finally(() => {
      this.refreshPromise = undefined;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        if (!this.disposed && this.open) void this.requestRefresh();
      }
    });
    return this.refreshPromise;
  }

  private async performRefresh(token: number): Promise<void> {
    if (!this.deps.allowed()) { this.markUnavailable(); return; }
    let raw: unknown;
    try {
      raw = await this.loadRawState();
    } catch {
      if (this.isCurrent(token)) this.markUnavailable();
      return;
    }
    if (!this.isCurrent(token)) return;
    if (!this.deps.allowed()) { this.markUnavailable(); return; }
    const parsed = parseOpenChatsState(raw);
    if (!parsed.ok) {
      this.markUnavailable();
      return;
    }
    if (isStaleSameInstance(this.lastState, parsed.snapshot)) return;
    this.lastState = { instanceId: parsed.snapshot.instanceId, sequence: parsed.snapshot.sequence };
    this.render(parsed.snapshot);
  }

  private isCurrent(token: number): boolean {
    return !this.disposed && this.open && token === this.token;
  }

  private render(snapshot: OpenChatsSnapshot): void {
    const picker = this.picker;
    if (!picker) return;
    const activePanelId = picker.activeItems[0]?.panelId;
    const items = buildOpenChatItems(snapshot, this.ru);
    // Assigning items refreshes in place and never clears the search query.
    picker.items = items;
    if (activePanelId !== undefined) {
      const active = items.find(item => item.panelId === activePanelId);
      picker.activeItems = active ? [active] : [];
    }
    picker.placeholder = items.length ? this.texts.search : this.texts.empty;
    picker.busy = false;
    this.unavailableReported = false;
  }

  private markUnavailable(): void {
    const picker = this.picker;
    if (picker) {
      picker.items = [];
      picker.activeItems = [];
      picker.placeholder = this.texts.unavailable;
      picker.busy = false;
    }
    if (this.unavailableReported) return;
    this.unavailableReported = true;
    this.deps.showError(this.texts.unavailable);
  }

  private async accept(item: OpenChatItem | undefined): Promise<void> {
    if (this.disposed || !this.open || this.accepting || !item) return;
    this.accepting = true;
    this.open = false;
    this.token++;
    const focusToken = this.token;
    this.refreshQueued = false;
    this.stopPolling();
    try {
      this.picker?.hide();
    } catch {
      // The native picker may already be hidden; verification still applies.
    }
    try {
      await this.verifyAndFocus(item, focusToken);
    } finally {
      this.accepting = false;
    }
  }

  private async verifyAndFocus(item: OpenChatItem, token: number): Promise<void> {
    // Never overlap getState calls with a poll request that is still settling.
    if (this.refreshPromise) await this.refreshPromise;
    if (this.disposed || token !== this.token || !this.deps.allowed()) return;

    let raw: unknown;
    try {
      raw = await this.loadRawState();
    } catch {
      if (!this.disposed && token === this.token) this.deps.showError(this.texts.unavailable);
      return;
    }
    if (this.disposed || token !== this.token || !this.deps.allowed()) return;
    const parsed = parseOpenChatsState(raw);
    if (!parsed.ok) {
      this.deps.showError(this.texts.unavailable);
      return;
    }
    const snapshot = parsed.snapshot;
    if (isStaleSameInstance(this.lastState, snapshot)) {
      this.deps.showWarning(this.texts.changed);
      return;
    }
    this.lastState = { instanceId: snapshot.instanceId, sequence: snapshot.sequence };
    if (snapshot.instanceId !== item.instanceId) {
      this.deps.showWarning(this.texts.changed);
      return;
    }
    const current = snapshot.tabs.find(tab => tab.panelId === item.panelId);
    if (!current) {
      this.deps.showWarning(this.texts.closed);
      return;
    }
    if (current.threadId !== item.threadId || current.route !== item.route) {
      this.deps.showWarning(this.texts.changed);
      return;
    }
    const payload = current.threadId === null
      ? { panelId: current.panelId }
      : { panelId: current.panelId, threadId: current.threadId };
    let focused = false;
    try {
      focused = (await this.deps.focusTab(payload)) === true;
    } catch {
      focused = false;
    }
    if (!focused) this.deps.showWarning(this.texts.closed);
  }

  /**
   * Single serialization point for every bridge read, including focus
   * verification. A rejected request is swallowed in the chain so one bridge
   * failure cannot poison later refreshes.
   */
  private loadRawState(): Promise<unknown> {
    const request = this.stateChain.then(() => this.deps.getState());
    this.stateChain = request.then(() => undefined, () => undefined);
    return request;
  }

  private handleHide(): void {
    if (this.disposed) return;
    if (this.open) {
      this.open = false;
      this.token++;
      this.refreshQueued = false;
      this.stopPolling();
    }
    this.disposePicker();
  }

  private startPolling(): void {
    if (this.polling || this.disposed) return;
    this.polling = true;
    this.timerHandle = this.timer.set(() => {
      if (!this.disposed && this.open) void this.requestRefresh();
    }, OPEN_CHATS_POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (!this.polling) return;
    this.polling = false;
    this.timer.clear(this.timerHandle);
    this.timerHandle = undefined;
  }

  private disposePicker(): void {
    for (const subscription of this.pickerSubscriptions) subscription.dispose();
    this.pickerSubscriptions = [];
    const picker = this.picker;
    this.picker = undefined;
    if (!picker) return;
    try {
      picker.dispose();
    } catch {
      // Disposal must never keep shutdown hanging.
    }
  }
}
