import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin });
let initialized = false;
const pendingServer = new Map<string, number>();
const send = (value: unknown): void => { process.stdout.write(JSON.stringify(value) + '\n'); };
lines.on('line', line => {
  const message = JSON.parse(line) as { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'test' } });
  } else if (message.method === 'initialized') {
    initialized = true;
  } else if (message.method === 'echo') {
    setTimeout(() => send({ id: message.id, result: { ...message.params, initialized } }), Number(message.params?.delay ?? 0));
  } else if (message.method === 'fail') {
    send({ id: message.id, error: { code: 731, message: 'PRIVATE ACCOUNT DATA' } });
  } else if (message.method === 'malformed') {
    process.stdout.write('not valid JSON\n');
  } else if (message.method === 'missingResult') {
    send({ id: message.id });
  } else if (message.method === 'exit') {
    process.exit(0);
  } else if (message.method === 'serverRequest') {
    const id = `server-${message.id}`;
    pendingServer.set(id, Number(message.id));
    send({ id, method: 'future/unknown', params: { threadId: 'thread' } });
  } else if (typeof message.id === 'string' && pendingServer.has(message.id)) {
    send({ id: pendingServer.get(message.id), result: { result: message.result, error: message.error } });
    pendingServer.delete(message.id);
  }
});
lines.on('close', () => process.exit(0));
