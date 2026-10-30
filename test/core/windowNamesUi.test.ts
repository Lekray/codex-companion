import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WindowNamesUi, type WindowNamesDependencies } from '../../src/windowNamesUi';

function fixture() {
  const windows = [{ panelId: 'a', title: 'Проект', active: true }, { panelId: 'b', title: 'Второе', active: false }];
  let state = { instanceId: 'host', windows };
  const writes: unknown[] = [], warnings: string[] = [], inputs: string[] = [];
  const deps: WindowNamesDependencies = {
    allowed: async () => true, getWindows: async () => state,
    pick: async () => ({ panelId: 'b' }), input: async value => { inputs.push(value); return '  Новое имя  '; },
    rename: async data => { writes.push(data); return true; }, warn: message => warnings.push(message),
  };
  return { deps, writes, warnings, inputs, windows, setState: (next: typeof state) => { state = next; },
    ui: new WindowNamesUi(deps, true) };
}

test('rename uses active panel and trims input without renaming another panel', async () => {
  const f = fixture(); await f.ui.rename();
  assert.deepEqual(f.inputs, ['Проект']);
  assert.deepEqual(f.writes, [{ instanceId: 'host', panelId: 'a', title: 'Новое имя' }]);
});
test('rename chooses only panel or picker when none is active', async () => {
  const f = fixture(); f.windows[0]!.active = false; await f.ui.rename();
  assert.deepEqual(f.inputs, ['Второе']);
  f.inputs.length = 0; f.windows.pop(); await f.ui.rename(); assert.deepEqual(f.inputs, ['Проект']);
});
test('rename cancel and empty inputs do nothing', async () => {
  for (const value of [undefined, '', '  ']) {
    const f = fixture(); f.deps.input = async () => value; await f.ui.rename();
    assert.equal(f.writes.length, 0); assert.equal(f.warnings.length, 0);
  }
});
test('focus change during input keeps the captured target', async () => {
  const f = fixture(); f.deps.input = async () => {
    f.windows[0]!.active = false; f.windows[1]!.active = true; return 'Pinned';
  };
  await f.ui.rename(); assert.deepEqual(f.writes, [{ instanceId: 'host', panelId: 'a', title: 'Pinned' }]);
});
test('closed target or changed extension instance refuses rename', async () => {
  for (const restart of [true, false]) {
    const f = fixture(); f.deps.input = async () => {
      if (restart) f.setState({ instanceId: 'another', windows: f.windows });
      else f.windows.shift();
      return 'Wrong';
    };
    await f.ui.rename(); assert.equal(f.writes.length, 0); assert.equal(f.warnings.length, 1);
  }
});
test('compatibility loss and save failure do not report success', async () => {
  const f = fixture(); f.deps.input = async () => { f.deps.allowed = async () => false; return 'Blocked'; };
  await f.ui.rename(); assert.equal(f.writes.length, 0);
  const g = fixture(); g.deps.rename = async () => false; await g.ui.rename(); assert.equal(g.warnings.length, 1);
});
