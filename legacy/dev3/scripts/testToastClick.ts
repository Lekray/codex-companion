import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { WindowsNotifications } from '../src/windowsNotifications';

/** Requires a visible interactive desktop. Manual mode waits for a human click. */
async function main(): Promise<void> {
  if (process.argv.includes('--manual')) process.env.COMPANION_MANUAL_TOAST = '1';
  const root = resolve(__dirname, '../..');
  const title = `source-project · Companion test ${Date.now()}`;
  const start = Date.now();
  const notifications = new WindowsNotifications();
  const clicked = notifications.show({ title, message: 'Click integration test. No agent task is running.', sound: false, id: Date.now() % 2147483647 });
  void clicked.catch(() => {});
  try {
    if (process.env.COMPANION_MANUAL_TOAST === '1') console.log('MANUAL_TOAST_READY: click the test toast now.');
    else {
      const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-File', join(root, 'test/fixtures/clickToast.ps1'), '-Title', title], { windowsHide: true, timeout: 20_000 });
      console.log(result.stdout.trim());
    }
    const outcome = await clicked;
    console.log(JSON.stringify({ elapsedMs: Date.now() - start, outcome }));
    assert.equal(outcome, 'activated', 'native click reaches the Companion adapter');
    console.log('Native toast click: PASS');
  } finally {
    notifications.dispose();
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', join(root, 'test/fixtures/removeTestToast.ps1'), '-Title', title], { windowsHide: true, timeout: 5000 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
