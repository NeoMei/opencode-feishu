import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, isAbsolute } from 'path';
import { homedir } from 'os';
import { createLogger } from './logger.js';

const log = createLogger('workdir');
const WORKDIR_FILE = join(homedir(), '.config', 'opencode', 'feishu-workdir');

let workdir: string | undefined;

export function initWorkdirManager(initialWorkdir?: string): void {
  if (initialWorkdir) setWorkdir(initialWorkdir);
  else workdir = loadWorkdir();
}

export function getWorkdir(): string | undefined {
  return workdir;
}

export function setWorkdir(dir: string): void {
  if (!isAbsolute(dir)) throw new Error(`Workdir must be an absolute path, got: ${dir}`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  workdir = dir;
  saveWorkdir(dir);
  log.info({ dir }, 'Workdir set');
}

function loadWorkdir(): string | undefined {
  try {
    if (existsSync(WORKDIR_FILE)) {
      const dir = readFileSync(WORKDIR_FILE, 'utf-8').trim();
      if (dir && existsSync(dir)) return dir;
    }
  } catch (err) { log.warn({ err }, 'Failed to load workdir'); }
  return undefined;
}

function saveWorkdir(dir: string): void {
  try {
    const configDir = dirname(WORKDIR_FILE);
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
    writeFileSync(WORKDIR_FILE, dir, 'utf-8');
  } catch (err) { log.warn({ err }, 'Failed to save workdir'); }
}
