import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium, type Browser } from 'playwright-core';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>, message: string): Promise<void> {
  for (let i = 0; i < 150; i++) { try { if (await check()) return; } catch {} await pause(100); }
  throw new Error(message);
}
function seedProjectHistory(home: string, workspace: string, base: string): void {
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  try {
    db.exec(`CREATE TABLE threads (
      "id" TEXT, "cwd" TEXT, "name" TEXT, "title" TEXT,
      "updated_at" INTEGER, "updated_at_ms" INTEGER, "recency_at_ms" INTEGER,
      "archived" INTEGER, "has_user_event" INTEGER, "model_provider" TEXT,
      "history_mode" TEXT, "preview" TEXT, "first_user_message" TEXT, "rollout_path" TEXT
    )`);
    const insert = db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const rows: (string | number | null)[][] = [
      ['11111111-1111-4111-8111-111111111111', workspace, 'History matching conversation', 'Old history title', 1000, null, 4000, 0, 1, 'openai', 'paginated', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL'],
      ['22222222-2222-4222-8222-222222222222', join(workspace, 'nested'), '', 'History nested conversation', 9000, null, null, 0, 1, 'openai', 'legacy', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL'],
      ['33333333-3333-4333-8333-333333333333', workspace, 'History archived conversation', '', 2000, null, 9000, 1, 1, 'openai', 'paginated', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL'],
      ['44444444-4444-4444-8444-444444444444', workspace, 'History eventless conversation', '', 2000, null, 9500, 0, 0, 'openai', 'paginated', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL'],
      ['55555555-5555-4555-8555-555555555555', workspace + '-extra', 'History sibling conversation', '', 2000, null, 10_000, 0, 1, 'openai', 'paginated', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL'],
      ['66666666-6666-4666-8666-666666666666', join(base, 'other-workspace'), 'History foreign conversation', '', 2000, null, 11_000, 0, 1, 'openai', 'paginated', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL'],
      ['not-a-uuid', workspace, 'History invalid id', '', 2000, null, 12_000, 0, 1, 'openai', 'paginated', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL'],
      ['77777777-7777-4777-8777-777777777777', 'relative\\folder', 'History relative path', '', 2000, null, 13_000, 0, 1, 'openai', 'paginated', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL'],
    ];
    for (const row of rows) insert.run(...row);
  } finally {
    db.close();
  }
}
async function main(): Promise<void> {
  delete process.env.ELECTRON_RUN_AS_NODE;
  const official = process.env.COMPANION_OFFICIAL_EXTENSION;
  if (!official) throw new Error('Set COMPANION_OFFICIAL_EXTENSION');
  // Opt-in local diagnostic only: use existing auth in place, never copy credentials.
  const authProbeHome = process.env.COMPANION_AUTHENTICATED_PROBE_HOME;
  const root = resolve(__dirname, '../..');
  const base = join(root, '.artifacts', 'project-history-tests', `launcher-ui-${Date.now()}`);
  const profile = join(base, 'profile');
  const workspace = join(base, 'workspace');
  const driver = join(base, 'driver');
  const state = join(base, 'state.json');
  const historyFixture = join(base, 'history-fixture');
  await Promise.all([join(profile, 'User'), workspace, driver, join(base, 'codex-home'), historyFixture].map(path => mkdir(path, { recursive: true })));
  if (authProbeHome) {
    await mkdir(join(profile, 'User/globalStorage'), { recursive: true });
    const db = new DatabaseSync(join(profile, 'User/globalStorage/state.vscdb'));
    db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
    db.prepare('INSERT INTO ItemTable (key,value) VALUES (?,?)').run('openai.chatgpt', JSON.stringify({
      'viewed2025-09-15-nux': true, 'viewed2025-09-15-full-chatgpt-auth-nux': true,
    }));
    db.close();
  }
  await writeFile(join(workspace, 'example.txt'), 'Companion launcher test\n');
  seedProjectHistory(historyFixture, workspace, base);
  await writeFile(join(workspace, 'app-server'), `const readline=require('readline');const rl=readline.createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialized')return;const now=Math.floor(Date.now()/1000);const result=m.method==='initialize'?{userAgent:'ui-quota-fixture'}:{rateLimits:{primary:{usedPercent:27,windowDurationMins:300,resetsAt:now+7200},secondary:{usedPercent:9,windowDurationMins:10080,resetsAt:now+500000}}};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});rl.on('close',()=>process.exit(0));`);
  await writeFile(join(profile, 'User/settings.json'), JSON.stringify({ 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'codexCompanion.cliPath': process.execPath }));
  await writeFile(join(driver, 'package.json'), JSON.stringify({ name: 'launcher-ui-driver', publisher: 'local-test', version: '0.0.1', main: './index.js', engines: { vscode: '^1.139.0' }, activationEvents: ['onStartupFinished'], extensionDependencies: ['local-companion.codex-companion'], contributes: { keybindings: [{ command: 'launcherUi.quit', key: 'ctrl+alt+f5' }, { command: 'launcherUi.closeActive', key: 'ctrl+alt+f9' }, { command: 'launcherUi.routeProbe', key: 'ctrl+alt+f8' }, { command: 'launcherUi.firstOfficial', key: 'ctrl+alt+f7' }, { command: 'launcherUi.open', key: 'ctrl+alt+f6' }] } }));
  await writeFile(join(driver, 'index.js'), `exports.activate=async()=>{
    const vscode=require('vscode'), fs=require('fs');
    await vscode.extensions.getExtension('local-companion.codex-companion').activate();
    // The official subprocess already owns its isolated home. Only the history
    // reader in this test host uses the synthetic index; never feed an incomplete
    // fixture schema to the real app-server migration code.
    ${authProbeHome ? '' : `process.env.CODEX_HOME=${JSON.stringify(historyFixture)};`}
    vscode.commands.registerCommand('launcherUi.closeActive', async()=>{const tab=vscode.window.tabGroups.activeTabGroup.activeTab;if(tab?.input instanceof vscode.TabInputCustom&&tab.input.viewType==='chatgpt.conversationEditor')await vscode.window.tabGroups.close(tab);});
    vscode.commands.registerCommand('launcherUi.quit',()=>vscode.commands.executeCommand('workbench.action.quit'));
    vscode.commands.registerCommand('launcherUi.open',()=>vscode.commands.executeCommand('codexCompanion.open'));
    vscode.commands.registerCommand('launcherUi.firstOfficial',async()=>{const tab=vscode.window.tabGroups.all.flatMap(g=>g.tabs).find(t=>t.input instanceof vscode.TabInputCustom&&t.input.viewType==='chatgpt.conversationEditor');if(tab)await vscode.commands.executeCommand('vscode.openWith',tab.input.uri,'chatgpt.conversationEditor',{preview:false});});
    let probeIndex=${process.env.COMPANION_LOCAL_DRAFT_PROBE === '1' ? 4 : 0};
    vscode.commands.registerCommand('launcherUi.routeProbe', async()=>{const mode=probeIndex++;const resource=vscode.Uri.from({scheme:'openai-codex',authority:'route',path:mode===4?'/local/client-new-thread:companion-probe':mode===3?'/':'/extension/panel/new',query:mode===1||mode===3?'companion=probe':'',fragment:mode===2?'companion-probe':''});await vscode.commands.executeCommand('vscode.openWith',resource,'chatgpt.conversationEditor',{preview:false});});
    const save=()=>{const tabs=vscode.window.tabGroups.all.flatMap(g=>g.tabs);const official=tabs.filter(t=>t.input instanceof vscode.TabInputCustom&&t.input.viewType==='chatgpt.conversationEditor');const custom=tabs.filter(t=>t.input instanceof vscode.TabInputWebview&&t.input.viewType.includes('codexCompanion.chat'));fs.writeFileSync(${JSON.stringify(state)},JSON.stringify({official:official.length,custom:custom.length,uris:official.map(t=>t.input.uri.toString())}));};
    vscode.window.tabGroups.onDidChangeTabs(save); save();
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(${JSON.stringify(join(workspace, 'example.txt'))})));
  };`);
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const log = createWriteStream(join(base, 'vscode.log'));
  const child = spawn(process.env.CODEX_COMPANION_VSCODE ?? join(process.env.LOCALAPPDATA ?? '', 'Programs/Microsoft VS Code/Code.exe'), [workspace, '--user-data-dir', profile, '--extensions-dir', join(base, 'extensions'),
    `--extensionDevelopmentPath=${root}`, `--extensionDevelopmentPath=${official}`, `--extensionDevelopmentPath=${driver}`, `--remote-debugging-port=${port}`,
    '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--locale=en'],
  { windowsHide: true, env: { ...process.env, HOME: base, USERPROFILE: base, CODEX_HOME: authProbeHome ?? join(base, 'codex-home') }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log); child.stderr.pipe(log);
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  let browser: Browser | undefined;
  try {
    await until(async () => { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); return true; }, 'No test debug endpoint');
    await until(async () => browser!.contexts().flatMap(c => c.pages()).some(p => p.url().includes('workbench')), 'No workbench page');
    const page = browser!.contexts().flatMap(c => c.pages()).find(p => p.url().includes('workbench'))!;
    page.setDefaultTimeout(15_000);
    const snapshot = async () => JSON.parse(await readFile(state, 'utf8')) as { official: number; custom: number; uris: string[] };
    await until(async () => (await snapshot()).official === 0, 'Initial editor must be empty');
    if (authProbeHome && process.env.COMPANION_ONBOARDING_VERIFY === '1') {
      let excludedFrameUrl: string | undefined;
      let sharedDraft = false;
      const visibleComposer = async () => {
        for (const frame of page.frames().filter(frame => frame !== page.mainFrame())) {
          if (frame.url() === excludedFrameUrl) continue;
          if (!await (await frame.frameElement()).isVisible().catch(() => false)) continue;
          const announcement = frame.getByRole('button', { name: 'Continue with current model', exact: true });
          if (await announcement.isVisible().catch(() => false)) await announcement.click();
          const input = frame.locator('[contenteditable="true"]').first();
          if (await input.isVisible().catch(() => false)) return input;
        }
        return undefined;
      };
      for (const index of [1, 2]) {
        await page.keyboard.press('Control+Alt+F6');
        await until(async () => (await snapshot()).official === index, 'Production opener must add a tab');
        await until(async () => !!await visibleComposer(), 'Official composer did not become visible');
        for (const frame of page.frames()) assert.equal(await frame.getByRole('button', { name: 'Next', exact: true }).isVisible().catch(() => false), false, 'Tutorial must not appear');
        const input = (await visibleComposer())!;
        const initial = (await input.innerText()).trim();
        if (index === 1) assert.equal(initial, '', 'Diagnostic must start with an empty test-profile draft');
        else {
          assert.ok(initial === '' || initial === 'Companion isolated draft 1', 'Unexpected draft in test profile');
          sharedDraft = initial === 'Companion isolated draft 1';
        }
        await input.fill(`Companion isolated draft ${index}`);
        if (index === 1) excludedFrameUrl = await input.evaluate(() => location.href);
        if (index === 2) await input.fill('');
      }
      excludedFrameUrl = undefined;
      await page.keyboard.press('Control+Alt+F7');
      await until(async () => !!await visibleComposer(), 'First panel composer did not return');
      const first = (await visibleComposer())!;
      const remaining = (await first.innerText()).trim();
      assert.ok(remaining === '' || remaining === 'Companion isolated draft 1', 'Unexpected content after switching back');
      await first.fill('');
      await page.screenshot({ path: join(base, 'onboarding-verified.png') });
      const result = { officialTabs: 2, tutorial: false, draftsSharedBeforeFirstMessage: sharedDraft, modelTasksSent: 0 };
      await writeFile(join(base, 'onboarding-verification.json'), JSON.stringify(result));
      console.log(JSON.stringify({ ...result, artifacts: base }));
      await page.keyboard.press('Control+Alt+F5');
      return;
    }
    if (authProbeHome) {
      const probes: unknown[] = [];
      for (const mode of process.env.COMPANION_LOCAL_DRAFT_PROBE === '1' ? ['local-draft'] : ['plain', 'query', 'fragment', 'home']) {
        await page.keyboard.press('Control+Alt+F8');
        await until(async () => (await snapshot()).official === 1, 'Probe editor did not open');
        await pause(8000);
        let tutorial = false, composer = false, signIn = false;
        for (const frame of page.frames()) {
          tutorial ||= await frame.getByRole('button', { name: 'Next', exact: true }).isVisible().catch(() => false);
          signIn ||= await frame.getByRole('button', { name: 'Sign in with ChatGPT', exact: true }).isVisible().catch(() => false);
          composer ||= await frame.locator('[contenteditable="true"]').first().isVisible().catch(() => false);
        }
        probes.push({ mode, tutorial, composer, signIn });
        await page.screenshot({ path: join(base, `onboarding-${mode}.png`) });
        await page.keyboard.press('Control+Alt+F9');
        await until(async () => (await snapshot()).official === 0, 'Probe editor did not close');
      }
      await writeFile(join(base, 'onboarding-probe.json'), JSON.stringify(probes, null, 2));
      console.log(JSON.stringify({ probes, artifacts: base }));
      await page.keyboard.press('Control+Alt+F5');
      return;
    }
    const header = page.locator('.editor-actions').getByRole('button', { name: 'Open Window', exact: true });
    await header.waitFor({ state: 'visible' });
    // Dismiss VS Code's startup/update popover before clicking the editor toolbar.
    await page.locator('.monaco-editor').first().click({ position: { x: 100, y: 100 } });
    await page.keyboard.press('Escape');
    await page.mouse.move(0, 0);
    assert.equal(await page.getByRole('button', { name: 'Open official Codex window', exact: true }).count(), 0, 'No launcher in status bar');
    await header.click();
    await until(async () => (await snapshot()).official === 1, 'Top-right editor action did not open official editor');
    assert.equal((await snapshot()).custom, 0);
    // The same top-right action must remain available in the official Codex editor.
    await page.keyboard.press('Escape');
    await page.mouse.move(0, 0);
    await header.click();
    await until(async () => (await snapshot()).official === 2, 'Second click must add a separate official editor');
    assert.equal((await snapshot()).custom, 0);
    await page.screenshot({ path: join(base, 'launcher.png') });
    const status = page.getByRole('button', { name: /^Codex · 5h: 27%/ });
    await status.click();
    const menu = page.locator('.quick-input-widget');
    await menu.getByText('Refresh quota', { exact: true }).waitFor({ state: 'visible' });
    await menu.getByText('New window', { exact: true }).waitFor({ state: 'visible' });
    await menu.getByText('Project History', { exact: true }).waitFor({ state: 'visible' });
    await menu.getByText('Reopen closed window', { exact: true }).waitFor({ state: 'visible' });
    await menu.getByText('Open windows', { exact: true }).waitFor({ state: 'visible' });
    await page.screenshot({ path: join(base, 'quota-menu.png') });
    await menu.getByText('Refresh quota', { exact: true }).click();
    await menu.getByText('New window', { exact: true }).waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Alt+F9');
    await until(async () => (await snapshot()).official === 1, 'Only the active official editor should close');
    await status.click();
    await menu.getByText('Reopen closed window', { exact: true }).waitFor({ state: 'visible' });
    const reopenInput = menu.locator('input').first();
    await reopenInput.fill('Reopen closed window');
    assert.equal(await reopenInput.inputValue(), 'Reopen closed window');
    await menu.getByText('Reopen closed window', { exact: true }).waitFor({ state: 'visible' });
    await page.keyboard.press('Enter');
    await until(async () => (await snapshot()).official === 2, 'Menu failed to reopen closed official editor');
    await page.bringToFront();
    await page.mouse.move(0, 0);
    await status.hover();
    const reportLink = page.getByRole('link', { name: /Usage report/ });
    await reportLink.waitFor({ state: 'visible' });
    await page.screenshot({ path: join(base, 'quota-tooltip.png') });
    await reportLink.click();
    await page.getByRole('tab', { name: /Codex Usage/ }).waitFor({ state: 'visible' });
    // Project History is a separate, project-filtered control. The built-in clock stays global.
    await page.keyboard.press('Control+Alt+F7');
    await pause(500);
    const historyButton = page.locator('.editor-actions').getByRole('button', { name: 'Project History', exact: true });
    await historyButton.waitFor({ state: 'visible' });
    await historyButton.click();
    const historyMenu = page.locator('.quick-input-widget:visible');
    await historyMenu.getByText('History matching conversation', { exact: true }).waitFor({ state: 'visible' });
    await historyMenu.getByText('History nested conversation', { exact: true }).waitFor({ state: 'visible' });
    await historyMenu.getByText('History eventless conversation', { exact: true }).waitFor({ state: 'visible' });
    for (const hidden of [
      'History archived conversation',
      'History sibling conversation',
      'History foreign conversation',
      'History invalid id',
      'History relative path',
    ]) {
      assert.equal(await historyMenu.getByText(hidden, { exact: true }).count(), 0, `Unexpected history row: ${hidden}`);
    }
    const historyInput = historyMenu.locator('input').first();
    await historyInput.fill('nested');
    assert.equal(await historyInput.inputValue(), 'nested');
    await historyMenu.getByText('History nested conversation', { exact: true }).waitFor({ state: 'visible' });
    assert.equal(await historyMenu.getByText('History matching conversation', { exact: true }).count(), 0, 'Search did not filter history');
    await historyInput.fill('matching');
    assert.equal(await historyInput.inputValue(), 'matching');
    await historyMenu.getByText('History matching conversation', { exact: true }).click();
    await until(async () => (await snapshot()).uris.includes('openai-codex://route/local/11111111-1111-4111-8111-111111111111'),
      'Selected project history did not open the official conversation URI');
    assert.equal((await snapshot()).custom, 0);
    console.log('Quota UI: PASS (status menu, refresh, closed official tab restored, tooltip, report).');
    console.log('Project History UI: PASS (separate toolbar entry, local project filter, fixture selection opens official URI).');
    console.log(`Launcher UI: PASS (top-right editor action, no status bar launcher, official editor, no custom chat). ${base}`);
    await page.keyboard.press('Control+Alt+F5');
  } catch (error) {
    const page = browser?.contexts().flatMap(c => c.pages()).find(p => p.url().includes('workbench'));
    await page?.screenshot({ path: join(base, 'failure.png') }).catch(() => {});
    if (authProbeHome && page) for (const frame of page.frames()) {
      const input = frame.locator('[contenteditable="true"]').first();
      if (await input.isVisible().catch(() => false) && /^Companion isolated draft [12]$/.test((await input.innerText()).trim())) await input.fill('').catch(() => {});
    }
    console.error(`UI artifacts: ${base}`);
    throw error;
  } finally {
    await browser?.close();
    if (child.exitCode === null) child.kill();
    await exited;
    log.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
