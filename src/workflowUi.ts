import { randomInt } from 'node:crypto';
import {
  claimNotificationEvent,
  playCompletionSound,
  playWaitingSound,
  WorkflowNotifications,
  type NotificationSettings,
  type NotificationSound,
  type WorkflowNotice,
} from './workflowNotifications';
import { WindowsNotifications } from './windowsNotifications';

export const WORKFLOW_EVENT_COMMAND = 'codexCompanion.official.v1.event';
export const BRIDGE_GET_STATE_COMMAND = 'chatgpt.companion.v1.getState';
export const BRIDGE_FOCUS_TAB_COMMAND = 'chatgpt.companion.v1.focusTab';
export const FOCUS_WINDOW_COMMAND = 'workbench.action.focusWindow';

const MAX_BUFFERED_EVENTS = 32;
const MAX_REMEMBERED_EVENTS = 512;

export type BridgeState = 'unknown' | 'ready' | 'absent';
export type BridgeStatus = 'idle' | 'running' | 'done' | 'error' | 'waiting';

export interface BridgeTab {
  panelId: string;
  threadId: string | null;
  hostId: string;
  route: string | null;
  title: string;
  status: BridgeStatus;
  turnId: string | null;
  updatedAt: number;
}

export interface BridgeEvent {
  apiVersion: 1;
  kind: 'status';
  instanceId: string;
  sequence: number;
  live: boolean;
  eventId: string;
  tab: BridgeTab;
  previousStatus: BridgeStatus;
}

export interface OfficialOpenTab {
  uri: string;
  column: number;
  threadId: string | null;
}

export interface DisposableLike {
  dispose(): void;
}

