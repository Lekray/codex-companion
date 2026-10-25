import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { AppServerClient, AppServerError } from '../../src/appServer';

function client(timeoutMs = 1000): AppServerClient {
  return new AppServerClient({ executable: process.execPath, args: [join(__dirname, '../fixtures/rpcServer.js')], cwd: process.cwd(), timeoutMs });
}

test('stdio handshake and concurrent responses preserve request association', async t => {
  const rpc = client();
  t.after(() => rpc.dispose());
  await assert.rejects(rpc.request('echo'), /not ready/);
  await rpc.start();
  const order: string[] = [];
  const slow = rpc.request<{ name: string; initialized: boolean }>('echo', { name: 'slow', delay: 40 }).then(v => { order.push(v.name); return v; });
  const fast = rpc.request<{ name: string; initialized: boolean }>('echo', { name: 'fast' }).then(v => { order.push(v.name); return v; });
  const replies = await Promise.all([slow, fast]);
  assert.deepEqual(order, ['fast', 'slow']);
  assert.deepEqual(replies.map(v => [v.name, v.initialized]), [['slow', true], ['fast', true]]);
  await assert.rejects(rpc.start(), /already been started/);
});

test('remote errors retain codes without exposing server text; malformed responses reject', async t => {
  const rpc = client();
  t.after(() => rpc.dispose());
  await rpc.start();
  await assert.rejects(rpc.request('fail'), (error: unknown) => {
    assert.ok(error instanceof AppServerError);
    assert.equal(error.code, 731);
    assert.doesNotMatch(error.message, /PRIVATE/);
    return true;
  });
  await assert.rejects(rpc.request('missingResult'), /no result/);
  await assert.rejects(rpc.request('malformed'), /Invalid JSON/);
  await assert.rejects(rpc.request('echo'), /not ready/);
});

test('timeouts ignore late replies and allow later requests', async t => {
  const rpc = client(500);
  t.after(() => rpc.dispose());
  await rpc.start();
  await assert.rejects(rpc.request('echo', { delay: 550 }), /timed out: echo/);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(await rpc.request('echo', { value: 9 }), { value: 9, initialized: true });
});

test('unhandled server requests fail closed and explicit replies are single use', async t => {
  const rpc = client();
  t.after(() => rpc.dispose());
  await rpc.start();
  assert.deepEqual(await rpc.request('serverRequest'), { error: { code: -32601, message: 'Unsupported client request' } });
  const remove = rpc.onRequest(request => {
    rpc.respond(request.id, { decision: 'decline' });
    assert.throws(() => rpc.respond(request.id, { decision: 'accept' }), /already been answered/);
  });
  assert.deepEqual(await rpc.request('serverRequest'), { result: { decision: 'decline' } });
  remove();
});

test('disposal rejects in-flight requests and emits close exactly once', async () => {
  const rpc = client();
  let closed = 0;
  rpc.onClose(() => closed++);
  await rpc.start();
  const rejected = assert.rejects(rpc.request('never'), /disposed/);
  await rpc.dispose();
  await rejected;
  await rpc.dispose();
  assert.equal(closed, 1);
  await assert.rejects(rpc.request('echo'), /not ready/);
});

test('unexpected process exit rejects pending requests', async t => {
  const rpc = client();
  t.after(() => rpc.dispose());
  await rpc.start();
  const pending = assert.rejects(rpc.request('never'), /exited/);
  await assert.rejects(rpc.request('exit'), /exited/);
  await pending;
});
