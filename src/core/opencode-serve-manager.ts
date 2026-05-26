import { spawn, type ChildProcess } from 'child_process';
import { createLogger } from './logger.js';

const log = createLogger('opencode-serve');

export interface ServeManagerOptions {
  port: number;
  hostname?: string;
  directory: string;
  password?: string;
}

export class OpenCodeServeManager {
  private proc: ChildProcess | null = null;
  private port: number;
  private hostname: string;
  private directory: string;
  private password?: string;
  private exited = false;

  constructor(options: ServeManagerOptions) {
    this.port = options.port;
    this.hostname = options.hostname || '127.0.0.1';
    this.directory = options.directory;
    this.password = options.password;
  }

  /**
   * Start opencode serve as a child process.
   * Resolves when the server is listening (detected via stdout).
   */
  async start(): Promise<string> {
    if (this.proc && !this.exited) {
      log.info('opencode serve already running');
      return this.getUrl();
    }

    const args = ['serve', '--port', String(this.port), '--hostname', this.hostname];
    if (this.password) {
      // opencode serve doesn't have a --password flag, but we can set env var
      // The SDK client uses Authorization header with password
    }

    log.info({ port: this.port, hostname: this.hostname, directory: this.directory }, 'Starting opencode serve...');

    const env = { ...process.env };
    if (this.password) {
      env.OPENCODE_SERVER_PASSWORD = this.password;
    }

    const command = process.platform === 'win32' ? 'opencode.cmd' : 'opencode';
    this.proc = spawn(command, args, {
      cwd: this.directory,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    this.exited = false;

    // Capture stdout to detect when server is ready
    let stdout = '';
    this.proc.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;
      log.debug({ chunk: chunk.trim() }, 'opencode serve stdout');
    });

    this.proc.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      log.debug({ chunk: chunk.trim() }, 'opencode serve stderr');
    });

    this.proc.on('exit', (code) => {
      this.exited = true;
      log.warn({ code }, 'opencode serve exited');
    });

    this.proc.on('error', (err) => {
      log.error({ err }, 'opencode serve process error');
    });

    // Wait for server to be ready by polling the health endpoint
    const url = this.getUrl();
    const maxWaitMs = 30000;
    const pollIntervalMs = 500;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const headers: Record<string, string> = {};
        if (this.password) {
          headers['Authorization'] = `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`;
        }
        const res = await fetch(url, { method: 'GET', headers });
        if (res.ok || res.status === 401 || res.status === 404) {
          // 404 is fine - it means the server is up but the endpoint doesn't exist
          log.info({ url }, 'opencode serve is ready');
          return url;
        }
      } catch {
        // Server not ready yet
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    // If we get here, the server didn't start in time
    this.stop();
    throw new Error(`opencode serve failed to start within ${maxWaitMs}ms`);
  }

  /**
   * Stop the opencode serve process.
   */
  stop(): void {
    if (!this.proc || this.exited) {
      return;
    }

    log.info('Stopping opencode serve...');

    // Try graceful shutdown first
    this.proc.kill('SIGTERM');

    // Force kill after 5 seconds
    const forceKillTimer = setTimeout(() => {
      if (this.proc && !this.exited) {
        log.warn('Force killing opencode serve');
        this.proc.kill('SIGKILL');
      }
    }, 5000);

    this.proc.on('exit', () => {
      clearTimeout(forceKillTimer);
    });

    this.proc = null;
  }

  /**
   * Check if opencode serve is currently running.
   */
  isRunning(): boolean {
    return this.proc !== null && !this.exited;
  }

  private getUrl(): string {
    return `http://${this.hostname}:${this.port}`;
  }
}

/**
 * Check if an OpenCode server is already running at the given URL.
 */
export async function isOpencodeServerRunning(url: string, password?: string): Promise<boolean> {
  try {
    const headers: Record<string, string> = {};
    if (password) {
      headers['Authorization'] = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    }
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(3000), headers });
    return res.ok || res.status === 401 || res.status === 404;
  } catch {
    return false;
  }
}
