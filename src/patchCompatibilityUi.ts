import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  attestationFileForVersion,
  compatibilityFilesForVersion,
  inspectOfficialPatch,
  type PatchCompatibilityReport,
} from './patchCompatibility';
import {
  renderMaintenanceReport,
  type MaintenanceReport,
  type MaintenanceRuntime,
} from './patchMaintenance';
import type { BridgeState } from './workflowUi';

export const CHECK_COMPATIBILITY_COMMAND = 'codexCompanion.checkCompatibility';
export const PATCH_NOTICE_KEY = 'companion.patchNotice.v1';

const DEFAULT_INTERVAL_MS = 60_000;

export type CompatibilityKind = 'ready' | 'pending-reload' | 'incompatible';

export interface CompatibilityStatus {
  kind: CompatibilityKind;
  report: PatchCompatibilityReport;
  bridge: BridgeState;
  version: string | null;
  digest: string;
  summary: string;
  runtimeReady: boolean;
  notificationsAllowed: boolean;
  checkedAt: number;
}

export interface CompatibilityStatusItem {
  text: string;
  tooltip: unknown;
  command: unknown;
  show(): void;
  hide(): void;
  dispose(): void;
}

export interface DisposableLike {
  dispose(): void;
}

export interface CompatibilityUiDependencies {
  extensionPath: string;
  officialExtensionPath: () => string | undefined;
  bridgeState: () => BridgeState;
  hasOfficialTabs: () => boolean;
  globalState: {
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown): Thenable<void> | Promise<void>;
  };
  showWarning: (message: string, ...actions: string[]) => Promise<string | undefined>;
  showInformation?: ((message: string, ...actions: string[]) => Promise<string | undefined>) | undefined;
  openReport: (title: string, content: string) => Promise<void>;
  readMaintenance?: (() => Promise<MaintenanceReport>) | undefined;
  readAttestation?: (() => Promise<unknown>) | undefined;
  officialVersion?: (() => string | undefined) | undefined;
  statusItem?: CompatibilityStatusItem | undefined;
  onStatus?: ((status: CompatibilityStatus) => void) | undefined;
  onDidChangeExtensions?: ((handler: () => void) => DisposableLike) | undefined;
  onDidChangeWindowFocus?: ((handler: () => void) => DisposableLike) | undefined;
  schedule?: ((handler: () => void, milliseconds: number) => DisposableLike) | undefined;
  onError?: ((error: unknown) => void) | undefined;
  now?: (() => number) | undefined;
  intervalMs?: number | undefined;
}

interface SavedNotice {
  digest: string;
  version: string | null;
  at: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseSavedNotice(value: unknown): SavedNotice | undefined {
  if (!isRecord(value) || typeof value.digest !== 'string') return undefined;
  return {
    digest: value.digest,
    version: typeof value.version === 'string' ? value.version : null,
    at: typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : 0,
  };
}

async function readAttestationFile(path: string): Promise<unknown> {
  const text = await readFile(path, 'utf8');
  return JSON.parse(text.replace(/^\uFEFF/, ''));
}

/**
 * Read-only disk compatibility checks plus a small, de-duplicated warning UI.
 * It never patches, downloads, reloads, closes tabs, or writes a report file.
 */
export class PatchCompatibilityUi implements DisposableLike {
  private readonly disposables: DisposableLike[] = [];
  private cachedReport: PatchCompatibilityReport | undefined;
  private cachedSignature: string | undefined;
  private current: CompatibilityStatus | undefined;
  private lastNoticeDigest: string | undefined;
  private chain = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly deps: CompatibilityUiDependencies,
    private readonly russian: boolean,
  ) {
    const change = deps.onDidChangeExtensions?.(() => { void this.check(true); });
    if (change) this.disposables.push(change);
    const focus = deps.onDidChangeWindowFocus?.(() => { void this.check(false); });
    if (focus) this.disposables.push(focus);
    const scheduled = deps.schedule?.(
      () => { void this.check(false); },
      deps.intervalMs ?? DEFAULT_INTERVAL_MS,
    );
    if (scheduled) this.disposables.push(scheduled);
    if (deps.statusItem) this.disposables.push(deps.statusItem);
    void this.check(true);
  }

  status(): CompatibilityStatus | undefined {
    return this.current;
  }

  notificationsAllowed(): boolean {
    return this.current?.notificationsAllowed === true;
  }

  async check(force = false, suppressWarning = false): Promise<CompatibilityStatus | undefined> {
    const task = this.chain.then(() => this.run(force, suppressWarning));
    this.chain = task.then(() => undefined, () => undefined);
    return task;
  }

