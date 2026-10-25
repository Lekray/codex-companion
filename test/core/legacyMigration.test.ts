import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LEGACY_DRAFTS, preserveLegacyDraft, type StateStore } from '../../src/legacyMigration';

test('migration retains tab/thread metadata and saves unsent drafts separately', async () => {
  const old = [{ id: 'tab', title: 'Old title', threadId: 'old-thread', open: true }];
  const values = new Map<string, unknown>([['companion.tabs.v1', old], ['companion.counter', 3], [LEGACY_DRAFTS, { previous: 'Keep me' }]]);
  const writes: string[] = [];
  const store: StateStore = {
    get: <T>(key: string, fallback: T) => (values.has(key) ? values.get(key) : fallback) as T,
    update: async (key, value) => { writes.push(key); values.set(key, value); },
  };
  await preserveLegacyDraft(store, { id: 'tab', draft: 'Not sent yet' });
  assert.deepEqual(writes, [LEGACY_DRAFTS]);
  assert.equal(values.get('companion.tabs.v1'), old);
  assert.equal(values.get('companion.counter'), 3);
  assert.deepEqual(values.get(LEGACY_DRAFTS), { previous: 'Keep me', tab: 'Not sent yet' });
});

test('invalid or empty webview state does not rewrite storage', async () => {
  const store: StateStore = { get: <T>(_key: string, fallback: T) => fallback, update: async () => { throw new Error('Unexpected write'); } };
  for (const state of [null, {}, { id: 'tab' }, { id: 'tab', draft: '' }]) await preserveLegacyDraft(store, state);
});
