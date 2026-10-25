import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, win32 } from 'node:path';

export const PROJECT_ENVIRONMENT_COMMAND = 'codexCompanion.openProjectEnvironment';
export const MARKER_NAME = 'companion-project.json';
export const CODEX_HOME_DIR = 'codex-home';
export const USER_DATA_DIR = 'userdata';
export const PROJECT_ID_ENV = 'CODEX_COMPANION_PROJECT_ID';
export const OPENED_FLAG_PREFIX = 'codexCompanion.projectEnvironment.opened.';
export const MARKER_SCHEMA_VERSION = 1;

export type WorkspaceFailureCode =
  | 'unsupported-platform'
  | 'remote'
  | 'untrusted'
  | 'no-workspace'
  | 'non-file-root'
  | 'unsaved-multi-root'
  | 'unsupported-workspace-file'
  | 'relative-root'
  | 'missing-root'
  | 'missing-workspace-file';

export interface WorkspaceFolderSnapshot {
  scheme: string;
  path: string;
}

export interface WorkspaceSnapshot {
  trusted: boolean;
  remote: boolean;
  platform: NodeJS.Platform;
  folders: readonly WorkspaceFolderSnapshot[];
  workspaceFile?: WorkspaceFolderSnapshot;
}

export type WorkspaceResolution =
  | { ok: true; target: string; roots: string[] }
  | { ok: false; reason: WorkspaceFailureCode };

export interface ProjectEnvironmentFs {
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  isFile(path: string): boolean;
  readText(path: string): string | undefined;
  writeExclusive(path: string, text: string): void;
  mkdir(path: string): void;
  realpath(path: string): string;
}

export interface SpawnOptionsLike {
  shell: false;
  windowsHide: false;
  detached: true;
  stdio: 'ignore';
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface ChildProcessLike {
  once(event: 'spawn' | 'error', listener: (error?: Error) => void): unknown;
  unref(): void;
}

export interface ProjectEnvironmentDeps {
  platform: NodeJS.Platform;
  env: Readonly<NodeJS.ProcessEnv>;
  localAppData: string | undefined;
  execPath: string;
  fs: ProjectEnvironmentFs;
  spawn(file: string, args: readonly string[], options: SpawnOptionsLike): ChildProcessLike;
}

export type ProjectEnvironmentFailure =
  | 'executable'
  | 'local-app-data'
  | 'marker-invalid'
  | 'marker-mismatch'
  | 'filesystem'
  | 'spawn';

export type ProjectEnvironmentResult =
  | { status: 'launched'; key: string; profile: string }
  | { status: 'already-isolated'; key: string; profile: string }
  | { status: 'busy' }
  | { status: 'workspace'; reason: WorkspaceFailureCode }
  | { status: 'error'; reason: ProjectEnvironmentFailure };

export interface ProjectMarker {
  schemaVersion: 1;
  roots: string[];
}

export type ProjectMarkerState =
  | { kind: 'missing' }
  | { kind: 'valid'; marker: ProjectMarker }
  | { kind: 'malformed' }
  | { kind: 'mismatch' };

export interface InitialOpenOptions {
  isolated: boolean;
  key: string;
  alreadyOpened: boolean;
  markOpened(): PromiseLike<void>;
  open(): PromiseLike<unknown>;
}

/** Normalizes Windows paths without touching the filesystem. */
export function normalizeWindowsRoot(input: string): string {
  let value = input.trim().replace(/\//g, '\\');
  if (/^\\\\\?\\UNC\\/i.test(value)) value = '\\\\' + value.slice(8);
  else if (value.startsWith('\\\\?\\')) value = value.slice(4);
  const unc = value.startsWith('\\\\');
  value = value.replace(/\\+/g, '\\');
  if (unc && !value.startsWith('\\\\')) value = '\\' + value;
  if (/^[a-z]:/.test(value)) value = value[0]!.toUpperCase() + value.slice(1);
  const driveRoot = /^[A-Za-z]:\\$/.test(value);
  while (!driveRoot && value.length > 1 && value.endsWith('\\')) value = value.slice(0, -1);
  return value;
}

export function stableRoot(root: string): string {
  return normalizeWindowsRoot(root).toLowerCase();
}

/** Ordered, case-insensitive Windows workspace identity. */
export function projectKey(roots: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify(roots.map(stableRoot)), 'utf8')
    .digest('hex')
    .slice(0, 32);
}

export function canonicalRoots(fs: Pick<ProjectEnvironmentFs, 'realpath'>, roots: readonly string[]): string[] {
  return roots.map(root => normalizeWindowsRoot(fs.realpath(normalizeWindowsRoot(root))));
}

export function projectProfilePath(localAppData: string, key: string): string {
  if (!/^[0-9a-f]{32}$/.test(key)) throw new Error('Invalid project key');
  return join(localAppData, 'CodexCompanion', 'projects', key);
}

export function isKnownVSCodeExecutable(execPath: string): boolean {
  const name = win32.basename(execPath).toLowerCase();
  return name === 'code.exe' || name === 'code - insiders.exe';
}

export function isIsolatedProfile(env: Readonly<NodeJS.ProcessEnv>, key: string, codexHome: string): boolean {
  return env[PROJECT_ID_ENV] === key
    && typeof env.CODEX_HOME === 'string'
    && stableRoot(env.CODEX_HOME) === stableRoot(codexHome)
    && (env.CODEX_SQLITE_HOME === undefined || stableRoot(env.CODEX_SQLITE_HOME) === stableRoot(codexHome));
}

export function childArguments(userData: string, target: string): string[] {
  return ['--new-window', '--user-data-dir', userData, '--skip-welcome', '--skip-release-notes', target];
}

export function childEnvironment(
  base: Readonly<NodeJS.ProcessEnv>,
  codexHome: string,
  key: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    CODEX_HOME: codexHome,
    CODEX_SQLITE_HOME: codexHome,
    [PROJECT_ID_ENV]: key,
  };
  // A VS Code extension host may be running Electron in Node mode. The new
  // process must start the desktop application and use its own CLI endpoint.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VSCODE_IPC_HOOK_CLI;
  return env;
}