  async showStatus(): Promise<void> {
    const status = await this.check(true, true);
    if (!status) return;
    const details = this.tr('Подробнее', 'Details');
    const action = status.kind === 'ready'
      ? await this.showInformation(status.summary, details)
      : await this.showWarning(status.summary, details);
    if (action === details) await this.openReport(status);
    await this.markNoticed(status);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const disposable of this.disposables.splice(0)) {
      try {
        disposable.dispose();
      } catch {
        // Disposal is best effort.
      }
    }
  }

  private async run(force: boolean, suppressWarning: boolean): Promise<CompatibilityStatus | undefined> {
    if (this.disposed) return this.current;
    try {
      const signature = await this.signature();
      let report: PatchCompatibilityReport;
      if (!force && this.cachedReport && signature === this.cachedSignature) {
        report = this.cachedReport;
      } else {
        report = await this.inspect();
        this.cachedReport = report;
        this.cachedSignature = signature;
      }
      if (this.disposed) return this.current;

      const status = this.computeStatus(report);
      this.current = status;
      this.render(status);
      try {
        this.deps.onStatus?.(status);
      } catch (error) {
        this.report(error);
      }
      if (!suppressWarning) void this.maybeWarn(status).catch(error => this.report(error));
      return status;
    } catch (error) {
      this.report(error);
      return this.current;
    }
  }

  private async signature(): Promise<string> {
    const official = this.deps.officialExtensionPath();
    const version = this.currentOfficialVersion();
    const files = compatibilityFilesForVersion(version);
    const paths = [
      this.attestationPath(),
      official ? join(official, 'package.json') : 'missing-official-extension',
      ...(official
        ? files
          .filter(file => file !== 'package.json')
          .map(file => join(official, ...file.split('/')))
        : []),
    ];
    const parts: string[] = [];
    for (const path of paths) {
      try {
        const info = await stat(path);
        parts.push(`${path}:${info.mtimeMs}:${info.size}`);
      } catch (error) {
        parts.push(`${path}:absent:${errorCode(error) ?? 'error'}`);
      }
    }
    return parts.join('|');
  }

  private async inspect(): Promise<PatchCompatibilityReport> {
    const resource = attestationFileForVersion(this.currentOfficialVersion());
    let attestation: unknown;
    try {
      attestation = this.deps.readAttestation
        ? await this.deps.readAttestation()
        : await readAttestationFile(this.attestationPath());
    } catch (error) {
      const code = errorCode(error);
      const missing = code === 'ENOENT' || code === 'ENOTDIR';
      return {
        ok: false,
        code: missing ? 'manifest' : 'io',
        version: this.currentOfficialVersion() ?? null,
        issues: [missing
          ? this.tr(
            `Файл ресурсов ${resource} не найден: ${this.attestationPath()}.`,
            `The ${resource} resource is missing: ${this.attestationPath()}.`,
          )
          : this.tr(
            `Не удалось прочитать ${resource}: ${errorText(error)}`,
            `Could not read ${resource}: ${errorText(error)}`,
          )],
      };
    }
    return inspectOfficialPatch(this.deps.officialExtensionPath(), attestation);
  }

  private computeStatus(report: PatchCompatibilityReport): CompatibilityStatus {
    let bridge: BridgeState = 'absent';
    try {
      bridge = this.deps.bridgeState();
    } catch (error) {
      this.report(error);
    }
    const runtimeReady = report.ok && bridge === 'ready';
    const kind: CompatibilityKind = report.ok
      ? (runtimeReady ? 'ready' : 'pending-reload')
      : 'incompatible';
    const version = report.version ?? this.deps.officialVersion?.() ?? null;
    const checkedAt = this.deps.now?.() ?? Date.now();
    const digest = createHash('sha256').update(JSON.stringify({
      schema: 1,
      kind,
      version,
      code: report.code,
      issues: [...report.issues].sort(),
      bridge,
    })).digest('hex');
    return {
      kind,
      report,
      bridge,
      version,
      digest,
      summary: this.summary(kind, report, bridge, version),
      runtimeReady,
      notificationsAllowed: runtimeReady,
      checkedAt,
    };
  }

  private async maybeWarn(status: CompatibilityStatus): Promise<void> {
    if (this.disposed || status.kind === 'ready') return;
    if (status.kind === 'pending-reload' && status.bridge === 'unknown') return;
    if (!this.hasOfficialTabs()) return;

    let saved: SavedNotice | undefined;
    try {
      saved = parseSavedNotice(this.deps.globalState.get<unknown>(PATCH_NOTICE_KEY, undefined));
    } catch (error) {
      this.report(error);
    }
    if (saved?.digest === status.digest || this.lastNoticeDigest === status.digest) return;
    this.lastNoticeDigest = status.digest;

    try {
      await this.deps.globalState.update(PATCH_NOTICE_KEY, {
        digest: status.digest,
        version: status.version,
        at: this.deps.now?.() ?? Date.now(),
      } satisfies SavedNotice);
    } catch (error) {
      this.report(error);
    }
    if (this.disposed) return;

    const details = this.tr('Подробнее', 'Details');
    const action = await this.showWarning(status.summary, details);
    if (!this.disposed && action === details) await this.openReport(status);
  }

  private async markNoticed(status: CompatibilityStatus): Promise<void> {
    if (status.kind === 'ready' || this.disposed) return;
    this.lastNoticeDigest = status.digest;
    try {
      await this.deps.globalState.update(PATCH_NOTICE_KEY, {
        digest: status.digest,
        version: status.version,
        at: this.deps.now?.() ?? Date.now(),
      } satisfies SavedNotice);
    } catch (error) {
      this.report(error);
    }
  }

  private summary(
    kind: CompatibilityKind,
    report: PatchCompatibilityReport,
    bridge: BridgeState,
    version: string | null,
  ): string {
    const label = version ? `Codex ${version}` : 'Codex';
    if (kind === 'ready') {
      return this.tr(
        `${label}: совместимость подтверждена, мост уведомлений активен.`,
        `${label}: compatibility verified and the notification bridge is active.`,
      );
    }
    if (kind === 'pending-reload') {
      return this.tr(
        `${label}: файлы совместимы, но мост уведомлений ещё не загружен в этом окне. Перезапустите окно после завершения задач, чтобы включить уведомления.`,
        `${label}: the files match, but the notification bridge is not loaded in this window. Reload the window after running tasks finish to enable notifications.`,
      );
    }
    if (report.code === 'version') {
      return this.tr(
        `${label}: установлена непроверенная версия Codex. Дополнительные возможности Companion не включены; обновление и перезапуск выполняются вручную.`,
        `${label}: an unverified Codex version is installed. Companion features are not enabled; update and reload actions remain manual.`,
      );
    }
    return this.tr(
      `${label}: совместимость не подтверждена: локальные дополнения отсутствуют или изменены. Откройте отчёт для подробностей.`,
      `${label}: compatibility is not verified: local enhancements are missing or changed. Open the report for details.`,
    );
  }

  private reportText(status: CompatibilityStatus): string {
    const lines = [
      this.tr('Отчёт о совместимости Codex Companion', 'Codex Companion compatibility report'),
      '',
      `${this.tr('Состояние', 'Status')}: ${status.kind}`,
      `${this.tr('Версия Codex', 'Codex version')}: ${status.version ?? this.tr('неизвестна', 'unknown')}`,
      `${this.tr('Мост', 'Bridge')}: ${status.bridge}`,
      `${this.tr('Код проверки', 'Check code')}: ${status.report.code}`,
      `${this.tr('Время проверки', 'Checked at')}: ${new Date(status.checkedAt).toISOString()}`,
      '',
      `${this.tr('Проблемы', 'Issues')}:`,
      ...(status.report.issues.length > 0
        ? status.report.issues.map(issue => `- ${issue}`)
        : [`- ${this.tr('нет', 'none')}`]),
      '',
      this.tr(
        'Изменения не применялись. Перезапуск, обновление и закрытие вкладок выполняются вручную.',
        'No changes were applied. Reload, update, and tab-closing actions remain manual.',
      ),
    ];
    return lines.join('\n');
  }

  private async openReport(status: CompatibilityStatus): Promise<void> {
    try {
      await this.deps.openReport(
        this.tr('Совместимость Codex Companion', 'Codex Companion compatibility'),
        await this.reportContent(status),
      );
    } catch (error) {
      this.report(error);
    }
  }

  private async reportContent(status: CompatibilityStatus): Promise<string> {
    if (!this.deps.readMaintenance) return this.reportText(status);
    try {
      const report = await this.deps.readMaintenance();
      const runtime: MaintenanceRuntime = {
        bridge: status.bridge,
        runtimeReady: status.runtimeReady,
      };
      return renderMaintenanceReport(report, this.russian, runtime);
    } catch (error) {
      this.report(error);
      return this.reportText(status);
    }
  }

  private async showWarning(message: string, details: string): Promise<string | undefined> {
    try {
      return await this.deps.showWarning(message, details);
    } catch (error) {
      this.report(error);
      return undefined;
    }
  }

  private async showInformation(message: string, ...actions: string[]): Promise<string | undefined> {
    if (!this.deps.showInformation) return undefined;
    try {
      return await this.deps.showInformation(message, ...actions);
    } catch (error) {
      this.report(error);
      return undefined;
    }
  }

  private render(status: CompatibilityStatus): void {
    const item = this.deps.statusItem;
    if (!item) return;
    try {
      if (status.kind === 'incompatible') {
        item.text = '$(warning) $(codex-companion-logo)';
        item.tooltip = status.summary;
        item.command = CHECK_COMPATIBILITY_COMMAND;
        item.show();
      } else {
        item.hide();
      }
    } catch (error) {
      this.report(error);
    }
  }

  private hasOfficialTabs(): boolean {
    try {
      return this.deps.hasOfficialTabs() === true;
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  private attestationPath(): string {
    return join(
      this.deps.extensionPath,
      'resources',
      attestationFileForVersion(this.currentOfficialVersion()),
    );
  }

  private currentOfficialVersion(): string | undefined {
    try {
      return this.deps.officialVersion?.();
    } catch (error) {
      this.report(error);
      return undefined;
    }
  }

  private tr(russian: string, english: string): string {
    return this.russian ? russian : english;
  }

  private report(error: unknown): void {
    try {
      this.deps.onError?.(error);
    } catch {
      // Diagnostics must not break compatibility checks.
    }
  }
}
