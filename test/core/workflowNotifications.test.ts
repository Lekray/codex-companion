import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  claimNotificationEvent,
  playCompletionSound,
  playWaitingSound,
  WorkflowNotifications,
  type NotificationDependencies,
  type NotificationSound,
  type NotificationSettings,
  type SoundExecFile,
  type WorkflowNotice,
} from '../../src/workflowNotifications';
import {
  WindowsNotifications,
  type ToastError,
  type ToastProcessOptions,
  type ToastRunner,
} from '../../src/windowsNotifications';

const artifacts = join(process.cwd(), '.artifacts', 'workflow-v15', 'notifications');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface HarnessOptions {
  ru?: boolean;
  focused?: boolean;
  settings?: Partial<NotificationSettings>;
  claimEvent?: (eventId: string) => Promise<boolean>;
  inAppResult?: boolean | (() => Promise<boolean>);
  nativeResult?: boolean | (() => Promise<boolean>);
  sound?: (sound: NotificationSound) => Promise<void>;
}

function harness(options: HarnessOptions = {}) {
  const calls = {
    claims: [] as string[],
    inApp: [] as Array<{ message: string; openLabel: string }>,
    native: [] as Array<{ title: string; message: string }>,
    sounds: [] as NotificationSound[],
    reveals: 0,
    errors: [] as unknown[],
  };
  const settings: NotificationSettings = {
    enabled: true,
    windows: true,
    sound: true,
    ...options.settings,
  };
  const deps: NotificationDependencies = {
    focused: () => options.focused ?? false,
    settings: () => settings,
    claimEvent: async eventId => {
      calls.claims.push(eventId);
      return options.claimEvent ? options.claimEvent(eventId) : true;
    },
    inApp: async (message, openLabel) => {
      calls.inApp.push({ message, openLabel });
      return typeof options.inAppResult === 'function'
        ? options.inAppResult()
        : options.inAppResult ?? true;
    },
    native: async (title, message) => {
      calls.native.push({ title, message });
      return typeof options.nativeResult === 'function'
        ? options.nativeResult()
        : options.nativeResult ?? true;
    },
    sound: async sound => {
      calls.sounds.push(sound);
      if (options.sound) await options.sound(sound);
    },
    onError: error => {
      calls.errors.push(error);
    },
  };
  const service = new WorkflowNotifications(deps, options.ru ?? false);
  const notice = (
    eventId = 'event-1',
    status: WorkflowNotice['status'] = 'done',
  ): WorkflowNotice => ({
    eventId,
    project: 'Alpha',
    title: 'Fix build',
    status,
    reveal: async () => {
      calls.reveals += 1;
    },
  });
  return { service, calls, notice };
}

test('concurrent duplicates claim once and produce one sound and one notice', async () => {
  const claim = deferred<boolean>();
  const h = harness({ focused: true, claimEvent: () => claim.promise });
  const notice = h.notice('same-turn');
  const first = h.service.notify(notice);
  const second = h.service.notify(notice);
  assert.deepEqual(h.calls.claims, ['same-turn']);
  claim.resolve(true);
  await Promise.all([first, second]);
  assert.deepEqual(h.calls.sounds, ['done']);
  assert.equal(h.calls.inApp.length, 1);
  assert.equal(h.calls.reveals, 1);
});

test('sound starts without waiting for the notification to be dismissed', async () => {
  const inApp = deferred<boolean>();
  const h = harness({ focused: true, inAppResult: () => inApp.promise });
  const pending = h.service.notify(h.notice('sound-race'));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls.sounds, ['done']);
  assert.equal(h.calls.inApp.length, 1);
  inApp.resolve(false);
  await pending;
  assert.equal(h.calls.reveals, 0);
});

test('distinct turns are never suppressed by cooldown or snapshot logic', async () => {
  const h = harness({ focused: true });
  await h.service.notify(h.notice('turn-1'));
  await h.service.notify(h.notice('turn-2'));
  assert.equal(h.calls.claims.length, 2);
  assert.equal(h.calls.inApp.length, 2);
  assert.deepEqual(h.calls.sounds, ['done', 'done']);
  assert.equal(h.calls.reveals, 2);
});

