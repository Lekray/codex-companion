import * as vscode from 'vscode';

export const OFFICIAL_EDITOR = 'chatgpt.conversationEditor';
const CLOSED_KEY = 'companion.officialClosedTabs.v1';
interface ClosedTab { uri: string; label: string; column: number }
export interface OfficialTab { tab: vscode.Tab; uri: vscode.Uri; column: vscode.ViewColumn }

export function officialTabs(): OfficialTab[] {
  return vscode.window.tabGroups.all.flatMap(group => group.tabs.flatMap(tab =>
    tab.input instanceof vscode.TabInputCustom && tab.input.viewType === OFFICIAL_EDITOR
      ? [{ tab, uri: tab.input.uri, column: group.viewColumn }] : []));
}

export async function revealOfficialTab(uri: vscode.Uri, column: vscode.ViewColumn): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', uri, OFFICIAL_EDITOR, { viewColumn: column, preview: false });
}

/** Track editor identities only; never call the conversation or task protocol. */
export class ClosedOfficialTabs implements vscode.Disposable {
  private entries: ClosedTab[];
  private writes = Promise.resolve();
  private readonly subscription: vscode.Disposable;

  constructor(private readonly state: vscode.Memento) {
    const saved: unknown = state.get(CLOSED_KEY, []);
    this.entries = Array.isArray(saved) ? saved.filter((entry): entry is ClosedTab => {
      if (!entry || typeof entry.uri !== 'string' || typeof entry.label !== 'string' || !Number.isInteger(entry.column)) return false;
      try { const uri = vscode.Uri.parse(entry.uri); return uri.scheme === 'openai-codex' && uri.authority === 'route'; }
      catch { return false; }
    }).slice(-5) : [];
    this.subscription = vscode.window.tabGroups.onDidChangeTabs(event => {
      for (const tab of event.closed) {
        if (!(tab.input instanceof vscode.TabInputCustom) || tab.input.viewType !== OFFICIAL_EDITOR) continue;
        const uri = tab.input.uri.toString();
        this.entries = this.entries.filter(entry => entry.uri !== uri);
        this.entries.push({ uri, label: tab.label, column: tab.group.viewColumn });
      }
      this.entries = this.entries.slice(-5);
      if (event.closed.length) this.save();
    });
  }

  private save(): void {
    const snapshot = [...this.entries];
    this.writes = this.writes.then(() => this.state.update(CLOSED_KEY, snapshot)).catch(() => {});
  }

  async reopen(ru: boolean): Promise<void> {
    const entry = this.entries.at(-1);
    if (!entry) {
      void vscode.window.showInformationMessage(ru ? 'Нет недавно закрытых окон Codex.' : 'No recently closed Codex windows.');
      return;
    }
    // Remove only after the official editor opens successfully.
    await revealOfficialTab(vscode.Uri.parse(entry.uri), entry.column as vscode.ViewColumn);
    this.entries = this.entries.filter(item => item !== entry);
    this.save();
  }

  async flush(): Promise<void> { await this.writes; }
  dispose(): void { this.subscription.dispose(); }
}
