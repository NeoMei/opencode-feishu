import { spawn } from 'child_process';
import { createLogger } from './logger.js';
import type { HookConfig } from './types.js';

const log = createLogger('HookManager');

export interface HookContext {
  sessionId: string;
  opencodeUrl: string;
  [key: string]: string | undefined;
}

export class HookManager {
  private config: HookConfig;
  private projectDir: string;

  constructor(config: HookConfig, projectDir: string) {
    this.config = config;
    this.projectDir = projectDir;
  }

  async run(hookName: keyof HookConfig, ctx: HookContext): Promise<void> {
    const scriptPath = this.config[hookName];
    if (!scriptPath) return;

    log.info({ hook: hookName, script: scriptPath, sessionId: ctx.sessionId }, 'Running hook');

    try {
      await this.execScript(scriptPath, ctx);
      log.info({ hook: hookName, sessionId: ctx.sessionId }, 'Hook completed');
    } catch (err) {
      log.error({ err, hook: hookName, sessionId: ctx.sessionId }, 'Hook failed');
    }
  }

  private execScript(scriptPath: string, ctx: HookContext): Promise<void> {
    return new Promise((resolve) => {
      const absPath = scriptPath.startsWith('/')
        ? scriptPath
        : `${this.projectDir}/${scriptPath}`;

      const env: Record<string, string | undefined> = {
        ...process.env,
        HOOK_SESSION_ID: ctx.sessionId,
        HOOK_OPENCODE_URL: ctx.opencodeUrl,
      };

      // Pass additional context as HOOK_<KEY> env vars
      for (const [key, value] of Object.entries(ctx)) {
        if (value !== undefined) {
          env[`HOOK_${key.toUpperCase()}`] = value;
        }
      }

      const child = spawn(absPath, [], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000,
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      child.on('close', (code: number | null) => {
        if (code === 0) {
          if (stdout.trim()) log.info({ stdout: stdout.trim() }, 'Hook stdout');
          resolve();
        } else {
          log.warn({ code, stderr: stderr.trim(), stdout: stdout.trim() }, 'Hook exited non-zero');
          resolve(); // Don't reject — hook failures shouldn't break the main flow
        }
      });

      child.on('error', (err: Error) => {
        log.warn({ err }, 'Failed to spawn hook script');
        resolve(); // Don't reject
      });
    });
  }
}
