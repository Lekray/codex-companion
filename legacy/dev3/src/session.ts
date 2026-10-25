import { randomUUID } from 'node:crypto';
import type { AppServerClient, ServerRequest } from './appServer';

export type Status = 'idle' | 'running' | 'done' | 'error' | 'waiting';
export interface SavedTab { id: string; title: string; threadId?: string; open: boolean }
export interface Item { id: string; role: 'user' | 'assistant' | 'tool' | 'system'; title: string; text: string }
export interface Question { id: string; question: string; options?: { label: string; description?: string }[]; isSecret?: boolean }
export interface Prompt { id: string | number; method: string; detail: string; questions: Question[]; params: Record<string, unknown> }
export interface Session extends SavedTab {
  status: Status;
  items: Item[];
  prompts: Prompt[];
  turnId?: string;
  loaded: boolean;
  busy: boolean;
  stopRequested?: boolean;
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const string = (value: unknown): string => typeof value === 'string' ? value : '';
export function isTaskActive(session: Session): boolean {
  return !!session.turnId || session.status === 'running' || session.status === 'waiting';
}
export function tabLabel(session: Pick<Session, 'status' | 'title'>): string {
  const mark = { idle: '', running: '[~] ', done: '[V] ', error: '[!] ', waiting: '[?] ' }[session.status];
  return mark + session.title;
}

export function displayItem(raw: unknown): Item | undefined {
  const item = record(raw);
  if (typeof item.id !== 'string') return;
  const type = string(item.type);
  if (type === 'userMessage') {
    const content = Array.isArray(item.content) ? item.content : [];
    return { id: item.id, role: 'user', title: '', text: content.map(v => string(record(v).text)).filter(Boolean).join('\n') };
  }
  if (type === 'agentMessage') return { id: item.id, role: 'assistant', title: '', text: string(item.text) };
  if (type === 'reasoning') return; // Show answers and tool results; no internal reasoning transcript.
  let text = string(item.text);
  if (type === 'commandExecution') text = [string(item.command), string(item.aggregatedOutput), item.exitCode == null ? '' : `exit: ${item.exitCode}`].filter(Boolean).join('\n');
  if (!text) text = JSON.stringify(item, null, 2);
  return { id: item.id, role: 'tool', title: type, text };
}

export class Sessions {
  readonly all = new Map<string, Session>();
  private removers: (() => void)[] = [];
  constructor(
    private readonly rpc: AppServerClient,
    private readonly cwd: string,
    saved: SavedTab[],
    private readonly changed: (session: Session) => void,
    private readonly notify: (session: Session, kind: 'done' | 'error' | 'waiting') => void,
  ) {
    for (const tab of saved) this.add(tab);
    this.removers.push(rpc.onNotification((method, params) => this.receive(method, record(params))));
    this.removers.push(rpc.onRequest(request => this.requested(request)));
    this.removers.push(rpc.onClose(() => {
      for (const session of this.all.values()) {
        session.loaded = false;
        session.prompts = [];
        if (isTaskActive(session)) this.error(session, 'Codex disconnected.');
      }
    }));
  }

  add(saved: SavedTab): Session {
    const session: Session = { ...saved, status: 'idle', items: [], prompts: [], loaded: false, busy: false };
    this.all.set(session.id, session);
    return session;
  }

  private update(session: Session): void { this.changed(session); }
  private upsert(session: Session, item: Item): void {
    const index = session.items.findIndex(existing => existing.id === item.id);
    if (index < 0) session.items.push(item); else session.items[index] = item;
  }
  private error(session: Session, message: string, notify = true): void {
    session.status = 'error';
    session.items.push({ id: randomUUID(), role: 'system', title: '', text: message });
    this.update(session);
    if (notify) this.notify(session, 'error');
  }

  /** Metadata/history hydration only: no thread/resume or turn/start on window restore. */
  async history(session: Session): Promise<void> {
    if (!session.threadId) return;
    if (session.busy || session.turnId) return;
    session.busy = true;
    this.update(session);
    try {
      const reply = await this.rpc.request<{ thread: { historyMode?: string; turns?: { items: unknown[] }[] } }>('thread/read', { threadId: session.threadId, includeTurns: false });
      let rawItems: unknown[] = [];
      if (reply.thread.historyMode === 'paginated') {
        let cursor: string | null = null;
        const seen = new Set<string>();
        do {
          const page: { data: { item: unknown }[]; nextCursor: string | null } = await this.rpc.request('thread/items/list', { threadId: session.threadId, limit: 100, sortDirection: 'asc', cursor });
          rawItems.push(...page.data.map(entry => entry.item));
          cursor = page.nextCursor;
          if (cursor && seen.has(cursor)) throw new Error('Repeated history cursor');
          if (cursor) seen.add(cursor);
        } while (cursor);
      } else {
        const full = await this.rpc.request<{ thread: { turns: { items: unknown[] }[] } }>('thread/read', { threadId: session.threadId, includeTurns: true });
        rawItems = full.thread.turns.flatMap(turn => turn.items);
      }
      session.items = rawItems.map(displayItem).filter((v): v is Item => v !== undefined);
      this.update(session);
    } catch (error) { this.error(session, error instanceof Error ? error.message : 'Could not load history', false); }
    finally { session.busy = false; this.update(session); }
  }

  async create(session: Session): Promise<void> {
    const reply = await this.rpc.request<{ thread: { id: string } }>('thread/start', { cwd: this.cwd, modelProvider: 'openai' });
    session.threadId = reply.thread.id;
    session.loaded = true;
    this.update(session);
  }

