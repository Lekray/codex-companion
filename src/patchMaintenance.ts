import type { BridgeState } from './workflowUi';

export const INSTALL_PATCH_COMMAND = 'codexCompanion.installPatch';
export const RESTORE_PATCH_COMMAND = 'codexCompanion.restorePatch';

export type MaintenanceState =
  | 'original'
  | 'history'
  | 'titles'
  | 'workflow'
  | 'drafts'
  | 'mixed'
  | 'incompatible';

export type MaintenanceFeatureStatus = 'installed' | 'missing' | 'partial' | 'unverified';
export type MaintenanceBackupStatus = 'valid' | 'missing' | 'invalid';

export interface MaintenanceFile {
  path: string;
  state: string;
  hash: string | null;
}

export interface MaintenanceFeature {
  id: string;
  status: MaintenanceFeatureStatus;
}

export interface MaintenanceBackup {
  path: string;
  status: MaintenanceBackupStatus;
  issues: string[];
}

export interface MaintenanceReport {
  schema: 1;
  version: string | null;
  supportedVersion: string;
  state: MaintenanceState;
  code: string;
  files: MaintenanceFile[];
  features: MaintenanceFeature[];
  backup: MaintenanceBackup;
  canInstall: boolean;
  canRestore: boolean;
  issues: string[];
  operation?: string;
  changed?: boolean;
  rollbackErrors?: string[];
}

export interface MaintenanceEngineOptions {
  extDir: string;
  backupDir: string;
  originalDir?: string;
  legacyBackupDir?: string;
}

export interface MaintenanceEngine {
  check(options: MaintenanceEngineOptions): Promise<MaintenanceReport>;
  install(options: MaintenanceEngineOptions): Promise<MaintenanceReport>;
  restore(options: MaintenanceEngineOptions): Promise<MaintenanceReport>;
}

export interface MaintenanceRuntime {
  bridge?: BridgeState;
  runtimeReady?: boolean;
}

export interface MaintenanceUiDependencies {
  engine: MaintenanceEngine;
  options(): MaintenanceEngineOptions | undefined;
  allowed(): boolean;
  showInformation(message: string, ...actions: string[]): Promise<string | undefined>;
  showError(message: string, ...actions: string[]): Promise<string | undefined>;
  openReport(title: string, content: string): Promise<void>;
  onChanged(): Promise<void>;
}

const FEATURE_LABELS: Record<string, { russian: string; english: string }> = {
  'project-history': { russian: 'История проектов', english: 'Project history' },
  'startup-watchdog': { russian: 'Восстановление запуска вкладок', english: 'Tab startup recovery' },
  'native-tab-titles': { russian: 'Заголовки вкладок', english: 'Native tab titles' },
  'project-model': { russian: 'Модель и effort проекта', english: 'Project model and effort' },
  'tab-status': { russian: 'Статус вкладок', english: 'Tab status' },
  'workflow-notifications': {
    russian: 'Уведомления о ходе работы',
    english: 'Workflow notifications',
  },
  'independent-drafts': { russian: 'Раздельные черновики вкладок', english: 'Independent tab drafts' },
};

const STATE_LABELS: Record<MaintenanceState, { russian: string; english: string }> = {
  original: { russian: 'оригинальные файлы', english: 'original files' },
  history: { russian: 'патч истории проектов', english: 'project history patch' },
  titles: { russian: 'патч заголовков вкладок', english: 'native tab titles patch' },
  workflow: { russian: 'модель, статусы и уведомления установлены', english: 'model, status and notifications installed' },
  drafts: { russian: 'все дополнения установлены', english: 'all enhancements installed' },
  mixed: { russian: 'смешанное состояние', english: 'mixed state' },
  incompatible: { russian: 'несовместимо', english: 'incompatible' },
};

const BACKUP_LABELS: Record<MaintenanceBackupStatus, { russian: string; english: string }> = {
  valid: { russian: 'доступна', english: 'available' },
  missing: { russian: 'отсутствует', english: 'missing' },
  invalid: { russian: 'повреждена', english: 'invalid' },
};

const FEATURE_STATUS_LABELS: Record<MaintenanceFeatureStatus, { russian: string; english: string }> = {
  installed: { russian: 'установлено', english: 'installed' },
  missing: { russian: 'отсутствует', english: 'missing' },
  partial: { russian: 'частично', english: 'partial' },
  unverified: { russian: 'не проверено', english: 'unverified' },
};

