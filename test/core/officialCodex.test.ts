import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openOfficialCodex, OFFICIAL_EXTENSION, OFFICIAL_OPEN_COMMAND, VERIFIED_EDITOR_VERSION, type OfficialHost } from '../../src/officialCodex';

test('verified official version opens distinct documents with different identities on every click', async () => {
  const identities: string[] = [];
  let active = false;
  const host: OfficialHost = {
    extension: () => ({ version: VERIFIED_EDITOR_VERSION, activate: async () => { active = true; } }),
    commands: async () => [OFFICIAL_OPEN_COMMAND],
    execute: async () => { assert.fail('Fixed-URI command must not run on the verified version'); },
    openDistinctEditor: async id => { assert.ok(active); identities.push(id); },
  };
  assert.equal(await openOfficialCodex(host, true), 'distinct');
  await openOfficialCodex(host, true);
  assert.equal(new Set(identities).size, 2);
  for (const id of identities) assert.match(id, /^[0-9a-f-]{36}$/);
});

test('unverified versions use the public command without attempting a private route', async () => {
  const calls: string[] = [];
  assert.equal(await openOfficialCodex({
    extension: () => ({ version: '99.0.0', activate: async () => {} }),
    commands: async () => [OFFICIAL_OPEN_COMMAND], execute: async command => { calls.push(command); },
    openDistinctEditor: async () => { assert.fail('Unverified URI adapter'); },
  }, false), 'standard');
  assert.deepEqual(calls, [OFFICIAL_OPEN_COMMAND]);
});

test('opening delegates to the exact public command after official activation', async () => {
  const calls: string[] = [];
  const host: OfficialHost = {
    extension: id => { calls.push(id); return { activate: async () => { calls.push('activate'); } }; },
    commands: async () => { calls.push('commands'); return [OFFICIAL_OPEN_COMMAND]; },
    execute: async command => { calls.push(command); },
  };
  await openOfficialCodex(host, true);
  assert.deepEqual(calls, [OFFICIAL_EXTENSION, 'activate', 'commands', OFFICIAL_OPEN_COMMAND]);
});

test('missing official extension never falls back to an unofficial chat', async () => {
  let called = false;
  await assert.rejects(openOfficialCodex({ extension: () => undefined, commands: async () => [], execute: async () => { called = true; } }, false), /official Codex/);
  assert.equal(called, false);
});

test('incompatible official version produces an explicit error without invoking another UI', async () => {
  let called = false;
  await assert.rejects(openOfficialCodex({ extension: () => ({ activate: async () => {} }), commands: async () => ['chatgpt.openSidebar'], execute: async () => { called = true; } }, true), /недоступна команда/);
  assert.equal(called, false);
});