  async send(session: Session, text: string): Promise<boolean> {
    if (!text.trim() || session.busy || session.turnId || session.status === 'running' || session.status === 'waiting') return false;
    session.busy = true;
    session.status = 'running';
    this.update(session);
    try {
      if (!session.threadId) await this.create(session);
      else if (!session.loaded) {
        await this.rpc.request('thread/resume', { threadId: session.threadId, cwd: this.cwd, excludeTurns: true });
        session.loaded = true;
      }
      if (session.stopRequested) {
        delete session.stopRequested;
        session.status = 'idle';
        return false;
      }
      const reply = await this.rpc.request<{ turn: { id: string; status?: string } }>('turn/start', {
        threadId: session.threadId, input: [{ type: 'text', text, text_elements: [] }],
      });
      // Notifications can arrive before this response, including turn/completed.
      if (session.status === 'running' || session.status === 'waiting') {
        session.turnId = reply.turn.id;
        if (session.stopRequested) await this.stop(session);
      }
      return true;
    } catch (error) { delete session.stopRequested; this.error(session, error instanceof Error ? error.message : 'Could not send message'); return false; }
    finally { session.busy = false; this.update(session); }
  }

  async stop(session: Session): Promise<void> {
    if (!session.turnId || !session.threadId) {
      if (session.status === 'running') session.stopRequested = true;
      return;
    }
    delete session.stopRequested;
    await this.rpc.request('turn/interrupt', { threadId: session.threadId, turnId: session.turnId });
  }

  private receive(method: string, params: Record<string, unknown>): void {
    const session = [...this.all.values()].find(s => s.threadId === params.threadId);
    if (!session) return;
    if (method === 'turn/started') {
      session.turnId = string(record(params.turn).id);
      session.status = 'running';
      if (session.stopRequested) void this.stop(session).catch(error => this.error(session, String(error)));
    } else if (method === 'turn/completed') {
      const turn = record(params.turn);
      if (session.turnId && turn.id !== session.turnId) return;
      delete session.turnId;
      delete session.stopRequested;
      for (const prompt of session.prompts) this.rpc.rejectRequest(prompt.id);
      session.prompts = [];
      session.status = turn.status === 'failed' ? 'error' : turn.status === 'interrupted' ? 'idle' : 'done';
      if (turn.status === 'failed') session.items.push({ id: randomUUID(), role: 'system', title: '', text: string(record(turn.error).message) || 'Codex turn failed.' });
      if (session.status === 'done' || session.status === 'error') this.notify(session, session.status);
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = displayItem(params.item);
      if (item) this.upsert(session, item);
    } else if (method === 'item/agentMessage/delta' || method === 'item/commandExecution/outputDelta') {
      const id = string(params.itemId);
      let item = session.items.find(v => v.id === id);
      if (!item) {
        item = { id, role: method.includes('agentMessage') ? 'assistant' : 'tool', title: '', text: '' };
        session.items.push(item);
      }
      item.text += string(params.delta);
    } else if (method === 'serverRequest/resolved') {
      session.prompts = session.prompts.filter(prompt => prompt.id !== params.requestId);
      if (!session.prompts.length && session.status === 'waiting') session.status = 'running';
    } else if (method === 'error' && !params.willRetry) {
      this.error(session, string(record(params.error).message) || 'Codex error');
      return;
    } else return;
    this.update(session);
  }

  private requested(request: ServerRequest): void {
    const params = record(request.params);
    const session = [...this.all.values()].find(s => s.threadId === params.threadId);
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput'];
    if (!session || !supported.includes(request.method)) {
      this.rpc.rejectRequest(request.id);
      if (session) this.error(session, `Unsupported Codex request: ${request.method}`);
      return;
    }
    const details = { reason: params.reason, command: params.command, cwd: params.cwd, permissions: params.permissions,
      changes: session.items.find(item => item.id === params.itemId)?.text };
    session.prompts.push({ id: request.id, method: request.method, detail: JSON.stringify(details, null, 2), params,
      questions: Array.isArray(params.questions) ? params.questions as Question[] : [] });
    session.status = 'waiting';
    this.update(session);
    this.notify(session, 'waiting');
  }

  answer(session: Session, id: string | number, decision: string, answers: Record<string, unknown>): void {
    const prompt = session.prompts.find(p => p.id === id);
    if (!prompt) throw new Error('Request is no longer pending');
    let result: unknown;
    if (prompt.method === 'item/tool/requestUserInput') {
      const validated: Record<string, { answers: string[] }> = {};
      for (const question of prompt.questions) {
        const value = answers[question.id];
        if (typeof value !== 'string' || !value.trim()) throw new Error('Please answer every question');
        validated[question.id] = { answers: [value] };
      }
      result = { answers: validated };
    } else {
      if (!['accept', 'decline', 'cancel'].includes(decision)) throw new Error('Invalid decision');
      result = prompt.method === 'item/permissions/requestApproval'
        ? { permissions: decision === 'accept' ? Object.fromEntries(Object.entries(record(prompt.params.permissions)).filter(([key, value]) => ['network', 'fileSystem'].includes(key) && value != null)) : {}, scope: 'turn' }
        : { decision };
    }
    this.rpc.respond(id, result);
    session.prompts = session.prompts.filter(p => p !== prompt);
    session.status = session.prompts.length ? 'waiting' : 'running';
    this.update(session);
  }

  dispose(): void { for (const remove of this.removers) remove(); }
}