function tr(russian: boolean, ru: string, en: string): string {
  return russian ? ru : en;
}

function isKnownPredecessor(state: MaintenanceState): boolean {
  return state === 'original' || state === 'history' || state === 'titles' || state === 'workflow' || state === 'drafts';
}

function isPatched(state: MaintenanceState): boolean {
  return state === 'history' || state === 'titles' || state === 'workflow' || state === 'drafts';
}

function featureLabel(id: string, russian: boolean): string {
  const label = FEATURE_LABELS[id];
  if (!label) return id;
  return russian ? label.russian : label.english;
}

function featureStatusText(
  feature: MaintenanceFeature,
  runtime: MaintenanceRuntime | undefined,
  russian: boolean,
): string {
  if (feature.id === 'workflow-notifications' && feature.status === 'installed') {
    if (runtime?.bridge === 'ready' && runtime.runtimeReady === true) {
      return tr(russian, 'установлено — уведомления активны', 'installed — notifications active');
    }
    if (runtime?.bridge === 'absent') {
      return tr(russian, 'установлено — нужна перезагрузка окна', 'installed — reload pending');
    }
    if (runtime?.bridge === 'unknown') {
      return tr(russian, 'установлено — работа не проверена', 'installed — runtime unverified');
    }
  }
  const label = FEATURE_STATUS_LABELS[feature.status];
  return russian ? label.russian : label.english;
}

function backupText(report: MaintenanceReport, russian: boolean): string {
  const label = BACKUP_LABELS[report.backup.status];
  const status = russian ? label.russian : label.english;
  const path = report.backup.path.trim();
  if (!path) return `${status} (${tr(russian, 'путь не указан', 'path not specified')})`;
  return `${status} — \`${path}\``;
}

function nextAction(report: MaintenanceReport, russian: boolean): string {
  if (report.state === 'mixed') {
    return tr(
      russian,
      'Обнаружены посторонние или смешанные изменения. Не перезаписывайте файлы: сначала проверьте отчёт и восстановите официальное расширение.',
      'Foreign or mixed changes were found. Do not overwrite files; inspect the report and restore the official extension first.',
    );
  }

  if (report.version !== report.supportedVersion) {
    const version = report.version ?? tr(russian, 'неизвестна', 'unknown');
    return tr(
      russian,
      `Версия Codex ${version} не поддерживается. Нужна адаптация патчей именно для этой версии; установка отключена.`,
      `Codex ${version} is not supported. The patches need adaptation for this exact version; installation is disabled.`,
    );
  }

  if (isPatched(report.state) && report.backup.status !== 'valid') {
    if (report.canInstall && report.backup.status === 'missing') {
      return tr(russian,
        'Выполните в палитре «Codex: Установить / обновить дополнения Companion». Проверенные исходники доступны; полная резервная копия будет создана перед изменениями.',
        'Run “Codex: Install / Update Companion Enhancements” in the Command Palette. Verified originals are available; a complete backup will be created before changes.');
    }
    return tr(
      russian,
      'Патчи установлены, но резервная копия отсутствует или повреждена. Полное восстановление недоступно, пока не предоставлены проверенные оригинальные файлы.',
      'Patches are installed, but no valid backup is available. A full restore is unavailable until verified original files are provided.',
    );
  }

  if (report.state === 'incompatible') {
    return tr(russian,
      'Файлы Codex отсутствуют, изменены или недоступны. Требуется проверка файлов перед повторной установкой дополнений.',
      'Codex files are missing, modified, or inaccessible. Inspect the files before reinstalling enhancements.');
  }

  if (isKnownPredecessor(report.state)) {
    if (report.state === 'drafts' || (report.state === 'workflow' && !report.features.some(feature => feature.id === 'independent-drafts'))) {
      return tr(russian, 'Все дополнения уже установлены.', 'All enhancements are already installed.');
    }
    if (report.canInstall) {
      return tr(
        russian,
        'Выполните в палитре команд «Codex: Установить / обновить дополнения Companion».',
        'Run “Codex: Install / Update Companion Enhancements” in the Command Palette.',
      );
    }
    return tr(
      russian,
      'Автоматическая установка сейчас недоступна. Проверьте подробности ниже.',
      'Automatic installation is currently unavailable. Review the details below.',
    );
  }

  if (report.canInstall) {
    return tr(
      russian,
      'Выполните в палитре команд «Codex: Установить / обновить дополнения Companion».',
      'Run “Codex: Install / Update Companion Enhancements” in the Command Palette.',
    );
  }
  if (report.canRestore) {
    return tr(
      russian,
      'Выполните в палитре команд «Codex: Восстановить исходные файлы Codex».',
      'Run “Codex: Restore Original Codex Files” in the Command Palette.',
    );
  }
  return tr(
    russian,
    'Автоматическое исправление недоступно. Проверьте подробности ниже.',
    'No automatic fix is available. Review the details below.',
  );
}

