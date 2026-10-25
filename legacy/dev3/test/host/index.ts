import * as vscode from 'vscode';
import assert from 'node:assert/strict';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const tabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('codexCompanion.chat'));

async function eventually(check: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 20_000;
  while (!check() && Date.now() < end) await pause(100);
  assert.ok(check(), label);
}

export async function run(): Promise<void> {
  const stage = process.env.COMPANION_TEST_STAGE;
  const extension = vscode.extensions.getExtension('local-companion.codex-companion');
  assert.ok(extension);
  await extension.activate();
  assert.ok((await vscode.commands.getCommands(true)).includes('codexCompanion.open'));
  if (stage === 'create') {
    await vscode.commands.executeCommand('codexCompanion.open');
    await vscode.commands.executeCommand('codexCompanion.rename', 'Проверка 1');
    await vscode.commands.executeCommand('codexCompanion.open');
    await eventually(() => tabs().length === 2, 'two independent tabs');
    assert.deepEqual(tabs().map(tab => tab.label).sort(), ['Codex 2', 'Проверка 1'].sort());
    const second = tabs().find(tab => tab.label === 'Codex 2');
    assert.ok(second);
    await vscode.window.tabGroups.close(second);
    await eventually(() => tabs().length === 1, 'closed idle tab');
    await Promise.all([
      vscode.commands.executeCommand('codexCompanion.open'),
      vscode.commands.executeCommand('codexCompanion.open'),
    ]);
    await eventually(() => tabs().length === 3, 'concurrent opens create two tabs');
    assert.deepEqual(tabs().map(tab => tab.label).sort(), ['Проверка 1', 'Codex 3', 'Codex 4'].sort(), 'concurrent opens reserve distinct numbers');
    await vscode.window.tabGroups.close(tabs().filter(tab => tab.label.startsWith('Codex ')));
    await pause(500);
  } else {
    await eventually(() => tabs().some(tab => tab.label === 'Проверка 1'), 'restored tab and independent title; actual: ' + tabs().map(t => t.label).join(', '));
    assert.equal(tabs().length, 1);
    await vscode.commands.executeCommand('codexCompanion.open');
    await eventually(() => tabs().some(tab => tab.label === 'Codex 5'), 'project counter survives restart');
    assert.ok(tabs().every(tab => !tab.label.startsWith('[~]')), 'restored tasks do not start automatically');
  }
  console.log(`Companion extension-host ${stage}: PASS; Node ${process.version}`);
}
