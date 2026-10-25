import { AppServerClient } from '../src/appServer';
import { record } from '../src/session';

/** Explicit live check: one ephemeral, read-only turn, no tools requested. */
async function main(): Promise<void> {
  const rpc = new AppServerClient({ executable: process.env.CODEX_COMPANION_CLI ?? 'codex', cwd: process.cwd(), timeoutMs: 30_000, experimentalApi: true });
  let timer: NodeJS.Timeout | undefined;
  try {
    await rpc.start();
    const { thread } = await rpc.request<{ thread: { id: string } }>('thread/start', { cwd: process.cwd(), modelProvider: 'openai', ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never' });
    const events = new Set<string>();
    let text = '';
    const finished = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Live chat check timed out')), 90_000);
      rpc.onNotification((method, raw) => {
        const params = record(raw);
        if (params.threadId !== thread.id) return;
        events.add(method);
        if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') text += params.delta;
        if (method === 'turn/completed') {
          if (record(params.turn).status === 'completed') resolve(); else reject(new Error('Live turn did not complete'));
        }
      });
    });
    // Attach rejection immediately, even if turn/start itself is still waiting.
    void finished.catch(() => {});
    await rpc.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'Integration smoke test. Reply with exactly OK. Do not use tools, read files, browse, delegate, or modify anything.', text_elements: [] }] });
    await finished;
    console.log(JSON.stringify({ completed: true, receivedText: text.trim() === 'OK', events: [...events] }, null, 2));
    if (text.trim() !== 'OK') process.exitCode = 1;
  } finally { clearTimeout(timer); await rpc.dispose(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Live check failed'); process.exitCode = 1; });