/**
 * Render a maintenance check in Markdown for the report editor.
 * Disk feature states are reported as byte evidence; only workflow notifications
 * are allowed to claim runtime readiness, and only with a ready bridge.
 */
export function renderMaintenanceReport(
  report: MaintenanceReport,
  russian: boolean,
  runtime?: MaintenanceRuntime,
): string {
  const state = STATE_LABELS[report.state];
  const workflow = report.features.find(feature => feature.id === 'workflow-notifications');
  const workflowReady = workflow?.status === 'installed'
    && runtime?.bridge === 'ready'
    && runtime.runtimeReady === true
    && (report.state === 'workflow' || report.state === 'drafts');
  const verifiedRuntime = { ...runtime, runtimeReady: workflowReady };
  const lines = [
    `# ${tr(russian, 'Обслуживание патчей Codex Companion', 'Codex Companion patch maintenance')}`,
    '',
    `**${tr(russian, 'Версия Codex', 'Codex version')}:** ${report.version ?? tr(russian, 'неизвестна', 'unknown')}`,
    `**${tr(russian, 'Поддерживаемая версия', 'Supported version')}:** ${report.supportedVersion}`,
    `**${tr(russian, 'Состояние', 'State')}:** ${russian ? state.russian : state.english}`,
    `**${tr(russian, 'Резервная копия', 'Backup')}:** ${backupText(report, russian)}`,
    '',
    `## ${tr(russian, 'Компоненты', 'Features')}`,
    '',
    `| ${tr(russian, 'Компонент', 'Feature')} | ${tr(russian, 'Состояние файлов', 'Disk state')} |`,
    '| --- | --- |',
    ...report.features.map(feature =>
      `| ${featureLabel(feature.id, russian)} | ${featureStatusText(feature, verifiedRuntime, russian)} |`,
    ),
    '',
    `> ${workflowReady
      ? tr(
        russian,
        'Файлы всех дополнений проверены. Код уведомлений загружен в этом окне.',
        'All enhancement files are verified. Notification support is loaded in this window.',
      )
      : tr(
        russian,
        'В таблице показан результат проверки файлов. Для уведомлений дополнительно проверяется загрузка кода в текущем окне.',
        'The table shows file verification results. Notifications also require enhancement support to be loaded in this window.',
      )}`,
    '',
    `**${tr(russian, 'Следующее действие', 'Next action')}:** ${['workflow', 'drafts'].includes(report.state) && runtime?.bridge === 'absent'
      ? tr(russian, 'Завершите текущие задачи, затем выполните Developer: Reload Window.',
        'Finish current tasks, then run Developer: Reload Window.')
      : nextAction(report, russian)}`,
  ];

  if (report.canRestore && isPatched(report.state) && report.backup.status === 'valid') {
    lines.push(
      '',
      `**${tr(russian, 'Откат', 'Rollback')}:** ${tr(
        russian,
        'доступен в палитре: «Codex: Восстановить исходные файлы Codex»',
        'available in the Command Palette: “Codex: Restore Original Codex Files”',
      )}.`,
    );
  }

  lines.push('', `## ${tr(russian, 'Подробности', 'Details')}`, '');
  lines.push(`- ${tr(russian, 'Код проверки', 'Check code')}: \`${report.code}\``);
  if (runtime?.bridge) {
    lines.push(`- ${tr(russian, 'Bridge', 'Bridge')}: \`${runtime.bridge}\``);
  }
  lines.push(`- ${tr(russian, 'Файлов проверено', 'Files checked')}: ${report.files.length}`);
  for (const file of report.files) {
    lines.push(`- \`${file.path}\`: ${file.state}`);
  }
  if (report.operation) {
    const changed = report.changed === true
      ? tr(russian, 'файлы изменены', 'files changed')
      : report.changed === false
        ? tr(russian, 'изменений нет', 'no changes')
        : tr(russian, 'результат не указан', 'change state unknown');
    lines.push(`- ${tr(russian, 'Операция', 'Operation')}: \`${report.operation}\`; ${changed}`);
  }

  const issues = [...report.issues, ...report.backup.issues];
  if (issues.length > 0) {
    lines.push(`- ${tr(russian, 'Проблемы', 'Issues')}:`);
    for (const issue of issues) lines.push(`  - ${issue}`);
  }
  if (report.rollbackErrors && report.rollbackErrors.length > 0) {
    lines.push(`- ${tr(russian, 'Ошибки отката', 'Rollback errors')}:`);
    for (const issue of report.rollbackErrors) lines.push(`  - ${issue}`);
  }

  return lines.join('\n');
}

