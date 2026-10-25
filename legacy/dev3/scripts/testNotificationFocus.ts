import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium, type Browser, type Frame, type Page } from 'playwright-core';

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => Promise<boolean>, label: string, attempts = 100): Promise<void> {
  for (let i = 0; i < attempts; i++) { if (await check().catch(() => false)) return; await delay(100); }
  throw new Error(label);
}
async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const value = (server.address() as { port: number }).port;
  await new Promise<void>(r => server.close(() => r())); return value;
}
async function command(page: Page, title: string): Promise<void> {
  await page.keyboard.press('Control+Shift+P');
  await page.locator('.quick-input-widget input').first().fill('>' + title);
  await page.keyboard.press('Enter'); await delay(150);
}
async function main(): Promise<void> {
  if (process.argv.includes('--manual')) process.env.COMPANION_MANUAL_TOAST = '1';
  delete process.env.ELECTRON_RUN_AS_NODE;
  const root = resolve(__dirname, '../..');
  const base = join(root, '.artifacts', `notify-focus-${Date.now()}`);
  const title = `Companion test ${Date.now()}`;
  const launches: { child: ChildProcess; browser: Browser; page: Page }[] = [];
  const logs: ReturnType<typeof createWriteStream>[] = [];
  const executable = process.env.CODEX_COMPANION_VSCODE ?? join(process.env.LOCALAPPDATA ?? '', 'Programs/Microsoft VS Code/Code.exe');
  async function launch(name: string, companion: boolean): Promise<{ page: Page; folder: string; state: string; pid: number }> {
    const folder = join(base, name);
    const profile = join(base, name + '-profile');
    const state = join(base, name + '-state.json');
    const driver = join(base, name + '-driver');
    await Promise.all([mkdir(folder, { recursive: true }), mkdir(join(profile, 'User'), { recursive: true }), mkdir(driver, { recursive: true })]);
    await writeFile(join(folder, 'app-server'), `require(${JSON.stringify(join(root, 'dist/test/fixtures/workbenchServer.js'))});`);
    await writeFile(join(profile, 'User/settings.json'), JSON.stringify({ 'codexCompanion.cliPath': process.execPath, 'codexCompanion.windowsNotifications': true, 'window.dialogStyle': 'custom', 'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none' }));
    await writeFile(join(driver, 'package.json'), JSON.stringify({ name: 'notification-driver', publisher: 'local-test', version: '0.0.1', engines: { vscode: '^1.139.0' }, main: './index.js', activationEvents: ['onStartupFinished'], ...(companion ? { extensionDependencies: ['local-companion.codex-companion'] } : {}) }));
    await writeFile(join(driver, 'index.js'), `exports.activate = async () => {
      const vscode = require('vscode'), fs = require('node:fs');
      const save = () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify({ focused: vscode.window.state.focused, tab: vscode.window.tabGroups.activeTabGroup.activeTab?.label }));
      vscode.window.onDidChangeWindowState(save); vscode.window.tabGroups.onDidChangeTabs(save); save();
      ${companion ? `await vscode.extensions.getExtension('local-companion.codex-companion').activate(); await vscode.commands.executeCommand('codexCompanion.open'); await vscode.commands.executeCommand('codexCompanion.rename', ${JSON.stringify(title)});` : ''}
      await vscode.commands.executeCommand('workbench.action.focusWindow'); save();
    };`);
    const debugPort = await port();
    const log = createWriteStream(join(base, name + '.log')); logs.push(log);
    const child = spawn(executable, [folder, '--user-data-dir', profile, '--extensions-dir', join(base, name + '-extensions'),
      ...(companion ? [`--extensionDevelopmentPath=${root}`] : []), `--extensionDevelopmentPath=${driver}`, `--remote-debugging-port=${debugPort}`,
      '--locale=en', '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
    { windowsHide: false, env: { ...process.env, CODEX_HOME: join(base, 'unused-home') }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log); child.stderr.pipe(log);
    let browser: Browser | undefined;
    await until(async () => { browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`); return true; }, 'Debug endpoint missing');
    let page: Page | undefined;
    await until(async () => { page = browser!.contexts().flatMap(c => c.pages()).find(p => p.url().includes('workbench')); return !!page; }, 'Workbench missing');
    page!.setDefaultTimeout(10_000);
    // Playwright normally emulates focus for every attached page, masking real
    // cross-window blur events. This test needs native OS focus instead.
    const cdp = await page!.context().newCDPSession(page!);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    launches.push({ child, browser: browser!, page: page! });
    await until(async () => { await readFile(state, 'utf8'); return true; }, 'Test driver did not activate');
    await page!.locator('.monaco-workbench').waitFor({ state: 'visible' });
    return { page: page!, folder, state, pid: child.pid! };
  }
  try {
    const source = await launch('source-project', true);
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(root, 'test/fixtures/focusWindow.ps1'), '-ProcessId', String(source.pid)], { windowsHide: true, timeout: 5000 });
    let frame: Frame | undefined;
    await until(async () => { for (const candidate of source.page.frames()) if (await candidate.locator('#composer').count()) { frame = candidate; return true; } return false; }, 'Chat missing');
    await frame!.locator('#input').fill('wait'); await frame!.locator('#send').click();
    await source.page.getByRole('tab', { name: new RegExp('\\[~\\] ' + title) }).waitFor();
    await command(source.page, 'View: Close Editor');
    await source.page.getByRole('button', { name: 'Continue in background', exact: true }).click();
    const other = await launch('other-project', false);
    await other.page.bringToFront();
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(root, 'test/fixtures/focusWindow.ps1'), '-ProcessId', String(other.pid)], { windowsHide: true, timeout: 5000 });
    await until(async () => JSON.parse(await readFile(source.state, 'utf8')).focused === false && JSON.parse(await readFile(other.state, 'utf8')).focused === true, 'Other window did not gain focus').catch(async error => {
      await writeFile(join(base, 'focus-debug.json'), JSON.stringify({ source: JSON.parse(await readFile(source.state, 'utf8')), other: JSON.parse(await readFile(other.state, 'utf8')), sourceDomFocus: await source.page.evaluate(() => document.hasFocus()), otherDomFocus: await other.page.evaluate(() => document.hasFocus()) }, null, 2));
      throw error;
    });
    if (process.env.COMPANION_MANUAL_GATE === '1') {
      const trigger = join(base, 'show-toast');
      await writeFile(join(root, '.artifacts/current-toast-test.json'), JSON.stringify({ trigger }));
      console.log('TWO_WINDOWS_READY: waiting for the manual test trigger.');
      await until(async () => { await readFile(trigger); return true; }, 'Manual test was not triggered', 1800);
      await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(root, 'test/fixtures/focusWindow.ps1'), '-ProcessId', String(other.pid)], { windowsHide: true, timeout: 5000 });
      await until(async () => JSON.parse(await readFile(source.state, 'utf8')).focused === false && JSON.parse(await readFile(other.state, 'utf8')).focused === true, 'Other window did not regain focus');
    }
    await writeFile(join(source.folder, 'control.json'), JSON.stringify({ action: 'complete' }));
    if (process.env.COMPANION_MANUAL_TOAST === '1') console.log('MANUAL_TOAST_READY: click the test toast now.');
    else {
      const clicked = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-File', join(root, 'test/fixtures/clickToast.ps1'), '-Title', `source-project · ${title}`], { windowsHide: true, timeout: 20_000 });
      assert.match(clicked.stdout, /CLICKED_OWN_TEST_TOAST/);
    }
    await until(async () => { const state = JSON.parse(await readFile(source.state, 'utf8')); return state.focused === true && state.tab === '[V] ' + title; }, 'Toast did not focus its original window/tab', process.env.COMPANION_MANUAL_TOAST === '1' ? 600 : 100);
    assert.equal(JSON.parse(await readFile(other.state, 'utf8')).focused, false);
    console.log(`Native notification focus: PASS (real toast click, two VS Code windows, restored source tab). Artifacts: ${base}`);
  } finally {
    console.log(`Notification focus artifacts: ${base}`);
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(root, 'test/fixtures/removeTestToast.ps1'), '-Title', `source-project · ${title}`], { windowsHide: true, timeout: 5000 }).catch(() => {});
    for (const launch of launches.reverse()) {
      await command(launch.page, 'File: Exit').catch(() => {});
      await launch.browser.close().catch(() => {});
      if (launch.child.exitCode === null) launch.child.kill();
    }
    for (const log of logs) log.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
