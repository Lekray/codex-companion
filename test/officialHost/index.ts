import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check: () => Promise<boolean> | boolean, label: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    try { if (await check()) return; } catch { /* Wait for the asynchronously created artifact. */ }
    await delay(100);
  }
  throw new Error(label);
}
const tabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs);
const officialTabs = () => tabs().filter(tab => tab.input instanceof vscode.TabInputCustom && tab.input.viewType === 'chatgpt.conversationEditor');
const customTabs = () => tabs().filter(tab => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes('codexCompanion.chat'));

export async function run(): Promise<Record<string, unknown>> {
  const companion = vscode.extensions.getExtension('local-companion.codex-companion');
  assert.ok(companion);
  await companion.activate();
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('codexCompanion.open'));
  assert.ok(commands.includes('codexCompanion.projectHistory'));
  assert.ok(!commands.includes('codexCompanion.rename'));
  assert.ok(!commands.includes('codexCompanion.history'));
  assert.equal(customTabs().length, 0);
  await vscode.commands.executeCommand('codexCompanion.open');
  const real = process.env.COMPANION_OFFICIAL_REAL === '1';
  if (real) await eventually(async () => officialTabs().length > 0, 'Official custom editor did not open');
  else assert.equal((vscode.extensions.getExtension('openai.chatgpt')!.exports as { opened(): number }).opened(), 1);
  let renameProbe: unknown;
  let multipleProbe: unknown;
  if (real && process.env.COMPANION_MULTIPLE_PROBE === '1') {
    const original = (officialTabs()[0]!.input as vscode.TabInputCustom).uri;
    const before = officialTabs().length;
    const identities: string[] = [];
    for (let index = 0; index < 2; index++) {
      const resource = process.env.COMPANION_FRAGMENT_PROBE === '1'
        ? original.with({ query: '', fragment: `companion-${Date.now()}-${index}` })
        : original.with({ query: `companionProbe=${Date.now()}-${index}` });
      await vscode.commands.executeCommand('vscode.openWith', resource, 'chatgpt.conversationEditor', { preview: false });
      await eventually(() => officialTabs().length === before + index + 1, 'Distinct document probe did not create another editor');
      identities.push(resource.toString());
    }
    multipleProbe = { original: original.toString(), count: officialTabs().length, identities };
  }
  if (real && process.env.COMPANION_RENAME_PROBE === '1') {
    const tab = officialTabs()[0]!;
    const resource = (tab.input as vscode.TabInputCustom).uri;
    const before = tab.label;
    const settings = vscode.workspace.getConfiguration('workbench.editor.customLabels');
    await settings.update('enabled', true, vscode.ConfigurationTarget.Workspace);
    await settings.update('patterns', { ['**' + resource.path]: 'Companion pattern probe' }, vscode.ConfigurationTarget.Workspace);
    await delay(1000);
    const afterPattern = officialTabs()[0]?.label;
    let labelError = false;
    try { await vscode.commands.executeCommand('vscode.open', resource, { preview: false }, 'Companion open-label probe'); }
    catch { labelError = true; }
    await delay(500);
    renameProbe = { uriPath: resource.path, before, afterPattern, afterOpenLabel: officialTabs()[0]?.label, labelError,
      candidateCommands: commands.filter(command => /rename.*editor|editor.*rename|custom.*label/i.test(command)) };
  }
  await vscode.commands.executeCommand('codexCompanion.open');
  if (real && process.env.COMPANION_MULTIPLE_PROBE !== '1') await eventually(() => officialTabs().length === 2, 'Two clicks must create two official tabs');
  if (!real) assert.equal((vscode.extensions.getExtension('openai.chatgpt')!.exports as { opened(): number }).opened(), 2);
  await vscode.commands.executeCommand('codexCompanion.refreshQuotas');
  const log = join(vscode.workspace.workspaceFolders![0]!.uri.fsPath, 'quota-rpc.jsonl');
  await eventually(async () => (await readFile(log, 'utf8')).includes('account/rateLimits/read'), 'Quota read not observed');
  const methods = (await readFile(log, 'utf8')).trim().split('\n').map(line => (JSON.parse(line) as { method: string }).method);
  assert.ok(methods.every(method => ['initialize', 'initialized', 'account/rateLimits/read'].includes(method)), 'Quota process tried to manage a thread');
  assert.equal(customTabs().length, 0, 'Companion must not create its own chat UI');
  return { passed: true, customChatTabs: customTabs().length, officialEditorTabs: officialTabs().length, quotaOnly: true, ...(renameProbe ? { renameProbe } : {}), ...(multipleProbe ? { multipleProbe } : {}) };
}
