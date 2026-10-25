export const LEGACY_VIEW = 'codexCompanion.chat';
export const LEGACY_DRAFTS = 'companion.legacyDrafts.v1';

export interface StateStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** Back up unsent webview drafts; never rewrite legacy tab/thread metadata. */
export async function preserveLegacyDraft(store: StateStore, state: unknown): Promise<void> {
  if (!state || typeof state !== 'object') return;
  const value = state as Record<string, unknown>;
  if (typeof value.id !== 'string' || typeof value.draft !== 'string' || !value.draft) return;
  const drafts = store.get<Record<string, string>>(LEGACY_DRAFTS, {});
  await store.update(LEGACY_DRAFTS, { ...drafts, [value.id]: value.draft });
}
