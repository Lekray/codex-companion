import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

// Synthetic protocol peer for real VS Code UI tests. It never calls a model or executes tools.
const file = (name: string) => join(process.cwd(), name);
const threads = new Map<string, { id: string; turns: { id: string; status: string; items: unknown[] }[] }>();
const pending = new Map<string, { threadId: string; turnId: string }>();
let sequence = 0;
const output = (message: unknown) => process.stdout.write(JSON.stringify(message) + '\n');
const event = (method: string, params: unknown) => output({ method, params });
const log = (message: unknown) => appendFileSync(file('rpc.jsonl'), JSON.stringify(message) + '\n');
const persist = () => writeFileSync(file('fixture-history.json'), JSON.stringify([...threads]));
if (existsSync(file('fixture-history.json'))) {
  for (const [id, value] of JSON.parse(readFileSync(file('fixture-history.json'), 'utf8'))) threads.set(id, value);
  sequence = threads.size * 100;
}
function finish(threadId: string, turnId: string, status = 'completed'): void {
  const turn = threads.get(threadId)?.turns.find(t => t.id === turnId);
  if (!turn || turn.status !== 'inProgress') return;
  const item = { id: `answer-${turnId}`, type: 'agentMessage', text: status === 'completed' ? 'Fixture completed.' : 'Fixture interrupted.' };
  turn.items.push(item);
  turn.status = status;
  event('item/completed', { threadId, turnId, item });
  event('turn/completed', { threadId, turn });
  persist();
}
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  const p = message.params ?? {};
  log(message);
  const result = (value: unknown) => output({ id: message.id, result: value });
  if (message.method === 'initialize') result({ userAgent: 'companion-workbench-test' });
  else if (message.method === 'initialized') return;
  else if (message.method === 'account/rateLimits/read') result({ rateLimits: { limitId: 'fixture', primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } });
  else if (message.method === 'thread/start') {
    const thread = { id: `thread-${++sequence}`, turns: [] };
    threads.set(thread.id, thread); persist(); result({ thread });
  } else if (message.method === 'thread/resume' || message.method === 'thread/read') {
    result({ thread: { ...threads.get(p.threadId), historyMode: 'legacy' } });
  } else if (message.method === 'turn/start') {
    const turn = { id: `turn-${++sequence}`, status: 'inProgress', items: [{ id: `user-${sequence}`, type: 'userMessage', content: p.input }] as unknown[] };
    const thread = threads.get(p.threadId)!;
    thread.turns.push(turn); persist();
    result({ turn });
    event('turn/started', { threadId: p.threadId, turn });
    event('item/completed', { threadId: p.threadId, turnId: turn.id, item: turn.items[0] });
    const text = p.input[0].text;
    if (text === 'approve' || text === 'question') {
      const id = `prompt-${sequence}`;
      pending.set(id, { threadId: p.threadId, turnId: turn.id });
      output({ id, method: text === 'approve' ? 'item/commandExecution/requestApproval' : 'item/tool/requestUserInput', params: {
        threadId: p.threadId, turnId: turn.id, itemId: id,
        ...(text === 'approve' ? { command: 'echo fixture', cwd: process.cwd(), reason: 'Synthetic approval; no command will execute.' }
          : { questions: [{ id: 'choice', question: 'Choose the fixture response', options: [{ label: 'Proceed', description: 'Finish the synthetic turn' }] }], isBlocking: true }),
      } });
    } else if (text === 'complete') setTimeout(() => finish(p.threadId, turn.id), 200);
  } else if (message.method === 'turn/interrupt') {
    result({}); finish(p.threadId, p.turnId, 'interrupted');
  } else if (!message.method && pending.has(message.id)) {
    const turn = pending.get(message.id)!;
    pending.delete(message.id);
    finish(turn.threadId, turn.turnId);
  } else result({});
});
let control = '';
const timer = setInterval(() => {
  if (!existsSync(file('control.json'))) return;
  const text = readFileSync(file('control.json'), 'utf8');
  if (text === control) return;
  control = text;
  try {
    const command = JSON.parse(text);
    if (command.action === 'complete') for (const thread of threads.values()) for (const turn of thread.turns) finish(thread.id, turn.id);
    if (command.action === 'exit') process.exit(0);
  } catch { /* Wait for an atomic control-file write. */ }
}, 50);
lines.on('close', () => { clearInterval(timer); process.exit(0); });