export function resolveWorkspace(
  workspace: WorkspaceSnapshot,
  fs: Pick<ProjectEnvironmentFs, 'exists' | 'isDirectory' | 'isFile'>,
): WorkspaceResolution {
  if (workspace.platform !== 'win32') return { ok: false, reason: 'unsupported-platform' };
  if (workspace.remote) return { ok: false, reason: 'remote' };
  if (!workspace.trusted) return { ok: false, reason: 'untrusted' };
  if (!workspace.folders.length) return { ok: false, reason: 'no-workspace' };
  if (workspace.folders.some(folder => folder.scheme !== 'file' || !folder.path)) {
    return { ok: false, reason: 'non-file-root' };
  }
  if (workspace.workspaceFile && workspace.workspaceFile.scheme !== 'file') {
    return { ok: false, reason: 'unsupported-workspace-file' };
  }
  if (!workspace.workspaceFile && workspace.folders.length > 1) {
    return { ok: false, reason: 'unsaved-multi-root' };
  }

  const roots: string[] = [];
  for (const folder of workspace.folders) {
    const root = normalizeWindowsRoot(folder.path);
    if (!isAbsoluteWindowsPath(root)) return { ok: false, reason: 'relative-root' };
    if (!fs.exists(root) || !fs.isDirectory(root)) return { ok: false, reason: 'missing-root' };
    roots.push(root);
  }

  let target: string;
  if (workspace.workspaceFile) {
    const file = normalizeWindowsRoot(workspace.workspaceFile.path);
    if (!isAbsoluteWindowsPath(file)) return { ok: false, reason: 'relative-root' };
    if (!fs.exists(file) || !fs.isFile(file)) return { ok: false, reason: 'missing-workspace-file' };
    target = file;
  } else {
    target = roots[0]!;
  }
  return { ok: true, target, roots };
}

export function markerDocument(roots: readonly string[]): string {
  return `${JSON.stringify({ schemaVersion: MARKER_SCHEMA_VERSION, roots: [...roots] }, null, 2)}\n`;
}

export function parseProjectMarker(raw: string): ProjectMarker | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (record.schemaVersion !== MARKER_SCHEMA_VERSION) return undefined;
    const roots = record.roots;
    if (!Array.isArray(roots) || !roots.length) return undefined;
    if (!roots.every(root => typeof root === 'string' && root.length > 0)) return undefined;
    return { schemaVersion: MARKER_SCHEMA_VERSION, roots: roots as string[] };
  } catch {
    return undefined;
  }
}

