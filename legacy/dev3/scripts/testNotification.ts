import { WindowsNotifications } from '../src/windowsNotifications';
import { execFile } from 'node:child_process';

async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('This check requires Windows');
  const notifications = new WindowsNotifications();
  const id = Date.now() % 2147483647;
  const shown = notifications.show({ id, title: 'Проверка Codex Companion', message: 'Проверка доставки уведомлений. Это уведомление закроется автоматически.', sound: false });
  void shown.catch(() => {});
  try {
    await new Promise(resolve => setTimeout(resolve, 2000));
    // Inspect and remove only the notification created by this test.
    const script = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null; $items = @([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('Microsoft.VisualStudioCode') | Where-Object { $_.Tag -eq '${id}' }); $items.Count; foreach ($toast in $items) { [Windows.UI.Notifications.ToastNotificationManager]::History.Remove($toast.Tag, $toast.Group, 'Microsoft.VisualStudioCode') }`;
    const count = await new Promise<string>((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
    if (count !== '1') throw new Error('Test notification was not present in Windows history');
    console.log('Windows notification delivery: PASS; own test entry removed.');
  } finally {
    notifications.dispose();
    await shown;
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Notification check failed'); process.exitCode = 1; });