test('focused notices use in-app UI; background respects the windows setting', async () => {
  const active = harness({ focused: true, ru: true });
  await active.service.notify(active.notice('active'));
  assert.equal(active.calls.inApp.length, 1);
  assert.equal(active.calls.native.length, 0);
  assert.match(active.calls.inApp[0]!.message, /Alpha: Fix build/);
  assert.match(active.calls.inApp[0]!.message, /готово/);
  assert.equal(active.calls.inApp[0]!.openLabel, 'Открыть');

  const native = harness({ focused: false });
  await native.service.notify(native.notice('background'));
  assert.equal(native.calls.native.length, 1);
  assert.equal(native.calls.inApp.length, 0);
  assert.match(native.calls.native[0]!.message, /Alpha: Fix build — done/);
  assert.equal(native.calls.reveals, 1);

  const withoutWindows = harness({ focused: false, settings: { windows: false } });
  await withoutWindows.service.notify(withoutWindows.notice('background-fallback'));
  assert.equal(withoutWindows.calls.native.length, 0);
  assert.equal(withoutWindows.calls.inApp.length, 1);
});

test('done and waiting use independent sounds; errors are mute and the mute switch silences both', async () => {
  const done = harness({ focused: true });
  await done.service.notify(done.notice('status-done', 'done'));
  assert.deepEqual(done.calls.sounds, ['done']);

  const error = harness({ focused: true });
  await error.service.notify(error.notice('status-error', 'error'));
  assert.deepEqual(error.calls.sounds, []);
  assert.equal(error.calls.inApp.length, 1);

  const waiting = harness({ focused: true });
  await waiting.service.notify(waiting.notice('status-waiting', 'waiting'));
  assert.deepEqual(waiting.calls.sounds, ['waiting']);
  assert.equal(waiting.calls.inApp.length, 1);
  assert.match(waiting.calls.inApp[0]!.message, /needs your answer/);
  assert.doesNotMatch(waiting.calls.inApp[0]!.message, /waiting/);

  const russian = harness({ focused: true, ru: true });
  await russian.service.notify(russian.notice('status-waiting-ru', 'waiting'));
  assert.match(russian.calls.inApp[0]!.message, /нужен ваш ответ/);

  for (const status of ['done', 'waiting'] as const) {
    const muted = harness({ focused: true, settings: { sound: false } });
    await muted.service.notify(muted.notice(`muted-${status}`, status));
    assert.deepEqual(muted.calls.sounds, []);
    assert.equal(muted.calls.inApp.length, 1);
  }
});

test('disabled notifications do nothing', async () => {
  const h = harness({ focused: true, settings: { enabled: false } });
  await h.service.notify(h.notice('disabled'));
  assert.equal(h.calls.claims.length, 0);
  assert.equal(h.calls.inApp.length, 0);
  assert.equal(h.calls.native.length, 0);
  assert.deepEqual(h.calls.sounds, []);
});

test('claim failure is reported and never notifies', async () => {
  const failure = new Error('storage unavailable');
  const h = harness({
    focused: true,
    claimEvent: async () => {
      throw failure;
    },
  });
  await h.service.notify(h.notice('claim-failure'));
  assert.deepEqual(h.calls.errors, [failure]);
  assert.equal(h.calls.inApp.length, 0);
  assert.deepEqual(h.calls.sounds, []);
});

test('sound failure is reported without breaking the notice', async () => {
  const failure = new Error('audio failed');
  const h = harness({
    focused: true,
    sound: async () => {
      throw failure;
    },
  });
  await h.service.notify(h.notice('sound-failure'));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(h.calls.inApp.length, 1);
  assert.equal(h.calls.reveals, 1);
  assert.deepEqual(h.calls.errors, [failure]);
});

test('native failure falls back to in-app, reports once and keeps one sound', async () => {
  const failure = new Error('toast transport failed');
  const h = harness({
    focused: false,
    nativeResult: async () => {
      throw failure;
    },
  });
  await h.service.notify(h.notice('fallback'));
  assert.equal(h.calls.native.length, 1);
  assert.equal(h.calls.inApp.length, 1);
  assert.deepEqual(h.calls.sounds, ['done']);
  assert.equal(h.calls.errors.length, 1);
  assert.equal(h.calls.errors[0], failure);
  assert.equal(h.calls.reveals, 1);
});

test('in-app failure is reported and notify still resolves', async () => {
  const failure = new Error('webview gone');
  const h = harness({
    focused: true,
    inAppResult: async () => {
      throw failure;
    },
  });
  await h.service.notify(h.notice('ui-failure'));
  assert.equal(h.calls.errors.length, 1);
  assert.equal(h.calls.errors[0], failure);
  assert.equal(h.calls.reveals, 0);
});