/**
 * Explicit, reversible patch maintenance. The class never writes files itself;
 * every write goes through the injected engine and only after a read-only check.
 */
export class PatchMaintenanceUi {
  private inFlight = false;

  constructor(
    private readonly deps: MaintenanceUiDependencies,
    private readonly russian: boolean,
  ) {}

  async install(): Promise<void> {
    await this.operate('install');
  }

  async restore(): Promise<void> {
    await this.operate('restore');
  }

  /** Read-only check used by the compatibility report. */
  async readReport(): Promise<MaintenanceReport> {
    if (!this.deps.allowed()) {
      throw new Error(this.tr(
        'Обслуживание патчей доступно только в доверенном локальном окне Windows.',
        'Patch maintenance is available only in a trusted local Windows window.',
      ));
    }
    const options = this.deps.options();
    if (!options) {
      throw new Error(this.tr(
        'Не найдено официальное расширение Codex или каталог резервной копии.',
        'The official Codex extension or the backup directory was not found.',
      ));
    }
    return this.deps.engine.check(options);
  }

  /** Read the maintenance report and open it as Markdown. */
  async report(): Promise<MaintenanceReport | undefined> {
    let report: MaintenanceReport;
    try {
      report = await this.readReport();
    } catch (error) {
      await this.showError(this.errorText(error));
      return undefined;
    }
    try {
      await this.deps.openReport(
        this.tr('Обслуживание патчей Codex Companion', 'Codex Companion patch maintenance'),
        renderMaintenanceReport(report, this.russian),
      );
    } catch (error) {
      await this.showError(this.errorText(error));
    }
    return report;
  }

  private async operate(kind: 'install' | 'restore'): Promise<void> {
    if (this.inFlight) {
      await this.showInformation(this.tr(
        'Операция с патчами уже выполняется. Дождитесь её завершения.',
        'A patch operation is already in progress. Wait for it to finish.',
      ));
      return;
    }

    this.inFlight = true;
    try {
      await this.execute(kind);
    } finally {
      this.inFlight = false;
    }
  }

  private async execute(kind: 'install' | 'restore'): Promise<void> {
    if (!this.deps.allowed()) {
      await this.showError(this.tr(
        'Обслуживание патчей доступно только в доверенном локальном окне Windows.',
        'Patch maintenance is available only in a trusted local Windows window.',
      ));
      return;
    }

    const options = this.deps.options();
    if (!options) {
      await this.showError(this.tr(
        'Не найдено официальное расширение Codex или каталог резервной копии.',
        'The official Codex extension or the backup directory was not found.',
      ));
      return;
    }

    let precheck: MaintenanceReport;
    try {
      precheck = await this.deps.engine.check(options);
    } catch (error) {
      await this.showError(this.errorText(error));
      return;
    }

    if (!this.canOperate(kind, precheck)) {
      const details = this.tr('Подробности', 'Details');
      const action = await this.showError(this.refusal(kind, precheck), details);
      if (action === details) {
        await this.openReport(precheck);
      }
      return;
    }

    let result: MaintenanceReport;
    try {
      result = kind === 'install'
        ? await this.deps.engine.install(options)
        : await this.deps.engine.restore(options);
    } catch (error) {
      await this.refreshCompatibility();
      await this.showError(this.errorText(error));
      return;
    }

    await this.refreshCompatibility();
    await this.showInformation(this.resultMessage(kind, result));
  }

