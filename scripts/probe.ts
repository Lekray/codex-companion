import { AppServerClient } from '../src/appServer';
import { parseQuotas } from '../src/quotas';

async function main(): Promise<void> {
  const client = new AppServerClient({
    executable: process.env.CODEX_COMPANION_CLI ?? 'codex',
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });
  const summary: Record<string, unknown> = { transport: 'owned stdio process', startsTasks: false };
  try {
    await client.start();
    summary.initialized = true;
    console.log('initialize: OK; reading account/rateLimits/read');
    const quotas = parseQuotas(await client.request('account/rateLimits/read'));
    summary.quotas = quotas.map(bucket => ({
      id: bucket.id,
      windows: [bucket.primary, bucket.secondary].filter(value => value !== null),
    }));
    console.log('account/rateLimits/read: OK; reading thread/list');
    // Read only metadata; never print titles, previews, IDs, paths or conversation contents.
    const threads = await client.request('thread/list', { limit: 5, cwd: process.cwd(), useStateDbOnly: true }) as { data?: unknown[] };
    summary.historyPageCount = Array.isArray(threads.data) ? threads.data.length : null;
    console.log('thread/list: OK; reading thread/loaded/list');
    const loaded = await client.request('thread/loaded/list', {}) as { data?: unknown[] };
    summary.loadedInOwnedServer = Array.isArray(loaded.data) ? loaded.data.length : null;
  } finally {
    console.log(JSON.stringify(summary, null, 2));
    await client.dispose();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Integration probe failed');
  process.exitCode = 1;
});