test('dispose suppresses pending and later side effects', async () => {
  const claim = deferred<boolean>();
  const h = harness({ focused: true, claimEvent: () => claim.promise });
  const pending = h.service.notify(h.notice('pending'));
  h.service.dispose();
  claim.resolve(true);
  await pending;
  assert.deepEqual(h.calls.sounds, []);
  assert.equal(h.calls.inApp.length, 0);
  assert.equal(h.calls.reveals, 0);

  await h.service.notify(h.notice('after-dispose'));
  assert.equal(h.calls.claims.length, 1);
  assert.equal(h.calls.inApp.length, 0);
});

test('claim file creation is atomic and deduplicates across fresh helpers', async () => {
  const dir = join(artifacts, `claims-${process.pid}-${randomUUID()}`);
  const originalVscodePid = process.env.VSCODE_PID;
  delete process.env.VSCODE_PID;
  try {
    const results = await Promise.all([
      claimNotificationEvent(dir, 'logical-event'),
      claimNotificationEvent(dir, 'logical-event'),
    ]);
    assert.deepEqual(results.sort(), [false, true]);
    assert.equal(await claimNotificationEvent(dir, 'logical-event'), false);
    assert.equal(await claimNotificationEvent(dir, 'other-event'), true);

    const files = await readdir(dir);
    assert.equal(files.length, 2);
    for (const file of files) {
      assert.match(file, /^[a-f0-9]{64}\.claim$/);
      assert.match(await readFile(join(dir, file), 'utf8'), /^\d{4}-\d{2}-\d{2}T/);
    }
  } finally {
    if (originalVscodePid === undefined) delete process.env.VSCODE_PID;
    else process.env.VSCODE_PID = originalVscodePid;
    await rm(dir, { recursive: true, force: true });
  }
});

test('claim IO failures throw instead of granting a claim', async () => {
  await mkdir(artifacts, { recursive: true });
  const path = join(artifacts, `not-a-dir-${process.pid}-${randomUUID()}`);
  await writeFile(path, 'file');
  try {
    await assert.rejects(claimNotificationEvent(path, 'event'));
  } finally {
    await rm(path, { force: true });
  }
});

interface ToastCall {
  file: string;
  args: string[];
  options: ToastProcessOptions;
}

function toastRunner(code: number, calls: ToastCall[] = []): ToastRunner {
  return (file, args, options, callback) => {
    calls.push({ file, args: [...args], options });
    queueMicrotask(() => {
      const error: ToastError | null =
        code === 0 ? null : Object.assign(new Error('exit'), { code });
      callback(error, '', '');
    });
    return { kill() {} } as unknown as ChildProcess;
  };
}

test('toast transport keeps text in argv, disables shell and hides children', async () => {
  const calls: ToastCall[] = [];
  const notifications = new WindowsNotifications(
    'C:\\Tools\\snore toast.exe',
    ['--prefix'],
    toastRunner(0, calls),
  );
  const title = 'Quote " & $() <tag> & "x"';
  const message = 'Message %PATH% & "quoted"';
  assert.equal(
    await notifications.show({ id: 17, title, message, sound: false }),
    'activated',
  );
  const call = calls[0]!;
  assert.equal(call.file, 'C:\\Tools\\snore toast.exe');
  assert.deepEqual(call.args, [
    '--prefix',
    '-appID',
    'Microsoft.VisualStudioCode',
    '-id',
    '17',
    '-t',
    title,
    '-m',
    message,
    '-silent',
  ]);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.shell, false);
  assert.ok(call.options.timeout > 0 && call.options.timeout <= 60_000);
  notifications.dispose();
});

test('toast exit codes map to outcomes and unknown exits reject', async () => {
  const outcomes = [
    [0, 'activated'],
    [1, 'hidden'],
    [2, 'dismissed'],
    [3, 'timedOut'],
  ] as const;
  for (const [code, expected] of outcomes) {
    const notifications = new WindowsNotifications('snoretoast.exe', [], toastRunner(code));
    assert.equal(
      await notifications.show({ id: 1, title: 'A', message: 'B', sound: false }),
      expected,
    );
    notifications.dispose();
  }
  const failed = new WindowsNotifications('snoretoast.exe', [], toastRunner(7));
  await assert.rejects(
    failed.show({ id: 1, title: 'A', message: 'B', sound: false }),
    /could not complete/,
  );
  failed.dispose();
});

