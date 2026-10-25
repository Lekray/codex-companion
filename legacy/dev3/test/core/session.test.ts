import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { AppServerClient, ServerRequest } from '../../src/appServer';
import { Sessions, tabLabel, type SavedTab } from '../../src/session';

class FakeRpc {
  events = new EventEmitter();
  calls: { method: string; params: unknown }[] = [];
  responses: { id: string | number; result: unknown }[] = [];
  rejected: (string | number)[] = [];
  handler: (method: string, params: unknown) => unknown = method => method === 'thread/start' ? { thread: { id: 'thread' } } : { turn: { id: 'turn' } };
  async request(method: string, params: unknown): Promise<unknown> { this.calls.push({ method, params }); return this.handler(method, params); }
  onNotification(listener: (method: string, params: unknown) => void): () => void { return this.on('notification', listener); }
  onRequest(listener: (request: ServerRequest) => void): () => void { return this.on('request', listener); }
  onClose(listener: () => void): () => void { return this.on('close', listener); }
  private on(event: string, listener: (...args: any[]) => void): () => void { this.events.on(event, listener); return () => { this.events.off(event, listener); }; }
  respond(id: string | number, result: unknown): void { this.responses.push({ id, result }); }
  rejectRequest(id: string | number): void { this.rejected.push(id); }
  notification(method: string, params: unknown): void { this.events.emit('notification', method, params); }
  prompt(id: string | number, method: string, params: Record<string, unknown> = {}): void {
    this.events.emit('request', { id, method, params: { threadId: 'thread', ...params } });
  }
}

function setup(saved: SavedTab[] = [{ id: 'tab', title: 'Personal title', threadId: 'thread', open: true }]) {
  const rpc = new FakeRpc();
  const notifications: string[] = [];
  const sessions = new Sessions(rpc as unknown as AppServerClient, 'C:/work', saved, () => {}, (_, kind) => notifications.push(kind));
  return { rpc, sessions, session: sessions.all.get('tab')!, notifications };
}

