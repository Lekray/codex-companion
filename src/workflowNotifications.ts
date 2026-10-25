import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type WorkflowNotice = {
  eventId: string;
  project: string;
  title: string;
  status: 'done' | 'error' | 'waiting';
  reveal: () => Promise<void>;
};

export type NotificationSound = 'done' | 'waiting';

export interface NotificationSettings {
  enabled: boolean;
  windows: boolean;
  sound: boolean;
}

export interface NotificationDependencies {
  focused: () => boolean;
  settings: () => NotificationSettings;
  claimEvent: (eventId: string) => Promise<boolean>;
  inApp: (message: string, openLabel: string) => Promise<boolean>;
  native: (title: string, message: string) => Promise<boolean>;
  sound: (sound: NotificationSound) => Promise<void>;
  onError?: (error: unknown) => void;
}

export interface SoundExecOptions {
  windowsHide: boolean;
  shell: boolean;
  timeout: number;
}

export type SoundExecFile = (
  file: string,
  args: readonly string[],
  options: SoundExecOptions,
  callback: (error: (Error & { code?: number | string }) | null) => void,
) => unknown;

const SOUND_TIMEOUT_MS = 10_000;
const CLAIM_SUFFIX = '.claim';
const MAX_REMEMBERED_EVENTS = 512;
const defaultSoundExec = execFile as unknown as SoundExecFile;

async function playSound(
  extensionPath: string,
  sound: NotificationSound,
  exec: SoundExecFile = defaultSoundExec,
): Promise<void> {
  const label = sound === 'waiting' ? 'Waiting' : 'Completion';
  const file = sound === 'waiting' ? 'waiting.wav' : 'completion.wav';
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-File',
    join(extensionPath, 'resources', 'playCompletionSound.ps1'),
    '-Path',
    join(extensionPath, 'resources', file),
  ];

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (error: unknown): void => {
      if (settled) return;
      settled = true;
      if (error) {
        const code = (error as { code?: unknown }).code;
        const detail = typeof code === 'number' ? ` (${code})` : '';
        reject(new Error(`${label} sound playback failed${detail}.`));
      } else {
        resolve();
      }
    };
    try {
      exec(
        'powershell.exe',
        args,
        { windowsHide: true, shell: false, timeout: SOUND_TIMEOUT_MS },
        error => settle(error),
      );
    } catch (error) {
      settle(error ?? new Error(`${label} sound playback failed.`));
    }
  });
}

export async function playCompletionSound(
  extensionPath: string,
  exec: SoundExecFile = defaultSoundExec,
): Promise<void> {
  await playSound(extensionPath, 'done', exec);
}

export async function playWaitingSound(
  extensionPath: string,
  exec: SoundExecFile = defaultSoundExec,
): Promise<void> {
  await playSound(extensionPath, 'waiting', exec);
}

export async function claimNotificationEvent(
  storageDir: string,
  eventId: string,
): Promise<boolean> {
  const digest = createHash('sha256').update(eventId, 'utf8').digest('hex');
  await mkdir(storageDir, { recursive: true });
  try {
    await writeFile(
      join(storageDir, `${digest}${CLAIM_SUFFIX}`),
      `${new Date().toISOString()}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

function statusText(status: WorkflowNotice['status'], ru: boolean): string {
  if (ru) {
    if (status === 'done') return 'готово';
    if (status === 'error') return 'ошибка';
    return 'нужен ваш ответ';
  }
  if (status === 'done') return 'done';
  if (status === 'error') return 'error';
  return 'needs your answer';
}

export class WorkflowNotifications {
  private readonly rememberedEvents = new Set<string>();
  private disposed = false;

  constructor(
    private readonly deps: NotificationDependencies,
    private readonly ru: boolean,
  ) {}

  async notify(notice: WorkflowNotice): Promise<void> {
    if (this.disposed) return;

    let settings: NotificationSettings;
    try {
      settings = this.deps.settings();
    } catch (error) {
      this.report(error);
      return;
    }
    if (!settings.enabled) return;
    if (this.rememberedEvents.has(notice.eventId)) return;
    this.remember(notice.eventId);

    try {
      const claimed = await this.deps.claimEvent(notice.eventId);
      if (!claimed || this.disposed) return;
    } catch (error) {
      this.rememberedEvents.delete(notice.eventId);
      this.report(error);
      return;
    }

    // Sound starts as soon as the event is claimed and never waits for UI dismissal.
    if (notice.status !== 'error' && settings.sound) this.startSound(notice.status);

    const message = `${notice.project}: ${notice.title} — ${statusText(notice.status, this.ru)}`;
    const openLabel = this.ru ? 'Открыть' : 'Open';
    let handled: boolean;
    if (this.isFocused()) {
      handled = await this.showInApp(message, openLabel);
    } else if (settings.windows) {
      handled = await this.showNative(notice, message, openLabel);
    } else {
      handled = await this.showInApp(message, openLabel);
    }

    if (!handled || this.disposed) return;
    try {
      await notice.reveal();
    } catch (error) {
      this.report(error);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.rememberedEvents.clear();
  }

  private isFocused(): boolean {
    try {
      return this.deps.focused();
    } catch (error) {
      this.report(error);
      return true;
    }
  }

  private async showInApp(message: string, openLabel: string): Promise<boolean> {
    try {
      return await this.deps.inApp(message, openLabel);
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  private async showNative(
    notice: WorkflowNotice,
    message: string,
    openLabel: string,
  ): Promise<boolean> {
    const title = `Codex: ${statusText(notice.status, this.ru)}`;
    try {
      return await this.deps.native(title, message);
    } catch (error) {
      this.report(error);
      return this.showInApp(message, openLabel);
    }
  }

  private startSound(status: NotificationSound): void {
    try {
      void Promise.resolve(this.deps.sound(status)).catch(error => this.report(error));
    } catch (error) {
      this.report(error);
    }
  }

  private remember(eventId: string): void {
    this.rememberedEvents.add(eventId);
    if (this.rememberedEvents.size <= MAX_REMEMBERED_EVENTS) return;
    const oldest = this.rememberedEvents.values().next().value;
    if (oldest !== undefined) this.rememberedEvents.delete(oldest);
  }

  private report(error: unknown): void {
    try {
      this.deps.onError?.(error);
    } catch {
      // Error reporting must never break notification handling.
    }
  }
}
