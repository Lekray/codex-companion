import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { chromium, type Frame, type Page } from 'playwright-core';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
async function main(): Promise<void> {
  delete process.env.ELECTRON_RUN_AS_NODE;
  const root = resolve(__dirname, '../..');
  const base = join(root, '.artifacts', `workbench-${Date.now()}`);
  const workspace = join(base, 'fixture-project');
  const userData = join(base, 'profile');
  const driver = join(base, 'driver');
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(join(userData, 'User'), { recursive: true }), mkdir(driver, { recursive: true })]);
  await writeFile(join(workspace, 'app-server'), `require(${JSON.stringify(join(root, 'dist/test/fixtures/workbenchServer.js'))});`);
  await writeFile(join(userData, 'User/settings.json'), JSON.stringify({ 'codexCompanion.cliPath': process.execPath, 'codexCompanion.windowsNotifications': false, 'window.dialogStyle': 'custom', 'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none' }));
  await writeFile(join(driver, 'package.json'), JSON.stringify({ name: 'workbench-driver', publisher: 'local-test', version: '0.0.1', engines: { vscode: '^1.139.0' }, main: './index.js', activationEvents: ['onStartupFinished'], extensionDependencies: ['local-companion.codex-companion'] }));
  await writeFile(join(driver, 'index.js'), `exports.activate = async () => { const vscode = require('vscode'); await vscode.extensions.getExtension('local-companion.codex-companion').activate(); await vscode.commands.executeCommand('codexCompanion.open'); };`);
  const port = await freePort();
  const log = createWriteStream(join(base, 'vscode.log'));
  const child = spawn(process.env.CODEX_COMPANION_VSCODE ?? join(process.env.LOCALAPPDATA ?? '', 'Programs/Microsoft VS Code/Code.exe'), [workspace,
    '--user-data-dir', userData, '--extensions-dir', join(base, 'extensions'), `--extensionDevelopmentPath=${root}`, `--extensionDevelopmentPath=${driver}`,
    `--remote-debugging-port=${port}`, '--locale=en', '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
  ], { windowsHide: true, env: { ...process.env, CODEX_HOME: join(base, 'unused-codex-home') }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log); child.stderr.pipe(log);
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
  let browser;
  try {
    for (let i = 0; i < 100; i++) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; } catch { await new Promise(r => setTimeout(r, 100)); }
    }
    assert.ok(browser, 'VS Code exposes its test debug endpoint');
    let page: Page | undefined;
    for (let i = 0; i < 100; i++) {
      page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('workbench'));
      if (page) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(page, 'VS Code workbench opened');
    page.setDefaultTimeout(10_000);
    const chat = async (): Promise<Frame> => {
      for (let i = 0; i < 100; i++) {
        for (const frame of page!.frames()) {
          try { if (await frame.locator('#composer').count() && await frame.locator('#composer').isVisible()) return frame; } catch { /* Detached frame. */ }
        }
        await page!.waitForTimeout(100);
      }
      throw new Error('Visible Companion frame not found');
    };
    const command = async (title: string): Promise<void> => {
      await page!.keyboard.press('Control+Shift+P');
      const input = page!.locator('.quick-input-widget input').first();
      await input.fill('>' + title);
      await page!.keyboard.press('Enter');
      await page!.waitForTimeout(150);
    };
    const send = async (text: string): Promise<void> => {
      const frame = await chat();
      await frame.locator('#input').fill(text);
      await frame.locator('#send').click();
      await frame.waitForFunction(() => (document.getElementById('input') as HTMLTextAreaElement)?.value === '');
    };
    const requests = async (): Promise<{ method?: string; result?: unknown }[]> => (await readFile(join(workspace, 'rpc.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    await chat();
    await send('wait');
    await page.getByRole('tab', { name: /\[~\] Codex 1/ }).waitFor();
    await command('View: Close Editor');
    await page.getByRole('button', { name: 'Cancel', exact: true }).last().click();
    await chat();
    assert.equal((await requests()).filter(r => r.method === 'turn/start').length, 1, 'cancel preserves the same running turn');
    await (await chat()).locator('#stop').click();
    await (await chat()).locator('#status').filter({ hasText: 'Ready' }).waitFor();
    await send('approve');
    const approval = await chat();
    await approval.getByRole('button', { name: 'Decline', exact: true }).waitFor();
    assert.equal((await requests()).filter(r => !r.method && r.result).length, 0, 'approval is not automatic');
    await approval.getByRole('button', { name: 'Decline', exact: true }).click();
    await approval.locator('#status').filter({ hasText: 'Completed' }).waitFor();
    await send('question');
    const question = await chat();
    await question.locator('.prompt input').fill('Proceed');
    await question.getByRole('button', { name: 'Answer', exact: true }).click();
    await question.locator('#status').filter({ hasText: 'Completed' }).waitFor();
    await send('wait');
    await command('View: Close Editor');
    await page.getByRole('button', { name: 'Continue in background', exact: true }).click();
    await writeFile(join(workspace, 'control.json'), JSON.stringify({ action: 'complete' }));
    await page.waitForTimeout(200);
    await command('Codex: History');
    await page.keyboard.press('Enter');
    await (await chat()).locator('#status').filter({ hasText: 'Completed' }).waitFor();
    await send('wait');
    await command('View: Close Editor');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await page.waitForTimeout(200);
    assert.equal((await requests()).filter(r => r.method === 'turn/interrupt').length, 2, 'both Stop paths interrupt their turn');
    await page.screenshot({ path: join(base, 'workbench.png') });
    console.log(`Workbench UI: PASS (close cancel/background/stop, explicit approval, user input). Artifacts: ${base}`);
    await command('File: Exit');
  } catch (error) {
    console.error(`Workbench artifacts: ${base}`);
    if (browser) for (const page of browser.contexts().flatMap(c => c.pages())) await page.screenshot({ path: join(base, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    await browser?.close();
    if (child.exitCode === null) child.kill();
    await exited;
    log.end();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
