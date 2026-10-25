import assert from 'node:assert/strict';
import { AppServerClient } from '../src/appServer';
import { Sessions, record } from '../src/session';

/** One real read-only turn; archive only the synthetic thread created by this check. */
async function main(): Promise<void> {
  const client = () => new AppServerClient({ executable: process.env.CODEX_COMPANION_CLI ?? 'codex', cwd: process.cwd(), experimentalApi: true, timeoutMs: 30_000 });
  let rpc = client();
  let threadId: string | undefined;
  let manager: Sessions | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    await rpc.start();
    const reply = await rpc.request<{ thread: { id: string } }>('thread/start', { cwd: process.cwd(), modelProvider: 'openai', sandbox: 'read-only', approvalPolicy: 'never' });
    threadId = reply.thread.id;
    const finished = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('History fixture turn timed out')), 120_000);
      rpc.onNotification((method, raw) => {
        const params = record(raw);
        if (params.threadId === threadId && method === 'turn/completed') {
          if (record(params.turn).status === 'completed') resolve(); else reject(new Error('History fixture turn failed'));
        }
      });
    });
    void finished.catch(() => {});
    await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: 'Persistence integration test. Reply exactly HISTORY_OK. Do not use tools, read files, browse, delegate, or change anything.', text_elements: [] }] });
    await finished;
    clearTimeout(timer);
    await rpc.dispose();
    rpc = client();
    await rpc.start();
    const receivedEvents: string[] = [];
    rpc.onNotification((method, raw) => { if (record(raw).threadId === threadId) receivedEvents.push(method); });
    manager = new Sessions(rpc, process.cwd(), [{ id: 'history-fixture', title: 'Independent fixture title', threadId, open: true }], () => {}, () => {});
    const session = manager.all.get('history-fixture')!;
    await manager.history(session);
    assert.equal(session.status, 'idle');
    assert.equal(session.loaded, false, 'history load does not resume the thread');
    assert.equal(session.title, 'Independent fixture title');
    assert.ok(session.items.some(item => item.role === 'assistant' && item.text.trim() === 'HISTORY_OK'), 'real response survives a new App Server process');
    assert.ok(session.items.some(item => item.role === 'user'), 'user message survives');
    const loaded = await rpc.request<{ data: string[] }>('thread/loaded/list');
    assert.ok(!loaded.data.includes(threadId), 'restoration did not load a running agent');
    assert.ok(!receivedEvents.includes('turn/started'), 'restoration did not start work');
    console.log('Live persisted history: PASS (fresh server, saved user/assistant messages, no resume/start).');
  } finally {
    clearTimeout(timer);
    manager?.dispose();
    if (threadId) {
      try { await rpc.request('thread/archive', { threadId }); console.log('Synthetic history thread archived.'); }
      catch { console.error('Could not archive the synthetic history thread.'); process.exitCode = 1; }
    }
    await rpc.dispose();
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'History check failed'); process.exitCode = 1; });
