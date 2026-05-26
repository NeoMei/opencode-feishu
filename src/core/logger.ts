import { mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import pino, { type Logger } from 'pino';

/**
 * Log destinations:
 * - Always append NDJSON to `~/.config/opencode/feishu.log` (override with FEISHU_LOG_FILE).
 * - When stdout is a TTY and we're not in daemon mode, also pretty-print to stderr so
 *   foreground `opencode-feishu start` still gives a human-readable stream.
 *
 * Level: FEISHU_LOG_LEVEL env (pino levels: fatal/error/warn/info/debug/trace), default info.
 */

const DEFAULT_LOG_PATH = join(homedir(), '.config', 'opencode', 'feishu.log');
const level = process.env.FEISHU_LOG_LEVEL?.toLowerCase() || 'info';
const logFile = process.env.FEISHU_LOG_FILE || DEFAULT_LOG_PATH;

const logDir = dirname(logFile);
if (!existsSync(logDir)) {
  mkdirSync(logDir, { recursive: true });
}

const targets: any[] = [
  { target: 'pino/file', level, options: { destination: logFile, mkdir: true } },
];

// Mirror to stderr with pretty formatting when attached to a terminal — keeps the
// foreground `opencode-feishu start` UX unchanged while adding the file sink.
if (process.stderr.isTTY) {
  targets.push({
    target: 'pino-pretty',
    level,
    options: { destination: 2, colorize: true, singleLine: true, translateTime: 'HH:MM:ss' },
  });
}

const transport = pino.transport({ targets });

export const rootLogger: Logger = pino({ level, base: undefined }, transport);

/**
 * Create a child logger with a module tag. Use this in every src/ module:
 *   const log = createLogger('FeishuAPI');
 *   log.info({ chatId }, 'sending card');
 */
export function createLogger(module: string, bindings: Record<string, unknown> = {}): Logger {
  return rootLogger.child({ module, ...bindings });
}

export type { Logger };
