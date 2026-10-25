import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { WindowsNotifications } from '../../src/windowsNotifications';

const options = { id: 17, title: 'Quote " & $() <tag>', message: 'Synthetic notification', sound: false };
const client = (code: number) => new WindowsNotifications(process.execPath, [join(__dirname, '../fixtures/toastExit.js'), String(code)]);

test('native success without a pipe payload still reports an actual click', async () => {
  const notifications = client(0);
  assert.equal(await notifications.show(options), 'activated');
  notifications.dispose();
});

test('hide, dismiss and expiry never become activation', async () => {
  for (const [code, expected] of [[1, 'hidden'], [2, 'dismissed'], [3, 'timedOut']] as const) {
    const notifications = client(code);
    assert.equal(await notifications.show(options), expected);
    notifications.dispose();
  }
});

test('unexpected native failures are exposed instead of treated as a click', async () => {
  const notifications = client(7);
  await assert.rejects(notifications.show(options), /could not complete/);
  notifications.dispose();
});

test('extension shutdown cancels the helper and never activates a window', async () => {
  const notifications = client(99);
  const pending = notifications.show(options);
  notifications.dispose();
  assert.equal(await pending, 'cancelled');
  assert.equal(await notifications.show(options), 'cancelled');
});
