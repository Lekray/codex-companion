import { parseQuotas, type QuotaBucket } from './quotas';

export interface QuotaClient {
  start(): Promise<void>;
  request(method: string): Promise<unknown>;
  onNotification(listener: (method: string, params: unknown) => void): () => void;
  onClose(listener: () => void): () => void;
  dispose(): Promise<void>;
}
export interface QuotaState { buckets: QuotaBucket[]; updatedAt: number | null; stale: boolean }

/** Owns only quota reads. Official chat commands never wait for this connection. */
export class QuotaMonitor {
  readonly state: QuotaState = { buckets: [], updatedAt: null, stale: false };
  private client: QuotaClient | undefined;
  private pending: Promise<void> | undefined;
  private disposed = false;
  private accountVersion = 0;
  private reread = false;
  private removers: (() => void)[] = [];
  constructor(private readonly factory: () => QuotaClient, private readonly changed: () => void) {}

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.pending) return this.pending;
    this.reread = false;
    this.pending = this.read().finally(() => {
      this.pending = undefined;
      if (this.reread && !this.disposed) void this.refresh();
    });
    return this.pending;
  }

  private async read(): Promise<void> {
    try {
      if (!this.client) {
        const client = this.factory();
        this.client = client;
        this.removers = [
          client.onClose(() => {
            if (this.client !== client || this.disposed) return;
            this.detach();
            this.state.stale = true;
            this.changed();
            void client.dispose();
          }),
          client.onNotification(method => {
            if (method === 'account/updated') {
              this.accountVersion++;
              this.reread = true;
              this.state.buckets = [];
              this.state.updatedAt = null;
              this.state.stale = true;
              this.changed();
            }
            if (method === 'account/rateLimits/updated' || method === 'account/updated') void this.refresh();
          }),
        ];
        await client.start();
      }
      const client = this.client;
      if (!client || this.disposed) return;
      const accountVersion = this.accountVersion;
      const result = await client.request('account/rateLimits/read');
      if (this.disposed || this.client !== client || accountVersion !== this.accountVersion) return;
      this.state.buckets = parseQuotas(result);
      this.state.updatedAt = Date.now();
      this.state.stale = false;
      this.changed();
    } catch {
      const client = this.client;
      this.detach();
      await client?.dispose();
      if (!this.disposed) { this.state.stale = true; this.changed(); }
    }
  }

  private detach(): void {
    for (const remove of this.removers) remove();
    this.removers = [];
    this.client = undefined;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const client = this.client;
    this.detach();
    await client?.dispose();
  }
}