test('toast dispose kills the child and resolves cancellation', async () => {
  let callback:
    | ((error: ToastError | null, stdout: string, stderr: string) => void)
    | undefined;
  let killed = false;
  const runner: ToastRunner = (_file, _args, _options, cb) => {
    callback = cb;
    return {
      kill: () => {
        killed = true;
      },
    } as unknown as ChildProcess;
  };
  const notifications = new WindowsNotifications('snoretoast.exe', [], runner);
  const pending = notifications.show({ id: 1, title: 'A', message: 'B', sound: false });
  notifications.dispose();
  callback!(Object.assign(new Error('killed'), { code: 1, killed: true }), '', '');
  assert.equal(await pending, 'cancelled');
  assert.equal(killed, true);
  assert.equal(
    await notifications.show({ id: 1, title: 'A', message: 'B', sound: false }),
    'cancelled',
  );
});

interface SoundCall {
  file: string;
  args: readonly string[];
  options: { windowsHide: boolean; shell: boolean; timeout: number };
}

test('completion sound uses argv paths, no shell, hidden window and bounded timeout', async () => {
  const calls: SoundCall[] = [];
  const runner: SoundExecFile = (file, args, options, callback) => {
    calls.push({ file, args: [...args], options });
    queueMicrotask(() => callback(null));
  };
  await playCompletionSound('C:\\Extension Dir', runner);
  const call = calls[0]!;
  assert.equal(call.file, 'powershell.exe');
  assert.deepEqual(call.args, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-File',
    join('C:\\Extension Dir', 'resources', 'playCompletionSound.ps1'),
    '-Path',
    join('C:\\Extension Dir', 'resources', 'completion.wav'),
  ]);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.shell, false);
  assert.ok(call.options.timeout > 0 && call.options.timeout <= 30_000);
});

test('completion sound rejects transport errors', async () => {
  const runner: SoundExecFile = (_file, _args, _options, callback) => {
    queueMicrotask(() => callback(Object.assign(new Error('failed'), { code: 5 })));
  };
  await assert.rejects(
    playCompletionSound('C:\\x', runner),
    /Completion sound playback failed \(5\)/,
  );
});

test('waiting sound reuses the player with the dedicated wav', async () => {
  const calls: SoundCall[] = [];
  const runner: SoundExecFile = (file, args, options, callback) => {
    calls.push({ file, args: [...args], options });
    queueMicrotask(() => callback(null));
  };
  await playWaitingSound('C:\\Extension Dir', runner);
  const call = calls[0]!;
  assert.equal(call.file, 'powershell.exe');
  assert.deepEqual(call.args, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-File',
    join('C:\\Extension Dir', 'resources', 'playCompletionSound.ps1'),
    '-Path',
    join('C:\\Extension Dir', 'resources', 'waiting.wav'),
  ]);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.shell, false);
  assert.ok(call.options.timeout > 0 && call.options.timeout <= 30_000);
});

test('waiting sound rejects transport errors with its own label', async () => {
  const runner: SoundExecFile = (_file, _args, _options, callback) => {
    queueMicrotask(() => callback(Object.assign(new Error('failed'), { code: 5 })));
  };
  await assert.rejects(
    playWaitingSound('C:\\x', runner),
    /Waiting sound playback failed \(5\)/,
  );
});

test('waiting.wav is a short valid PCM asset distinct from the completion sound', async () => {
  const waiting = await readFile(join(process.cwd(), 'resources', 'waiting.wav'));
  const completion = await readFile(join(process.cwd(), 'resources', 'completion.wav'));

  assert.equal(waiting.toString('ascii', 0, 4), 'RIFF');
  assert.equal(waiting.toString('ascii', 8, 12), 'WAVE');
  assert.equal(waiting.readUInt16LE(20), 1);
  assert.equal(waiting.readUInt16LE(22), 1);
  assert.equal(waiting.readUInt32LE(24), 44_100);
  assert.equal(waiting.readUInt16LE(34), 16);

  const duration = waiting.readUInt32LE(40) / (44_100 * 2);
  assert.ok(duration > 0.2 && duration < 0.6, `unexpected duration ${duration}`);
  assert.notDeepEqual(waiting, completion);
});
