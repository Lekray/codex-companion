/**
 * Pure parsing and presentation model for the official Codex open-chat bridge.
 * No VS Code imports: the bridge payload is validated field by field and only
 * metadata needed by the picker is retained.
 */

export type OpenChatStatus = 'idle' | 'running' | 'done' | 'error' | 'waiting';

export interface OpenChatTab {
  readonly panelId: string;
  readonly threadId: string | null;
  readonly route: string | null;
  readonly title: string;
  readonly status: OpenChatStatus;
  readonly updatedAt: number;
}

export interface OpenChatsSnapshot {
  readonly instanceId: string;
  readonly sequence: number;
  readonly tabs: readonly OpenChatTab[];
}

export type OpenChatsParseFailure =
  | 'schema'
  | 'api-version'
  | 'instance'
  | 'sequence'
  | 'capabilities'
  | 'tabs';

export type OpenChatsParseResult =
  | { readonly ok: true; readonly snapshot: OpenChatsSnapshot }
  | { readonly ok: false; readonly reason: OpenChatsParseFailure };

export interface OpenChatItem extends OpenChatTab {
  /** Snapshot the item was built from; used to reject cross-instance focus. */
  readonly instanceId: string;
  readonly label: string;
  readonly description: string;
}

export const MAX_INSTANCE_ID_LENGTH = 256;
export const MAX_PANEL_ID_LENGTH = 256;
export const MAX_THREAD_ID_LENGTH = 512;
export const MAX_ROUTE_LENGTH = 4096;
export const MAX_RAW_TITLE_LENGTH = 4096;
export const MAX_DISPLAY_TITLE_LENGTH = 200;
export const MAX_OPEN_CHATS = 500;

const STATUS_ORDER: Readonly<Record<OpenChatStatus, number>> = {
  waiting: 0,
  error: 1,
  running: 2,
  idle: 3,
  done: 4,
};

const STATUS_LABELS_RU: Readonly<Record<OpenChatStatus, string>> = {
  waiting: 'Ожидает',
  error: 'Ошибка',
  running: 'Выполняется',
  idle: 'Простаивает',
  done: 'Готово',
};

const STATUS_LABELS_EN: Readonly<Record<OpenChatStatus, string>> = {
  waiting: 'Waiting',
  error: 'Error',
  running: 'Running',
  idle: 'Idle',
  done: 'Done',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedNonEmptyString(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit;
}

function isBoundedString(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length <= limit;
}

function isNullableBoundedString(value: unknown, limit: number): value is string | null {
  return value === null || isBoundedNonEmptyString(value, limit);
}

function isStatus(value: unknown): value is OpenChatStatus {
  return value === 'idle' || value === 'running' || value === 'done'
    || value === 'error' || value === 'waiting';
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseTab(value: unknown): OpenChatTab | undefined {
  if (!isRecord(value)) return undefined;
  if (!isBoundedNonEmptyString(value.panelId, MAX_PANEL_ID_LENGTH)) return undefined;
  if (value.hostId !== 'local') return undefined;
  if (!isNullableBoundedString(value.threadId, MAX_THREAD_ID_LENGTH)) return undefined;
  if (!isNullableBoundedString(value.route, MAX_ROUTE_LENGTH)) return undefined;
  if (!isBoundedString(value.title, MAX_RAW_TITLE_LENGTH)) return undefined;
  if (!isStatus(value.status)) return undefined;
  if (typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return undefined;
  // Intentionally copy only the known primitive fields; never clone raw objects.
  return {
    panelId: value.panelId,
    threadId: value.threadId,
    route: value.route,
    title: value.title,
    status: value.status,
    updatedAt: value.updatedAt,
  };
}

/**
 * Validate one getState response. Top-level incompatibility rejects the whole
 * snapshot; malformed or foreign tabs are dropped individually. Duplicate
 * panelIds keep the first record, and the tab array is bounded.
 */
export function parseOpenChatsState(value: unknown): OpenChatsParseResult {
  if (!isRecord(value)) return { ok: false, reason: 'schema' };
  if (value.apiVersion !== 1) return { ok: false, reason: 'api-version' };
  if (!isBoundedNonEmptyString(value.instanceId, MAX_INSTANCE_ID_LENGTH)) {
    return { ok: false, reason: 'instance' };
  }
  if (!isNonNegativeSafeInteger(value.sequence)) return { ok: false, reason: 'sequence' };
  if (!isRecord(value.capabilities) || value.capabilities.statuses !== true) {
    return { ok: false, reason: 'capabilities' };
  }
  if (!Array.isArray(value.tabs)) return { ok: false, reason: 'tabs' };

  const tabs: OpenChatTab[] = [];
  const seen = new Set<string>();
  const limit = Math.min(value.tabs.length, MAX_OPEN_CHATS);
  for (let index = 0; index < limit; index++) {
    const tab = parseTab(value.tabs[index]);
    if (!tab || seen.has(tab.panelId)) continue;
    seen.add(tab.panelId);
    tabs.push(tab);
  }
  return {
    ok: true,
    snapshot: {
      instanceId: value.instanceId,
      sequence: value.sequence,
      tabs,
    },
  };
}

/**
 * A same-instance response with a lower sequence is stale. Equal sequences are
 * accepted because title-only changes, opens and closes do not increment it.
 */
export function isStaleSameInstance(
  previous: Pick<OpenChatsSnapshot, 'instanceId' | 'sequence'> | undefined,
  next: Pick<OpenChatsSnapshot, 'instanceId' | 'sequence'>,
): boolean {
  return previous !== undefined
    && previous.instanceId === next.instanceId
    && next.sequence < previous.sequence;
}

/** Waiting -> error -> running -> idle -> done, preserving native order. */
export function orderOpenChats(tabs: readonly OpenChatTab[]): OpenChatTab[] {
  return [...tabs].sort((left, right) => STATUS_ORDER[left.status] - STATUS_ORDER[right.status]);
}

function cleanTitle(value: string, ru: boolean): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text === '') return ru ? 'Новый чат' : 'New chat';
  return text.slice(0, MAX_DISPLAY_TITLE_LENGTH);
}

/**
 * Build localized picker items. Duplicate titles receive a 1-based view number
 * taken from native panel order, so two views of one thread stay distinct.
 * Nothing here exposes panel or thread identifiers.
 */
export function buildOpenChatItems(snapshot: OpenChatsSnapshot, ru: boolean): OpenChatItem[] {
  const fallbackView = new Map<string, number>();
  const totalViews = new Map<string, number>();
  const cleaned = snapshot.tabs.map(tab => {
    const title = cleanTitle(tab.title, ru);
    totalViews.set(title, (totalViews.get(title) ?? 0) + 1);
    return { tab, title };
  });

  const items = cleaned.map(({ tab, title }) => {
    let view: number | undefined;
    if ((totalViews.get(title) ?? 0) > 1) {
      view = (fallbackView.get(title) ?? 0) + 1;
      fallbackView.set(title, view);
    }
    const label = view === undefined
      ? title
      : `${title} (${ru ? 'вид' : 'view'} ${view})`;
    return {
      panelId: tab.panelId,
      threadId: tab.threadId,
      route: tab.route,
      title,
      status: tab.status,
      updatedAt: tab.updatedAt,
      instanceId: snapshot.instanceId,
      label,
      description: (ru ? STATUS_LABELS_RU : STATUS_LABELS_EN)[tab.status],
    };
  });
  return items.sort((left, right) => STATUS_ORDER[left.status] - STATUS_ORDER[right.status]);
}