export interface WorkflowUiDependencies {
  russian: boolean;
  extensionPath: string;
  claimDir: string;
  local: () => boolean;
  focused: () => boolean;
  settings: () => NotificationSettings;
  registerCommand: (command: string, handler: (argument?: unknown) => unknown) => DisposableLike;
  executeCommand: (command: string, ...args: unknown[]) => Promise<unknown>;
  getCommands: () => Promise<readonly string[]>;
  inApp: (message: string, openLabel: string) => Promise<boolean>;
  openOfficialTabs: () => readonly OfficialOpenTab[];
  revealOfficialTab: (uri: string, column: number) => Promise<void>;
  claimEvent?: ((eventId: string) => Promise<boolean>) | undefined;
  sound?: ((sound: NotificationSound) => Promise<void>) | undefined;
  native?: ((title: string, message: string) => Promise<boolean>) | undefined;
  notifications?: WorkflowNotifications | undefined;
  windowsNotifications?: WindowsNotifications | undefined;
  compatibility?: (() => boolean) | undefined;
  projectName?: (() => string | undefined) | undefined;
  onStatusEvent?: ((event: BridgeEvent) => void) | undefined;
  onBridgeState?: ((state: BridgeState) => void) | undefined;
  onError?: ((error: unknown) => void) | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is BridgeStatus {
  return value === 'idle' || value === 'running' || value === 'done'
    || value === 'error' || value === 'waiting';
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseBridgeState(value: unknown): { instanceId: string; sequence: number } | undefined {
  if (!isRecord(value) || value.apiVersion !== 1) return undefined;
  if (!nonEmptyString(value.instanceId) || !nonNegativeInteger(value.sequence)) {
    return undefined;
  }
  if (!isRecord(value.capabilities) || value.capabilities.statuses !== true) return undefined;
  return { instanceId: value.instanceId, sequence: value.sequence };
}

function parseEvent(value: unknown): BridgeEvent | undefined {
  if (!isRecord(value) || value.apiVersion !== 1 || value.kind !== 'status') return undefined;
  if (!nonEmptyString(value.instanceId) || !nonNegativeInteger(value.sequence)) {
    return undefined;
  }
  if (typeof value.live !== 'boolean' || !nonEmptyString(value.eventId) || value.eventId.length > 512) {
    return undefined;
  }
  if (!isStatus(value.previousStatus) || !isRecord(value.tab)) return undefined;
  const tab = value.tab;
  if (!nonEmptyString(tab.panelId) || !nullableString(tab.threadId) || typeof tab.hostId !== 'string') {
    return undefined;
  }
  if (!nullableString(tab.route) || typeof tab.title !== 'string') return undefined;
  if (!isStatus(tab.status) || !nullableString(tab.turnId) || !finiteNumber(tab.updatedAt)) {
    return undefined;
  }
  return {
    apiVersion: 1,
    kind: 'status',
    instanceId: value.instanceId,
    sequence: value.sequence,
    live: value.live,
    eventId: value.eventId,
    tab: {
      panelId: tab.panelId,
      threadId: tab.threadId,
      hostId: tab.hostId,
      route: tab.route,
      title: tab.title,
      status: tab.status,
      turnId: tab.turnId,
      updatedAt: tab.updatedAt,
    },
    previousStatus: value.previousStatus,
  };
}

function noticeStatus(status: BridgeStatus, previous: BridgeStatus): WorkflowNotice['status'] | undefined {
  if (status === 'done') {
    return previous === 'running' || previous === 'waiting' ? 'done' : undefined;
  }
  if (status === 'waiting') return previous !== 'waiting' ? 'waiting' : undefined;
  if (status === 'error') {
    return previous === 'running' || previous === 'waiting' ? 'error' : undefined;
  }
  return undefined;
}

function cleanText(value: string, fallback: string, limit: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return (text === '' ? fallback : text).slice(0, limit);
}

/**
 * Companion side of the official status bridge. It validates metadata events,
 * deduplicates logical transitions, and hands notices to the accepted
 * notification service without ever reading chat content.
 */
export class WorkflowUi implements DisposableLike {
  private readonly subscription: DisposableLike;
  private readonly notifications: WorkflowNotifications;
  private windows: WindowsNotifications | undefined;
  private bridge: BridgeState = 'unknown';
  private instanceId: string | undefined;
  private lastSequence = -1;
  private handshakeToken = 0;
  private handshake: Promise<void>;
  private chain = Promise.resolve();
  private readonly buffered: unknown[] = [];
  private readonly remembered = new Set<string>();
  private readonly inFlight = new Set<Promise<void>>();
  private compatibility: (() => boolean) | undefined;
  private disposed = false;

  constructor(private readonly deps: WorkflowUiDependencies) {
    this.windows = deps.windowsNotifications;
    this.compatibility = deps.compatibility;
    this.notifications = deps.notifications ?? new WorkflowNotifications({
      focused: deps.focused,
      settings: deps.settings,
      claimEvent: deps.claimEvent ?? (eventId => claimNotificationEvent(deps.claimDir, eventId)),
      inApp: deps.inApp,
      native: deps.native ?? ((title, message) => this.showNative(title, message)),
      sound: deps.sound ?? (sound => sound === 'waiting'
        ? playWaitingSound(deps.extensionPath)
        : playCompletionSound(deps.extensionPath)),
      onError: error => this.report(error),
    }, deps.russian);
    this.subscription = deps.registerCommand(WORKFLOW_EVENT_COMMAND, argument => {
      this.receive(argument);
    });
    this.handshake = this.startHandshake();
  }

  bridgeState(): BridgeState {
    return this.bridge;
  }

  setCompatibilityGate(gate: (() => boolean) | undefined): void {
    this.compatibility = gate;
    this.drainBuffered();
  }

  /** Called when the cached compatibility status changes. */
  noteCompatibilityChanged(): void {
    this.drainBuffered();
  }

  /** Used by the compatibility UI after an extension change. */
  async retryBridge(): Promise<void> {
    if (this.disposed) return;
    this.instanceId = undefined;
    this.lastSequence = -1;
    if (this.bridge !== 'unknown') this.setBridge('unknown');
    this.handshake = this.startHandshake();
    await this.handshake;
  }

  async whenReady(): Promise<void> {
    await this.handshake;
  }

  /** Test/diagnostic barrier; normal event delivery never waits on notices. */
  async flush(): Promise<void> {
    await this.chain;
    await Promise.allSettled([...this.inFlight]);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.buffered.length = 0;
    this.remembered.clear();
    this.subscription.dispose();
    this.notifications.dispose();
    this.windows?.dispose();
    this.windows = undefined;
  }

  private async startHandshake(): Promise<void> {
    const token = ++this.handshakeToken;
    if (this.disposed || !this.isLocal()) {
      this.setBridge('absent');
      return;
    }
    try {
      const commands = await this.deps.getCommands();
      if (token !== this.handshakeToken || this.disposed) return;
      if (!commands.includes(BRIDGE_GET_STATE_COMMAND)) {
        this.setBridge('absent');
        return;
      }
      const raw = await this.deps.executeCommand(BRIDGE_GET_STATE_COMMAND);
      if (token !== this.handshakeToken || this.disposed) return;
      const state = parseBridgeState(raw);
      if (!state) {
        this.setBridge('absent');
        return;
      }
      this.instanceId = state.instanceId;
      this.lastSequence = state.sequence;
      this.setBridge('ready');
      this.drainBuffered();
    } catch {
      if (token === this.handshakeToken) this.setBridge('absent');
    }
  }

  private receive(argument: unknown): void {
    if (this.disposed) return;
    if (this.bridge === 'unknown' || (this.bridge === 'ready' && !this.compatibilityAllowed())) {
      if (this.buffered.length >= MAX_BUFFERED_EVENTS) this.buffered.shift();
      this.buffered.push(argument);
      return;
    }
    this.enqueue(argument);
  }

  private drainBuffered(): void {
    if (this.disposed || this.bridge !== 'ready' || !this.compatibilityAllowed()) return;
    const pending = this.buffered.splice(0);
    for (const argument of pending) this.enqueue(argument);
  }

  private enqueue(argument: unknown): void {
    this.chain = this.chain
      .then(() => this.handle(argument))
      .catch(error => this.report(error));
  }

  private async handle(argument: unknown): Promise<void> {
    if (this.disposed || this.bridge !== 'ready' || !this.isLocal()) return;
    const event = parseEvent(argument);
    if (!event || !this.instanceId || event.instanceId !== this.instanceId) return;
    if (event.tab.hostId !== 'local') return;
    if (event.sequence <= this.lastSequence) return;
    this.lastSequence = event.sequence;
    if (!event.live) return;
    if (!this.compatibilityAllowed()) return;
    // A logical status can recur within one turn (running -> waiting -> running).
    // Refresh current metadata even when its notification identity was seen before.
    this.emitStatusEvent(event);
    if (this.remembered.has(event.eventId)) return;
    this.remember(event.eventId);
    const status = noticeStatus(event.tab.status, event.previousStatus);
    if (!status) return;

    const notice: WorkflowNotice = {
      eventId: event.eventId,
      project: cleanText(this.deps.projectName?.() ?? '', 'Codex', 80),
      title: cleanText(
        event.tab.title,
        this.deps.russian ? 'Задача Codex' : 'Codex task',
        160,
      ),
      status,
      reveal: () => this.reveal(event.tab),
    };
    this.startNotification(notice);
  }

  private emitStatusEvent(event: BridgeEvent): void {
    try {
      this.deps.onStatusEvent?.(event);
    } catch (error) {
      this.report(error);
    }
  }

  private startNotification(notice: WorkflowNotice): void {
    const pending = this.notifications.notify(notice)
      .catch(error => this.report(error))
      .finally(() => {
        this.inFlight.delete(pending);
      });
    this.inFlight.add(pending);
  }

  private async reveal(tab: BridgeTab): Promise<void> {
    let commands: readonly string[] = [];
    try {
      commands = await this.deps.getCommands();
    } catch (error) {
      this.report(error);
    }

    if (commands.includes(BRIDGE_FOCUS_TAB_COMMAND)) {
      try {
        const focused = await this.deps.executeCommand(BRIDGE_FOCUS_TAB_COMMAND, {
          panelId: tab.panelId,
          threadId: tab.threadId,
        });
        if (focused === true) await this.focusWindow(commands);
      } catch (error) {
        this.report(error);
      }
      return;
    }

    await this.revealExactOpenTab(tab);
    await this.focusWindow(commands);
  }

  private async revealExactOpenTab(tab: BridgeTab): Promise<void> {
    if (!tab.threadId) return;
    let matches: readonly OfficialOpenTab[];
    try {
      matches = this.deps.openOfficialTabs().filter(item => item.threadId === tab.threadId);
    } catch (error) {
      this.report(error);
      return;
    }
    if (matches.length !== 1) return;
    const match = matches[0];
    if (!match) return;
    try {
      await this.deps.revealOfficialTab(match.uri, match.column);
    } catch (error) {
      this.report(error);
    }
  }

  private async focusWindow(commands: readonly string[]): Promise<void> {
    if (!commands.includes(FOCUS_WINDOW_COMMAND)) return;
    try {
      await this.deps.executeCommand(FOCUS_WINDOW_COMMAND);
    } catch (error) {
      this.report(error);
    }
  }

  private async showNative(title: string, message: string): Promise<boolean> {
    const windows = this.windows ?? (this.windows = new WindowsNotifications());
    const outcome = await windows.show({
      id: this.nextToastId(),
      title,
      message,
      sound: false,
    });
    return outcome === 'activated';
  }

  private nextToastId(): number {
    return randomInt(1, 2_147_483_647);
  }

  private compatibilityAllowed(): boolean {
    if (!this.compatibility) return true;
    try {
      return this.compatibility() === true;
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  private isLocal(): boolean {
    try {
      return this.deps.local() === true;
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  private setBridge(state: BridgeState): void {
    if (this.bridge === state) return;
    this.bridge = state;
    try {
      this.deps.onBridgeState?.(state);
    } catch (error) {
      this.report(error);
    }
  }

  private remember(eventId: string): void {
    this.remembered.add(eventId);
    if (this.remembered.size <= MAX_REMEMBERED_EVENTS) return;
    const oldest = this.remembered.values().next().value;
    if (oldest !== undefined) this.remembered.delete(oldest);
  }

  private report(error: unknown): void {
    try {
      this.deps.onError?.(error);
    } catch {
      // Diagnostics must not break event delivery.
    }
  }
}