test('completion before start response stays completed; parallel sends cannot duplicate turns', async () => {
  const { rpc, sessions, session, notifications } = setup();
  let release!: (value: unknown) => void;
  rpc.handler = method => {
    if (method === 'thread/resume') return {};
    rpc.notification('turn/started', { threadId: 'thread', turn: { id: 'turn' } });
    rpc.notification('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } });
    return new Promise(resolve => { release = resolve; });
  };
  const first = sessions.send(session, 'hello');
  await new Promise(resolve => setImmediate(resolve));
  await sessions.send(session, 'duplicate');
  release({ turn: { id: 'turn' } });
  await first;
  assert.equal(session.status, 'done');
  assert.equal(session.turnId, undefined);
  assert.equal(session.busy, false);
  assert.deepEqual(notifications, ['done']);
  assert.deepEqual(rpc.calls.map(v => v.method), ['thread/resume', 'turn/start']);
});

test('streaming items are finalized once and messages never rename independent tabs', () => {
  const { rpc, sessions, session } = setup([
    { id: 'tab', title: 'Personal title', threadId: 'thread', open: true },
    { id: 'other', title: 'Other title', threadId: 'other-thread', open: true },
  ]);
  rpc.notification('item/agentMessage/delta', { threadId: 'thread', itemId: 'message', delta: 'Hello ' });
  rpc.notification('item/agentMessage/delta', { threadId: 'thread', itemId: 'message', delta: 'world' });
  rpc.notification('item/completed', { threadId: 'thread', item: { id: 'message', type: 'agentMessage', text: 'Hello world!' } });
  rpc.notification('item/completed', { threadId: 'thread', item: { id: 'reason', type: 'reasoning', text: 'hidden' } });
  assert.deepEqual(session.items, [{ id: 'message', role: 'assistant', title: '', text: 'Hello world!' }]);
  assert.equal(session.title, 'Personal title');
  assert.equal(sessions.all.get('other')?.title, 'Other title');
  assert.equal(sessions.all.get('other')?.items.length, 0);
  session.status = 'done';
  assert.equal(tabLabel(session), '[V] Personal title');
});

test('multiple approvals require explicit valid answers and keep waiting until all resolved', () => {
  const { rpc, sessions, session, notifications } = setup();
  rpc.prompt(10, 'item/commandExecution/requestApproval');
  rpc.prompt(11, 'item/fileChange/requestApproval');
  assert.equal(session.status, 'waiting');
  assert.equal(rpc.responses.length, 0);
  assert.deepEqual(notifications, ['waiting', 'waiting']);
  assert.throws(() => sessions.answer(session, 10, 'acceptForSession', {}), /Invalid decision/);
  assert.equal(rpc.responses.length, 0);
  sessions.answer(session, 10, 'decline', {});
  assert.equal(session.status, 'waiting');
  assert.throws(() => sessions.answer(session, 10, 'accept', {}), /no longer pending/);
  sessions.answer(session, 11, 'accept', {});
  assert.equal(session.status, 'running');
  assert.deepEqual(rpc.responses, [{ id: 10, result: { decision: 'decline' } }, { id: 11, result: { decision: 'accept' } }]);
});

test('user input validates every question and permission refusal grants no permissions', () => {
  const { rpc, sessions, session } = setup();
  rpc.prompt('input', 'item/tool/requestUserInput', { questions: [{ id: 'a', question: 'A?' }, { id: 'b', question: 'B?' }] });
  assert.throws(() => sessions.answer(session, 'input', '', { a: 'answer' }), /every question/);
  assert.throws(() => sessions.answer(session, 'input', '', { a: 'answer', b: ['bad type'] }), /every question/);
  assert.equal(rpc.responses.length, 0);
  sessions.answer(session, 'input', '', { a: 'one', b: 'two' });
  assert.deepEqual(rpc.responses[0]?.result, { answers: { a: { answers: ['one'] }, b: { answers: ['two'] } } });
  rpc.prompt('permission', 'item/permissions/requestApproval', { permissions: { network: { enabled: true } } });
  sessions.answer(session, 'permission', 'decline', {});
  assert.deepEqual(rpc.responses[1]?.result, { permissions: {}, scope: 'turn' });
});

test('unknown requests fail closed and completed turns invalidate unanswered prompts', () => {
  const { rpc, sessions, session } = setup();
  rpc.prompt(1, 'future/unsupported');
  rpc.prompt(2, 'item/commandExecution/requestApproval', { threadId: 'unknown-thread' });
  assert.deepEqual(rpc.rejected, [1, 2]);
  rpc.notification('turn/started', { threadId: 'thread', turn: { id: 'turn' } });
  rpc.prompt(3, 'item/commandExecution/requestApproval');
  rpc.notification('turn/completed', { threadId: 'thread', turn: { id: 'other-turn', status: 'completed' } });
  assert.equal(session.status, 'waiting');
  rpc.notification('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'completed' } });
  assert.deepEqual(rpc.rejected, [1, 2, 3]);
  assert.equal(session.prompts.length, 0);
  assert.throws(() => sessions.answer(session, 3, 'accept', {}), /no longer pending/);
  assert.equal(rpc.responses.length, 0);
});

test('restoration reads legacy and paginated history without resuming or starting work', async () => {
  for (const paginated of [false, true]) {
    const { rpc, sessions, session } = setup();
    rpc.handler = (method, params) => {
      if (method === 'thread/read') return { thread: { historyMode: paginated ? 'paginated' : 'full', turns: [{ items: [{ type: 'agentMessage', id: 'a', text: 'saved' }] }] } };
      assert.equal(method, 'thread/items/list');
      const cursor = (params as { cursor: string | null }).cursor;
      return { data: [{ item: { type: 'agentMessage', id: cursor ? 'b' : 'a', text: cursor ? 'next' : 'saved' } }], nextCursor: cursor ? null : 'next' };
    };
    await sessions.history(session);
    assert.deepEqual(session.items.map(v => v.text), paginated ? ['saved', 'next'] : ['saved']);
    assert.equal(session.loaded, false);
    assert.equal(session.status, 'idle');
    assert.ok(rpc.calls.every(v => v.method === 'thread/read' || v.method === 'thread/items/list'));
  }
});

test('history rejects repeating pagination cursor without an infinite request loop', async () => {
  const { rpc, sessions, session } = setup();
  rpc.handler = method => method === 'thread/read' ? { thread: { historyMode: 'paginated' } } : { data: [], nextCursor: 'repeated' };
  await sessions.history(session);
  assert.equal(session.status, 'error');
  assert.equal(rpc.calls.length, 3);
});

test('send failure releases lock and disconnect invalidates prompts and loaded state', async () => {
  const { rpc, sessions, session } = setup();
  rpc.handler = () => { throw new Error('unavailable'); };
  await sessions.send(session, 'hello');
  assert.equal(session.status, 'error');
  assert.equal(session.busy, false);
  assert.deepEqual(rpc.calls.map(v => v.method), ['thread/resume']);
  rpc.handler = () => ({ turn: { id: 'new-turn' } });
  await sessions.send(session, 'retry');
  assert.equal(session.status, 'running');
  assert.equal(session.loaded, true);
  rpc.prompt(10, 'item/fileChange/requestApproval');
  rpc.events.emit('close');
  assert.equal(session.status, 'error');
  assert.equal(session.loaded, false);
  assert.equal(session.prompts.length, 0);
  sessions.dispose();
  assert.equal(rpc.events.listenerCount('notification'), 0);
  assert.equal(rpc.events.listenerCount('request'), 0);
});

test('terminal error notifications cannot unlock an unresolved send and create duplicate turns', async () => {
  const { rpc, sessions, session } = setup();
  session.loaded = true;
  let release!: (value: unknown) => void;
  rpc.handler = () => new Promise(resolve => { release = resolve; });
  const first = sessions.send(session, 'first');
  const releaseFirst = release;
  rpc.notification('error', { threadId: 'thread', willRetry: false, error: { message: 'Turn failed' } });
  const second = sessions.send(session, 'second');
  // Release both if the regression occurs so failure does not leave dangling work.
  releaseFirst({ turn: { id: 'first-turn' } });
  release({ turn: { id: 'second-turn' } });
  await Promise.all([first, second]);
  assert.equal(rpc.calls.filter(v => v.method === 'turn/start').length, 1);
});

test('history hydration blocks sending until saved messages are loaded', async () => {
  const { rpc, sessions, session } = setup();
  let release!: (value: unknown) => void;
  rpc.handler = (method, params) => {
    if (method === 'thread/read' && !(params as { includeTurns: boolean }).includeTurns) return new Promise(resolve => { release = resolve; });
    if (method === 'thread/read') return { thread: { turns: [{ items: [{ id: 'saved', type: 'agentMessage', text: 'history' }] }] } };
    if (method === 'thread/resume') return {};
    return { turn: { id: 'turn' } };
  };
  const hydration = sessions.history(session);
  const busyDuringHydration = session.busy;
  const prematureSend = await sessions.send(session, 'too early');
  release({ thread: { historyMode: 'full' } });
  await hydration;
  assert.equal(busyDuringHydration, true);
  assert.equal(prematureSend, false);
  assert.equal(session.busy, false);
  assert.deepEqual(session.items.map(item => item.text), ['history']);
  assert.ok(rpc.calls.every(call => call.method === 'thread/read'));
  assert.equal(await sessions.send(session, 'now ready'), true);
  assert.deepEqual(rpc.calls.slice(-2).map(call => call.method), ['thread/resume', 'turn/start']);
});

test('failed hydration releases its lock so a later send can recover', async () => {
  const { rpc, sessions, session } = setup();
  rpc.handler = () => { throw new Error('history unavailable'); };
  await sessions.history(session);
  assert.equal(session.busy, false);
  assert.equal(session.status, 'error');
  rpc.handler = method => method === 'thread/resume' ? {} : { turn: { id: 'turn' } };
  assert.equal(await sessions.send(session, 'recover'), true);
});

test('stop before resume completes prevents turn creation', async () => {
  const { rpc, sessions, session } = setup();
  let release!: (value: unknown) => void;
  rpc.handler = () => new Promise(resolve => { release = resolve; });
  const send = sessions.send(session, 'cancel before starting');
  await sessions.stop(session);
  release({});
  assert.equal(await send, false);
  assert.equal(session.status, 'idle');
  assert.equal(session.busy, false);
  assert.equal(session.stopRequested, undefined);
  assert.deepEqual(rpc.calls.map(call => call.method), ['thread/resume']);
});

test('stop during a failed resume does not cancel the next explicit send', async () => {
  const { rpc, sessions, session } = setup();
  let reject!: (error: Error) => void;
  rpc.handler = () => new Promise((_, fail) => { reject = fail; });
  const send = sessions.send(session, 'first');
  await sessions.stop(session);
  reject(new Error('resume failed'));
  assert.equal(await send, false);
  assert.equal(session.busy, false);
  assert.equal(session.stopRequested, undefined);
  rpc.handler = method => method === 'thread/resume' ? {} : { turn: { id: 'retry-turn' } };
  assert.equal(await sessions.send(session, 'retry'), true);
  assert.deepEqual(rpc.calls.map(call => call.method), ['thread/resume', 'thread/resume', 'turn/start']);
  assert.equal(session.turnId, 'retry-turn');
});

test('stop before turn ID arrives interrupts that turn when started notification arrives', async () => {
  const { rpc, sessions, session } = setup();
  session.loaded = true;
  let release!: (value: unknown) => void;
  rpc.handler = method => method === 'turn/start' ? new Promise(resolve => { release = resolve; }) : {};
  const send = sessions.send(session, 'start');
  await sessions.stop(session);
  rpc.notification('turn/started', { threadId: 'thread', turn: { id: 'turn' } });
  release({ turn: { id: 'turn' } });
  await send;
  assert.deepEqual(rpc.calls.map(call => call.method), ['turn/start', 'turn/interrupt']);
  assert.deepEqual(rpc.calls[1]?.params, { threadId: 'thread', turnId: 'turn' });
  rpc.notification('turn/completed', { threadId: 'thread', turn: { id: 'turn', status: 'interrupted' } });
  assert.equal(session.status, 'idle');
  assert.equal(session.stopRequested, undefined);
});

test('stopping a history read cannot cancel the next explicit message', async () => {
  const { rpc, sessions, session } = setup();
  let release!: (value: unknown) => void;
  rpc.handler = (method, params) => {
    if (method === 'thread/read' && !(params as { includeTurns: boolean }).includeTurns) return new Promise(resolve => { release = resolve; });
    if (method === 'thread/read') return { thread: { turns: [] } };
    if (method === 'thread/resume') return {};
    return { turn: { id: 'turn' } };
  };
  const history = sessions.history(session);
  await sessions.stop(session);
  release({ thread: { historyMode: 'legacy' } });
  await history;
  assert.equal(await sessions.send(session, 'after history'), true);
  assert.equal(rpc.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('disconnection during history loading does not report a failed agent task', async () => {
  const { rpc, sessions, session, notifications } = setup();
  let reject!: (error: Error) => void;
  rpc.handler = () => new Promise((_, fail) => { reject = fail; });
  const history = sessions.history(session);
  rpc.events.emit('close');
  reject(new Error('disconnected while reading history'));
  await history;
  assert.equal(session.status, 'error', 'history failure is still visible inside the tab');
  assert.deepEqual(notifications, [], 'there was no running agent task to notify about');
});
