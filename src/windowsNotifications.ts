import { execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';

export type ToastOutcome = 'activated' | 'hidden' | 'dismissed' | 'timedOut' | 'cancelled';

export interface ToastOptions {
  id: number;
  title: string;
  message: string;
  sound: boolean;
}

export interface ToastProcessOptions {
  windowsHide: boolean;
  shell: boolean;
  timeout: number;
  maxBuffer: number;
}

export interface ToastError extends Error {
  code?: number | string;
  killed?: boolean;
}

export type ToastRunner = (
  file: string,
  args: readonly string[],
  options: ToastProcessOptions,
  callback: (error: ToastError | null, stdout: string, stderr: string) => void,
) => ChildProcess;

const TOAST_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 64 * 1024;
const defaultRunner = execFile as unknown as ToastRunner;

function defaultExecutable(): string {
  const vendor = join(dirname(require.resolve('node-notifier/package.json')), 'vendor', 'snoreToast');
  return join(
    vendor,
    process.arch === 'x64' || process.arch === 'arm64'
      ? 'snoretoast-x64.exe'
      : 'snoretoast-x86.exe',
  );
}

/** SnoreToast 0.7 exit status is authoritative even when its named-pipe payload is absent. */
export class WindowsNotifications {
  private readonly children = new Set<ChildProcess>();
  private disposed = false;

  constructor(
    private readonly executable = defaultExecutable(),
    private readonly prefixArgs: string[] = [],
    private readonly run: ToastRunner = defaultRunner,
  ) {}

  show(options: ToastOptions): Promise<ToastOutcome> {
    if (this.disposed) return Promise.resolve('cancelled');
    const args = [
      ...this.prefixArgs,
      '-appID',
      'Microsoft.VisualStudioCode',
      '-id',
      String(options.id),
      '-t',
      options.title,
      '-m',
      options.message,
    ];
    if (!options.sound) args.push('-silent');

    return new Promise<ToastOutcome>((resolve, reject) => {
      let settled = false;
      let child: ChildProcess | undefined;
      const finish = (outcome: ToastOutcome): void => {
        if (settled) return;
        settled = true;
        if (child) this.children.delete(child);
        resolve(outcome);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        if (child) this.children.delete(child);
        reject(error);
      };
      const callback = (error: ToastError | null): void => {
        if (this.disposed) {
          finish('cancelled');
          return;
        }
        // This invocation only displays a notification: no install/help/close flags,
        // which also use exit code 0. Source: KDE/snoretoast v0.7.0 main.cpp.
        const code = error ? error.code : 0;
        const outcomes: Record<number, ToastOutcome> = {
          0: 'activated',
          1: 'hidden',
          2: 'dismissed',
          3: 'timedOut',
        };
        const outcome = typeof code === 'number' ? outcomes[code] : undefined;
        if (outcome && !error?.killed) finish(outcome);
        else fail(new Error('Windows notification could not complete.'));
      };
      try {
        child = this.run(
          this.executable,
          args,
          { windowsHide: true, shell: false, timeout: TOAST_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
          callback,
        );
      } catch (error) {
        fail(error instanceof Error ? error : new Error('Windows notification could not start.'));
        return;
      }
      if (!settled) this.children.add(child);
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const child of this.children) child.kill();
    this.children.clear();
  }
}
