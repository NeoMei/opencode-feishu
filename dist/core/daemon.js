import { spawn } from 'child_process';
import { existsSync, mkdirSync, openSync, writeFileSync, readFileSync, unlinkSync, statSync } from 'fs';
import { dirname, join, sep } from 'path';
import { homedir } from 'os';
import { createLogger } from './logger.js';
const log = createLogger('daemon');
export const PID_FILE = join(homedir(), '.config', 'opencode', 'feishu.pid');
export const STATUS_FILE = join(homedir(), '.config', 'opencode', 'feishu-status.json');
const DEFAULT_LOG_FILE = join(homedir(), '.config', 'opencode', 'feishu.log');
const HEARTBEAT_INTERVAL_MS = 10_000;
/**
 * Fork current process detached, redirect stdout/stderr to the log file,
 * write child PID to PID file, and exit parent.
 *
 * The child inherits FEISHU_DAEMONIZED=1 and is invoked with the original
 * `start` args minus `--daemon`, so it runs a normal foreground start.
 */
export function spawnDaemon(startArgs) {
    const logFile = process.env.FEISHU_LOG_FILE || DEFAULT_LOG_FILE;
    const logDir = dirname(logFile);
    if (!existsSync(logDir))
        mkdirSync(logDir, { recursive: true });
    // Ensure log file exists before opening fd
    if (!existsSync(logFile))
        writeFileSync(logFile, '');
    const logFd = openSync(logFile, 'a');
    // Resolve the script we're running: bin/opencode-feishu → dist/cli.js
    // When invoked via the bin wrapper, argv[1] is the cli.js path already.
    const scriptPath = process.argv[1]
        .replace(/[\\/]core[\\/]daemon\.js$/, `${sep}cli.js`);
    const child = spawn(process.execPath, [scriptPath, 'start', ...startArgs.filter(a => a !== '--daemon' && a !== '-d')], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env, FEISHU_DAEMONIZED: '1' },
    });
    const pidDir = dirname(PID_FILE);
    if (!existsSync(pidDir))
        mkdirSync(pidDir, { recursive: true });
    writeFileSync(PID_FILE, String(child.pid));
    child.unref();
    console.log(`✅ Plugin daemonized (PID: ${child.pid})`);
    console.log(`   Logs: ${logFile}`);
    console.log(`   Status: opencode-feishu status`);
}
/**
 * Start periodic status-file writer. Returns a stop() function for shutdown.
 */
export function startStatusWriter(source) {
    const startedAt = Date.now();
    const write = () => {
        const snap = {
            pid: process.pid,
            startedAt,
            lastHeartbeat: Date.now(),
            sessionCount: source.getSessionCount(),
            feishuConnected: source.isFeishuConnected(),
            opencodeUrl: source.getOpencodeUrl(),
            version: 1,
        };
        try {
            const dir = dirname(STATUS_FILE);
            if (!existsSync(dir))
                mkdirSync(dir, { recursive: true });
            writeFileSync(STATUS_FILE, JSON.stringify(snap, null, 2));
        }
        catch (err) {
            log.warn({ err }, 'Failed to write status file');
        }
    };
    write();
    const timer = setInterval(write, HEARTBEAT_INTERVAL_MS);
    return () => {
        clearInterval(timer);
        try {
            unlinkSync(STATUS_FILE);
        }
        catch { }
    };
}
/**
 * Read the most recent status snapshot. Returns null if the plugin isn't
 * running or the file is missing / corrupt / stale.
 */
export function readStatus() {
    if (!existsSync(STATUS_FILE))
        return null;
    try {
        const raw = readFileSync(STATUS_FILE, 'utf-8');
        const snap = JSON.parse(raw);
        if (snap.version !== 1)
            return null;
        return snap;
    }
    catch {
        return null;
    }
}
export function readPid() {
    if (!existsSync(PID_FILE))
        return null;
    try {
        const raw = readFileSync(PID_FILE, 'utf-8').trim();
        const pid = parseInt(raw, 10);
        return Number.isFinite(pid) ? pid : null;
    }
    catch {
        return null;
    }
}
export function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
export function statusFileAgeMs() {
    if (!existsSync(STATUS_FILE))
        return null;
    try {
        return Date.now() - statSync(STATUS_FILE).mtimeMs;
    }
    catch {
        return null;
    }
}
/**
 * Heartbeat freshness threshold. If the status file is older than this,
 * the daemon is presumed stuck (even if the PID is still alive).
 */
export const HEARTBEAT_STALE_AFTER_MS = HEARTBEAT_INTERVAL_MS * 3;
//# sourceMappingURL=daemon.js.map