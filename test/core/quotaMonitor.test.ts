import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { QuotaMonitor, type QuotaClient } from '../../src/quotaMonitor';

class Client implements QuotaClient {
  events = new EventEmitter();
  calls: string[] = [];
  ended = false;
  value: unknown = { rateLimits: { primary: { usedPercent: 11 } } };
  async start(): Promise<void> {}
  async request(method: string): Promise<unknown> { this.calls.push(method); return this.value; }
  onNotification(listener: (method: string, params: unknown) => void): () => void { this.events.on('notification', listener); return () => { this.events.off('notification', listener); }; }
  onClose(listener: () => void): () => void { this.events.on('close', listener); return () => { this.events.off('close', listener); }; }
  async dispose(): Promise<void> { this.ended = true; }
}

test('quota monitoring issues no thread or turn requests and deduplicates refreshes', async () => {
  const client = new Client();
  const monitor = new QuotaMonitor(() => client, () => {});
  await Promise.all([monitor.refresh(), monitor.refresh()]);
  assert.deepEqual(client.calls, ['account/rateLimits/read']);
  assert.equal(monitor.state.buckets[0]?.primary?.usedPercent, 11);
  assert.equal(monitor.state.stale, false);
  await monitor.dispose();
});

test('a disconnected quota process is replaced on the next refresh', async () => {
  const clients: Client[] = [];
  const monitor = new QuotaMonitor(() => { const client = new Client(); clients.push(client); return client; }, () => {});
  await monitor.refresh();
  clients[0]!.events.emit('close');
  assert.equal(monitor.state.stale, true);
  await monitor.refresh();
  assert.equal(clients.length, 2);
  assert.equal(clients[0]!.ended, true);
  assert.equal(monitor.state.stale, false);
  await monitor.dispose();
});

test('disposal during startup cannot issue a later quota request', async () => {
  const client = new Client();
  let release!: () => void;
  client.start = () => new Promise(resolve => { release = resolve; });
  const monitor = new QuotaMonitor(() => client, () => {});
  const pending = monitor.refresh();
  await monitor.dispose();
  release(); await pending;
  assert.deepEqual(client.calls, []);
  assert.equal(client.ended, true);
});

test('an account change invalidates an in-flight result and queues a fresh read', async () => {
  const client = new Client();
  let release!: (value: unknown) => void;
  let reads = 0;
  client.request = async () => {
    reads++;
    return reads === 1 ? new Promise(resolve => { release = resolve; }) : { rateLimits: { primary: { usedPercent: 5 } } };
  };
  const shown: number[] = [];
  const monitor = new QuotaMonitor(() => client, () => {
    const percent = monitor.state.buckets[0]?.primary?.usedPercent;
    if (percent !== undefined) shown.push(percent);
  });
  const pending = monitor.refresh();
  await new Promise(resolve => setImmediate(resolve));
  client.events.emit('notification', 'account/updated', {});
  release({ rateLimits: { primary: { usedPercent: 99 } } });
  await pending;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(shown, [5]);
  assert.equal(reads, 2);
  await monitor.dispose();
});