export function markerMatches(marker: ProjectMarker, roots: readonly string[]): boolean {
  if (marker.roots.length !== roots.length) return false;
  return marker.roots.every((root, index) => stableRoot(root) === stableRoot(roots[index]!));
}

export function readMarkerState(
  fs: Pick<ProjectEnvironmentFs, 'readText'>,
  markerPath: string,
  roots: readonly string[],
): ProjectMarkerState {
  const raw = fs.readText(markerPath);
  if (raw === undefined) return { kind: 'missing' };
  const marker = parseProjectMarker(raw);
  if (!marker) return { kind: 'malformed' };
  if (!markerMatches(marker, roots)) return { kind: 'mismatch' };
  return { kind: 'valid', marker };
}

export async function openOnceOnIsolatedStartup(options: InitialOpenOptions): Promise<boolean> {
  if (!options.isolated || options.alreadyOpened || !options.key) return false;
  await options.markOpened();
  await options.open();
  return true;
}

export class ProjectEnvironmentLauncher {
  private busy = false;

  constructor(private readonly deps: ProjectEnvironmentDeps) {}

  async launch(workspace: WorkspaceSnapshot): Promise<ProjectEnvironmentResult> {
    if (this.busy) return { status: 'busy' };
    this.busy = true;
    try {
      return await this.run(workspace);
    } finally {
      this.busy = false;
    }
  }

  private async run(workspace: WorkspaceSnapshot): Promise<ProjectEnvironmentResult> {
    if (this.deps.platform !== 'win32') return { status: 'workspace', reason: 'unsupported-platform' };
    const resolution = resolveWorkspace(workspace, this.deps.fs);
    if (!resolution.ok) return { status: 'workspace', reason: resolution.reason };
    if (!isKnownVSCodeExecutable(this.deps.execPath)) return { status: 'error', reason: 'executable' };
    const localAppData = this.deps.localAppData?.trim();
    if (!localAppData || !win32.isAbsolute(localAppData)) return { status: 'error', reason: 'local-app-data' };

    let roots: string[];
    let key: string;
    let profile: string;
    let codexHome: string;
    let userData: string;
    let markerPath: string;
    try {
      roots = canonicalRoots(this.deps.fs, resolution.roots);
      key = projectKey(roots);
      profile = projectProfilePath(localAppData, key);
      codexHome = join(profile, CODEX_HOME_DIR);
      userData = join(profile, USER_DATA_DIR);
      markerPath = join(profile, MARKER_NAME);
    } catch {
      return { status: 'error', reason: 'filesystem' };
    }

    try {
      let state = readMarkerState(this.deps.fs, markerPath, roots);
      if (state.kind === 'malformed') return { status: 'error', reason: 'marker-invalid' };
      if (state.kind === 'mismatch') return { status: 'error', reason: 'marker-mismatch' };
      if (state.kind === 'missing') {
        this.deps.fs.mkdir(profile);
        this.deps.fs.mkdir(codexHome);
        this.deps.fs.mkdir(userData);
        try {
          this.deps.fs.writeExclusive(markerPath, markerDocument(roots));
        } catch (error) {
          if (!hasErrorCode(error, 'EEXIST')) throw error;
          state = readMarkerState(this.deps.fs, markerPath, roots);
          if (state.kind === 'malformed') return { status: 'error', reason: 'marker-invalid' };
          if (state.kind === 'mismatch') return { status: 'error', reason: 'marker-mismatch' };
          if (state.kind !== 'valid') return { status: 'error', reason: 'filesystem' };
        }
      }
      if (isIsolatedProfile(this.deps.env, key, codexHome)) {
        return { status: 'already-isolated', key, profile };
      }
      this.deps.fs.mkdir(codexHome);
      this.deps.fs.mkdir(userData);
    } catch {
      return { status: 'error', reason: 'filesystem' };
    }

    try {
      const child = this.deps.spawn(this.deps.execPath, childArguments(userData, resolution.target), {
        shell: false,
        windowsHide: false,
        detached: true,
        stdio: 'ignore',
        cwd: roots[0]!,
        env: childEnvironment(this.deps.env, codexHome, key),
      });
      await waitForSpawn(child);
      child.unref();
    } catch {
      return { status: 'error', reason: 'spawn' };
    }
    return { status: 'launched', key, profile };
  }
}

export class ProjectEnvironmentUi implements vscode.Disposable {
  private readonly subscription: vscode.Disposable;
  private warnedMismatch = false;
  private readonly fs = createProjectEnvironmentFs();
  private readonly launcher: ProjectEnvironmentLauncher;