  private async refreshCompatibility(): Promise<void> {
    try {
      await this.deps.onChanged();
    } catch (error) {
      await this.showError(this.tr(
        `Не удалось обновить проверку совместимости: ${this.errorText(error)}`,
        `Could not refresh the compatibility check: ${this.errorText(error)}`,
      ));
    }
  }

  private canOperate(kind: 'install' | 'restore', report: MaintenanceReport): boolean {
    if (kind === 'install') {
      return report.canInstall
        && report.state !== 'mixed'
        && report.version === report.supportedVersion;
    }
    return report.canRestore && report.backup.status === 'valid';
  }

  private refusal(kind: 'install' | 'restore', report: MaintenanceReport): string {
    if (kind === 'install') {
      if (report.state === 'mixed') {
        return this.tr(
          'Файлы Codex содержат смешанные или посторонние изменения. Установка отменена, чтобы не перезаписать их.',
          'Codex files contain mixed or foreign changes. Installation was cancelled to avoid overwriting them.',
        );
      }
      if (report.version !== report.supportedVersion) {
        const version = report.version ?? this.tr('неизвестна', 'unknown');
        return this.tr(
          `Версия Codex ${version} не поддерживается. Нужна адаптация патчей именно для этой версии; установка отменена.`,
          `Codex ${version} is not supported. The patches need adaptation for this exact version; installation was cancelled.`,
        );
      }
      return this.tr(
        'Установка недоступна в текущем состоянии файлов. Откройте подробности.',
        'Installation is unavailable in the current file state. Open the details.',
      );
    }

    if (report.backup.status === 'missing') {
      return this.tr(
        'Резервная копия отсутствует. Полное восстановление недоступно, пока не предоставлены проверенные оригинальные файлы.',
        'The backup is missing. A full restore is unavailable until verified original files are provided.',
      );
    }
    if (report.backup.status === 'invalid') {
      return this.tr(
        'Резервная копия повреждена. Восстановление отменено.',
        'The backup is invalid. Restore was cancelled.',
      );
    }
    return this.tr(
      'Восстановление недоступно в текущем состоянии. Откройте подробности.',
      'Restore is unavailable in the current state. Open the details.',
    );
  }

  private resultMessage(kind: 'install' | 'restore', report: MaintenanceReport): string {
    if (report.changed === true) {
      return kind === 'install'
        ? this.tr(
          'Патчи установлены. Перезагрузите окно один раз после завершения текущих задач, чтобы изменения вступили в силу.',
          'Patches installed. Reload the window once after the current tasks finish to activate the changes.',
        )
        : this.tr(
          'Оригинальные файлы восстановлены. Перезагрузите окно один раз после завершения текущих задач, чтобы изменения вступили в силу.',
          'Original files restored. Reload the window once after the current tasks finish to activate the changes.',
        );
    }
    if (report.changed === false) {
      return kind === 'install'
        ? this.tr(
          'Патчи уже установлены; файлы не изменены.',
          'The patches are already installed; no files were changed.',
        )
        : this.tr(
          'Оригинальные файлы уже на месте; изменений нет.',
          'The original files are already in place; nothing was changed.',
        );
    }
    return kind === 'install'
      ? this.tr('Установка завершена.', 'Installation finished.')
      : this.tr('Восстановление завершено.', 'Restore finished.');
  }

  private async openReport(report: MaintenanceReport): Promise<void> {
    try {
      await this.deps.openReport(
        this.tr('Обслуживание патчей Codex Companion', 'Codex Companion patch maintenance'),
        renderMaintenanceReport(report, this.russian),
      );
    } catch (error) {
      await this.showError(this.errorText(error));
    }
  }

  private async showInformation(message: string): Promise<void> {
    // A completed operation must release its lock while the toast remains open.
    void Promise.resolve().then(() => this.deps.showInformation(message))
      .catch(error => this.showError(this.errorText(error)));
  }

  private async showError(message: string, ...actions: string[]): Promise<string | undefined> {
    try {
      return await this.deps.showError(message, ...actions);
    } catch {
      return undefined;
    }
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private tr(russian: string, english: string): string {
    return this.russian ? russian : english;
  }
}
