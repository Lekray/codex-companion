import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface, type Interface } from 'node:readline';

export interface ServerOptions {
  executable: string;
  args?: string[];
  cwd: string;
  timeoutMs?: number;
  experimentalApi?: boolean;
}

export interface ServerRequest { id: string | number; method: string; params: unknown }

export class AppServerError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = 'AppServerError';
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** One owned stdio process. It does not attach to the IDE's running agents. */
export class AppServerClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private lines: Interface | undefined;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private serverRequests = new Set<string | number>();
  private events = new EventEmitter();
  private state: 'new' | 'starting' | 'ready' | 'closed' = 'new';
  private closePromise: Promise<void> | undefined;

  constructor(private readonly options: ServerOptions) {}

  async start(): Promise<void> {
    if (this.state !== 'new') throw new AppServerError('Client has already been started');
    this.state = 'starting';
    try {
      const child = spawn(this.options.executable, this.options.args ?? ['app-server', '--listen', 'stdio://'], {
        cwd: this.options.cwd,
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      // Drain diagnostics without recording account details, paths or credentials.
      child.stderr.resume();
      child.stdin.on('error', () => this.fail(new AppServerError('App Server input closed')));
      child.on('error', () => this.fail(new AppServerError('Could not launch Codex App Server')));
      child.on('exit', () => this.fail(new AppServerError('Codex App Server exited')));
      this.closePromise = new Promise(resolve => child.once('close', () => resolve()));
      this.lines = createInterface({ input: child.stdout });
      this.lines.on('line', line => this.receive(line));
      await this.sendRequest('initialize', {
        clientInfo: { name: 'codex_companion', title: 'Codex Companion', version: '0.1.0' },
        capabilities: { experimentalApi: this.options.experimentalApi ?? false },
      });
      this.write({ method: 'initialized', params: {} });
      this.state = 'ready';
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    if (this.state !== 'ready') return Promise.reject(new AppServerError('App Server is not ready'));
    return this.sendRequest(method, params) as Promise<T>;
  }

  onNotification(listener: (method: string, params: unknown) => void): () => void {
    this.events.on('notification', listener);
    return () => this.events.off('notification', listener);
  }

  onRequest(listener: (request: ServerRequest) => void): () => void {
    this.events.on('request', listener);
    return () => this.events.off('request', listener);
  }

  onClose(listener: () => void): () => void {
    this.events.on('closed', listener);
    return () => this.events.off('closed', listener);
  }

  respond(id: string | number, result: unknown): void {
    if (!this.serverRequests.delete(id)) throw new AppServerError('Request has already been answered or expired');
    this.write({ id, result });
  }

  rejectRequest(id: string | number): void {
    if (this.serverRequests.delete(id)) this.write({ id, error: { code: -32601, message: 'Unsupported client request' } });
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerError(`App Server request timed out: ${method}`));
      }, this.options.timeoutMs ?? 20_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch {
        this.fail(new AppServerError('Could not write to App Server'));
      }
    });
  }

  private write(message: unknown): void {
    if (!this.child || this.state === 'closed') throw new AppServerError('App Server is closed');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  private receive(line: string): void {
    if (this.state === 'closed') return;
    let message: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      message = value as Record<string, unknown>;
    } catch {
      this.fail(new AppServerError('Invalid JSON message from App Server'));
      this.terminate();
      return;
    }
    if (typeof message.method === 'string') {
      if ('id' in message) {
        if (typeof message.id !== 'string' && typeof message.id !== 'number') return;
        this.serverRequests.add(message.id);
        if (this.events.listenerCount('request') > 0) {
          this.events.emit('request', { id: message.id, method: message.method, params: message.params });
        } else this.rejectRequest(message.id);
      } else {
        this.events.emit('notification', message.method, message.params);
      }
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return; // A late reply to a timed-out request.
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error && typeof message.error === 'object') {
      const code = (message.error as Record<string, unknown>).code;
      // Upstream error messages may contain private account data; expose only the code.
      pending.reject(new AppServerError(`App Server rejected the request (code ${String(code)})`, typeof code === 'number' ? code : undefined));
    } else if ('result' in message) {
      pending.resolve(message.result);
    } else {
      pending.reject(new AppServerError('App Server response has no result'));
    }
  }

  private fail(error: Error): void {
    const wasClosed = this.state === 'closed';
    this.state = 'closed';
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.serverRequests.clear();
    if (!wasClosed) this.events.emit('closed');
  }

  async dispose(): Promise<void> {
    this.fail(new AppServerError('App Server client disposed'));
    this.events.removeAllListeners();
    this.lines?.close();
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    // Bound cleanup; kill only the process owned by this client.
    const timer = setTimeout(() => this.terminate(), 1000);
    let deadline: NodeJS.Timeout | undefined;
    await Promise.race([this.closePromise, new Promise<void>(resolve => { deadline = setTimeout(resolve, 2000); })]);
    clearTimeout(timer);
    clearTimeout(deadline);
  }

  private terminate(): void {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32' && child.pid) {
      execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 2000 }, error => {
        if (error && child.exitCode === null) child.kill();
      });
    } else child.kill();
  }
}