  constructor(private readonly context: vscode.ExtensionContext, private readonly ru: boolean) {
    this.launcher = new ProjectEnvironmentLauncher({
      platform: process.platform,
      env: process.env,
      localAppData: process.env.LOCALAPPDATA,
      execPath: process.execPath,
      fs: this.fs,
      spawn: (file, args, options) => spawn(file, [...args], options as SpawnOptions) as unknown as ChildProcessLike,
    });
    this.subscription = vscode.Disposable.from(
      vscode.commands.registerCommand(PROJECT_ENVIRONMENT_COMMAND, () => this.open()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => { this.guardCurrentWorkspace(); }),
    );
  }

  guardCurrentWorkspace(): boolean {
    if (!process.env[PROJECT_ID_ENV]) return true;
    try {
      const resolution = resolveWorkspace(this.workspaceSnapshot(), this.fs);
      const local = process.env.LOCALAPPDATA;
      if (resolution.ok && local && win32.isAbsolute(local)) {
        const roots = canonicalRoots(this.fs, resolution.roots);
        const key = projectKey(roots);
        const profile = projectProfilePath(local, key);
        if (isIsolatedProfile(process.env, key, join(profile, CODEX_HOME_DIR))
          && readMarkerState(this.fs, join(profile, MARKER_NAME), roots).kind === 'valid') {
          this.warnedMismatch = false;
          return true;
        }
      }
    } catch { /* Report a workspace/environment mismatch below. */ }
    if (!this.warnedMismatch) {
      this.warnedMismatch = true;
      void vscode.window.showWarningMessage(this.tr(
        'Это отдельное окно закреплено за другим проектом. Для текущих папок выполните «Codex: Открыть проект с отдельной историей».',
        'This separate window belongs to another project. Run “Codex: Open Project with Separate History” for the current folders.'));
    }
    return false;
  }

  async open(): Promise<void> {
    let result: ProjectEnvironmentResult;
    try {
      result = await this.launcher.launch(this.workspaceSnapshot());
    } catch {
      void vscode.window.showErrorMessage(this.tr(
        'Не удалось создать отдельное окружение проекта.',
        'Could not create the separate project environment.'));
      return;
    }
    this.report(result);
  }

  async openInitialIfIsolated(): Promise<boolean> {
    try {
      if (!this.guardCurrentWorkspace()) return false;
      const workspace = this.workspaceSnapshot();
      const resolution = resolveWorkspace(workspace, this.fs);
      if (!resolution.ok) return false;
      const roots = canonicalRoots(this.fs, resolution.roots);
      const key = projectKey(roots);
      const localAppData = process.env.LOCALAPPDATA?.trim();
      if (!localAppData) return false;
      const profile = projectProfilePath(localAppData, key);
      const marker = readMarkerState(this.fs, join(profile, MARKER_NAME), roots);
      if (marker.kind !== 'valid') return false;
      const codexHome = join(profile, CODEX_HOME_DIR);
      if (!isIsolatedProfile(process.env, key, codexHome)) return false;
      const flag = OPENED_FLAG_PREFIX + key;
      return await openOnceOnIsolatedStartup({
        isolated: true,
        key,
        alreadyOpened: this.context.globalState.get<boolean>(flag) === true,
        markOpened: () => this.context.globalState.update(flag, true),
        open: () => vscode.commands.executeCommand('codexCompanion.open'),
      });
    } catch {
      return false;
    }
  }

  dispose(): void {
    this.subscription.dispose();
  }

  private workspaceSnapshot(): WorkspaceSnapshot {
    const workspaceFile = vscode.workspace.workspaceFile;
    return {
      trusted: vscode.workspace.isTrusted,
      remote: !!vscode.env.remoteName,
      platform: process.platform,
      folders: (vscode.workspace.workspaceFolders ?? []).map(folder => ({
        scheme: folder.uri.scheme,
        path: folder.uri.fsPath,
      })),
      ...(workspaceFile ? {
        workspaceFile: { scheme: workspaceFile.scheme, path: workspaceFile.fsPath },
      } : {}),
    };
  }

