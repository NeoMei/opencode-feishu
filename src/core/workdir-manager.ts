import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, isAbsolute } from 'path';
import { homedir } from 'os';
import { createLogger } from './logger.js';

const log = createLogger('workdir');

const WORKDIR_FILE = join(homedir(), '.config', 'opencode', 'feishu-workdir');

/**
 * Manage persistent working directory for bash commands.
 * Stores the current workdir in ~/.config/opencode/feishu-workdir
 */
export class WorkdirManager {
  private workdir: string | undefined;

  constructor(initialWorkdir?: string) {
    if (initialWorkdir) {
      this.set(initialWorkdir);
    } else {
      this.workdir = this.load();
    }
  }

  /**
   * Get the current working directory.
   * Returns undefined if no workdir is set.
   */
  get(): string | undefined {
    return this.workdir;
  }

  /**
   * Set a new working directory.
   * Validates that the directory exists and is absolute.
   */
  set(dir: string): void {
    if (!isAbsolute(dir)) {
      throw new Error(`Workdir must be an absolute path, got: ${dir}`);
    }
    
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
        log.info({ dir }, 'Created workdir');
      } catch (err) {
        throw new Error(`Failed to create workdir ${dir}: ${err}`);
      }
    }

    this.workdir = dir;
    this.save(dir);
    log.info({ dir }, 'Workdir set');
  }

  /**
   * Clear the working directory.
   */
  clear(): void {
    this.workdir = undefined;
    try {
      if (existsSync(WORKDIR_FILE)) {
        writeFileSync(WORKDIR_FILE, '', 'utf-8');
      }
    } catch (err) {
      log.warn({ err }, 'Failed to clear workdir file');
    }
    log.info('Workdir cleared');
  }

  /**
   * Resolve workdir for a command.
   * If a specific workdir is provided, use it.
   * Otherwise fall back to the persistent workdir.
   */
  resolve(specificWorkdir?: string): string | undefined {
    if (specificWorkdir) {
      return specificWorkdir;
    }
    return this.workdir;
  }

  private load(): string | undefined {
    try {
      if (existsSync(WORKDIR_FILE)) {
        const dir = readFileSync(WORKDIR_FILE, 'utf-8').trim();
        if (dir && existsSync(dir)) {
          return dir;
        }
      }
    } catch (err) {
      log.warn({ err }, 'Failed to load workdir');
    }
    return undefined;
  }

  private save(dir: string): void {
    try {
      const configDir = dirname(WORKDIR_FILE);
      if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
      }
      writeFileSync(WORKDIR_FILE, dir, 'utf-8');
    } catch (err) {
      log.warn({ err }, 'Failed to save workdir');
    }
  }
}

/** Global workdir manager instance */
let globalWorkdirManager: WorkdirManager | undefined;

/**
 * Initialize the global workdir manager.
 * Should be called once during plugin initialization.
 */
export function initWorkdirManager(initialWorkdir?: string): WorkdirManager {
  globalWorkdirManager = new WorkdirManager(initialWorkdir);
  return globalWorkdirManager;
}

/**
 * Get the global workdir manager instance.
 * Throws if not initialized.
 */
export function getWorkdirManager(): WorkdirManager {
  if (!globalWorkdirManager) {
    throw new Error('WorkdirManager not initialized. Call initWorkdirManager() first.');
  }
  return globalWorkdirManager;
}
