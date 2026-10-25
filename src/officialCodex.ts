import { randomUUID } from 'node:crypto';

export const OFFICIAL_EXTENSION = 'openai.chatgpt';
export const OFFICIAL_OPEN_COMMAND = 'chatgpt.newCodexPanel';
export const VERIFIED_EDITOR_VERSION = '26.1007.21434';
export const VERIFIED_EDITOR_VERSION_26_1021 = '26.1021.22027';
export const VERIFIED_EDITOR_VERSIONS: ReadonlySet<string> = new Set([
  VERIFIED_EDITOR_VERSION,
  VERIFIED_EDITOR_VERSION_26_1021,
]);
// The special /extension/panel/new screen repeats the tutorial in this build.
// The regular home route exposes the official composer without that screen.
export const OFFICIAL_NEW_EDITOR_PATH = '/';

export interface OfficialHost {
  extension(id: string): { activate(): PromiseLike<unknown>; version?: string } | undefined;
  commands(): PromiseLike<string[]>;
  execute(command: string): PromiseLike<unknown>;
  openDistinctEditor?(instanceId: string): PromiseLike<unknown>;
}

/** Official UI only. The user-approved URI adapter is gated to the verified version. */
export async function openOfficialCodex(host: OfficialHost, russian: boolean): Promise<'distinct' | 'standard'> {
  const extension = host.extension(OFFICIAL_EXTENSION);
  if (!extension) throw new Error(russian ? 'Установите или включите официальное расширение Codex (OpenAI).' : 'Install or enable the official Codex extension (OpenAI).');
  await extension.activate();
  if (!(await host.commands()).includes(OFFICIAL_OPEN_COMMAND)) {
    throw new Error(russian ? 'В установленном Codex недоступна команда открытия панели. Проверьте версию расширения.' : 'The installed Codex does not expose the panel command. Check its version.');
  }
  if (
    typeof extension.version === 'string' &&
    VERIFIED_EDITOR_VERSIONS.has(extension.version) &&
    host.openDistinctEditor
  ) {
    await host.openDistinctEditor(randomUUID());
    return 'distinct';
  }
  // This command may finish before its editor opens. UI tests wait for the actual tab.
  await host.execute(OFFICIAL_OPEN_COMMAND);
  return 'standard';
}
