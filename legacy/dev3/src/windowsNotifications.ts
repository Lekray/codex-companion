import { execFile, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';

export type ToastOutcome = 'activated' | 'hidden' | 'dismissed' | 'timedOut' | 'cancelled';
export interface ToastOptions { id: number; title: string; message: string; sound: boolean }

/** SnoreToast 0.7 exit status is authoritative even when its named-pipe payload is absent. */
export class WindowsNotifications {
  private readonly children = new Set<ChildProcess>();
  private disposed = false;
  constructor(
    private readonly executable = join(dirname(require.resolve('node-notifier/package.json')), 'vendor/snoreToast', process.arch === 'x64' || process.arch === 'arm64' ? 'snoretoast-x64.exe' : 'snoretoast-x86.exe'),
    private readonly prefixArgs: string[] = [],
  ) {}

  show(options: ToastOptions): Promise<ToastOutcome> {
    if (this.disposed) return Promise.resolve('cancelled');
    const args = [...this.prefixArgs, '-appID', 'Microsoft.VisualStudioCode', '-id', String(options.id), '-t', options.title, '-m', options.message];
    if (!options.sound) args.push('-silent');
    return new Promise((resolve, reject) => {
      const child = execFile(this.executable, args, { windowsHide: true, shell: false, timeout: 60_000, maxBuffer: 64 * 1024 }, error => {
        this.children.delete(child);
        if (this.disposed) { resolve('cancelled'); return; }
        // This invocation only displays a notification: no install/help/close flags,
        // which also use exit code 0. Source: KDE/snoretoast v0.7.0 main.cpp.
        const code = error ? error.code : 0;
        const outcomes: Record<number, ToastOutcome> = { 0: 'activated', 1: 'hidden', 2: 'dismissed', 3: 'timedOut' };
        const outcome = typeof code === 'number' ? outcomes[code] : undefined;
        if (outcome && !error?.killed) resolve(outcome);
        else reject(new Error('Windows notification could not complete.'));
      });
      this.children.add(child);
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const child of this.children) child.kill();
    this.children.clear();
  }
}