  private report(result: ProjectEnvironmentResult): void {
    if (result.status === 'busy') return;
    if (result.status === 'launched') {
      void vscode.window.showInformationMessage(this.tr(
        'Открыто отдельное окно проекта.',
        'A separate project window was opened.'));
      return;
    }
    if (result.status === 'already-isolated') {
      void vscode.window.showInformationMessage(this.tr(
        'Это окно уже использует отдельное окружение проекта.',
        'This window already uses a separate project environment.'));
      return;
    }
    if (result.status === 'workspace') {
      void vscode.window.showWarningMessage(workspaceFailureText(result.reason, this.ru));
      return;
    }
    void vscode.window.showErrorMessage(environmentFailureText(result.reason, this.ru));
  }

  private tr(russian: string, english: string): string {
    return this.ru ? russian : english;
  }
}

function isAbsoluteWindowsPath(value: string): boolean {
  return /^[A-Za-z]:\\/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === code;
}

function waitForSpawn(child: ChildProcessLike): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };
    child.once('spawn', () => finish(() => resolve()));
    child.once('error', error => finish(() => reject(error)));
  });
}

function createProjectEnvironmentFs(): ProjectEnvironmentFs {
  return {
    exists: path => existsSync(path),
    isDirectory: path => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    },
    isFile: path => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },
    readText: path => {
      try {
        return readFileSync(path, 'utf8');
      } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) return undefined;
        throw error;
      }
    },
    writeExclusive: (path, text) => writeFileSync(path, text, { encoding: 'utf8', flag: 'wx' }),
    mkdir: path => {
      mkdirSync(path, { recursive: true });
    },
    realpath: path => realpathSync.native(path),
  };
}

function workspaceFailureText(code: WorkspaceFailureCode, ru: boolean): string {
  switch (code) {
    case 'unsupported-platform':
      return ru ? 'Команда доступна только в локальном окне Windows.' : 'This command is available only in a local Windows window.';
    case 'remote':
      return ru ? 'Команда недоступна в удалённом окне.' : 'This command is not available in a remote window.';
    case 'untrusted':
      return ru ? 'Сначала доверьте рабочему пространству.' : 'Trust this workspace first.';
    case 'no-workspace':
      return ru ? 'Сначала откройте папку проекта.' : 'Open a project folder first.';
    case 'non-file-root':
      return ru ? 'Поддерживаются только локальные папки.' : 'Only local folders are supported.';
    case 'unsaved-multi-root':
      return ru
        ? 'Сначала сохраните рабочее пространство в файл .code-workspace.'
        : 'Save the workspace to a .code-workspace file first.';
    case 'unsupported-workspace-file':
      return ru
        ? 'Поддерживаются только локальные файлы .code-workspace.'
        : 'Only saved local .code-workspace files are supported.';
    case 'relative-root':
      return ru ? 'Путь к папке проекта должен быть абсолютным.' : 'The project folder path must be absolute.';
    case 'missing-root':
      return ru ? 'Папка проекта не существует.' : 'A project folder no longer exists.';
    case 'missing-workspace-file':
      return ru ? 'Файл рабочего пространства не существует.' : 'The workspace file no longer exists.';
    default:
      return ru ? 'Не удалось подготовить отдельное окружение проекта.' : 'Could not prepare the separate project environment.';
  }
}

function environmentFailureText(code: ProjectEnvironmentFailure, ru: boolean): string {
  switch (code) {
    case 'executable':
      return ru
        ? 'Текущий процесс не является исполняемым файлом VS Code Code.exe; запуск отменён.'
        : 'The current process is not the VS Code Code.exe executable; launch was cancelled.';
    case 'local-app-data':
      return ru ? 'Не удалось определить LOCALAPPDATA.' : 'LOCALAPPDATA is unavailable.';
    case 'marker-invalid':
      return ru
        ? 'Файл окружения проекта повреждён; изменения не внесены.'
        : 'The project environment marker is invalid; nothing was changed.';
    case 'marker-mismatch':
      return ru
        ? 'Файл окружения проекта относится к другим папкам; изменения не внесены.'
        : 'The project environment marker belongs to different folders; nothing was changed.';
    case 'filesystem':
      return ru
        ? 'Не удалось создать отдельное окружение проекта.'
        : 'Could not create the separate project environment.';
    case 'spawn':
      return ru
        ? 'Не удалось запустить отдельное окно VS Code.'
        : 'Could not start a separate VS Code window.';
    default:
      return ru ? 'Не удалось создать отдельное окружение проекта.' : 'Could not create the separate project environment.';
  }
}
