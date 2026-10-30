export const RENAME_WINDOW_COMMAND = 'codexCompanion.rename';

interface NamedWindow { panelId: string; title: string; active: boolean; uri?: string }
interface WindowSnapshot { instanceId: string; windows: NamedWindow[] }
export interface WindowNamesDependencies {
  allowed(): Promise<boolean>;
  getWindows(): PromiseLike<unknown>;
  pick(items: { label: string; description: string; panelId: string }[]): PromiseLike<{ panelId: string } | undefined>;
  input(value: string): PromiseLike<string | undefined>;
  rename(input: { instanceId: string; panelId: string; title: string }): PromiseLike<unknown>;
  warn(message: string): void;
}

function snapshot(value: unknown): WindowSnapshot | undefined {
  if (!value || typeof value !== 'object') return;
  const data = value as Partial<WindowSnapshot>;
  if (typeof data.instanceId !== 'string' || !data.instanceId || !Array.isArray(data.windows)) return;
  if (!data.windows.every(item => item && typeof item.panelId === 'string' && item.panelId
    && typeof item.title === 'string' && typeof item.active === 'boolean')) return;
  return data as WindowSnapshot;
}

/** Rename the captured panel, even if focus changes while the input is open. */
export class WindowNamesUi {
  private busy = false;
  constructor(private readonly deps: WindowNamesDependencies, private readonly ru: boolean) {}

  async rename(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const changed = this.ru ? 'Окно уже закрыто или Codex перезапущен. Повторите переименование.'
      : 'The window was closed or Codex restarted. Try renaming again.';
    try {
      if (!await this.deps.allowed()) {
        this.deps.warn(this.ru ? 'Переименование требует совместимого Codex в доверенном локальном проекте.'
          : 'Renaming requires compatible Codex in a trusted local workspace.');
        return;
      }
      const state = snapshot(await this.deps.getWindows());
      if (!state) throw new Error(this.ru ? 'Переименование недоступно. После завершения задач перезагрузите окно VS Code.'
        : 'Renaming is unavailable. Reload VS Code after your tasks finish.');
      if (!state.windows.length) {
        this.deps.warn(this.ru ? 'Нет открытых окон Codex.' : 'There are no open Codex windows.');
        return;
      }
      let selected = state.windows.find(item => item.active);
      if (!selected && state.windows.length === 1) selected = state.windows[0];
      if (!selected) {
        const choice = await this.deps.pick(state.windows.map((item, index) => ({
          label: item.title, description: String(index + 1), panelId: item.panelId,
        })));
        if (!choice) return;
        selected = state.windows.find(item => item.panelId === choice.panelId);
      }
      if (!selected) return;
      const title = (await this.deps.input(selected.title))?.trim();
      if (!title) return;
      // Recheck trust/compatibility and identity after the asynchronous UI.
      if (!await this.deps.allowed()) return;
      const current = snapshot(await this.deps.getWindows());
      if (!current || current.instanceId !== state.instanceId
        || !current.windows.some(item => item.panelId === selected.panelId)) {
        this.deps.warn(changed); return;
      }
      if (await this.deps.rename({ instanceId: state.instanceId, panelId: selected.panelId, title }) !== true) {
        this.deps.warn(this.ru ? 'Не удалось сохранить имя окна. Повторите переименование.'
          : 'Could not save the window name. Try renaming again.');
      }
    } catch (error) {
      this.deps.warn(error instanceof Error ? error.message : String(error));
    } finally { this.busy = false; }
  }
}
