import { Command } from 'commander';
import { readFileSync, existsSync, unlinkSync, openSync, readSync, closeSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { startStandalone } from './standalone.js';
import { SetupWizard } from './setup/wizard.js';
import { createLogger } from './core/logger.js';
import { ProfileManager } from './core/profile-manager.js';

const log = createLogger('cli');

function getVersion() {
  try {
    const pkgPath = join(dirname(process.argv[1]), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

const PID_FILE = join(homedir(), '.config', 'opencode', 'feishu.pid');

const program = new Command();

program
  .name('opencode-feishu')
  .description('OpenCode Feishu Integration Plugin')
  .version(getVersion());

program
  .command('setup')
  .description('Configure the Feishu plugin')
  .option('-c, --config <path>', 'Configuration file path')
  .action(async (options) => {
    try {
      const wizard = new SetupWizard(options.config);
      await wizard.run();
    } catch (err) {
      log.error({ err }, 'Setup failed');
      process.exit(1);
    }
  });

program
  .command('start')
  .description('Start the Feishu plugin (standalone mode). Use --daemon to run as a background service.')
  .option('-c, --config <path>', 'Configuration file path')
  .option('-u, --url <url>', 'OpenCode server URL')
  .option('-d, --daemon', 'Run as a background daemon (logs → ~/.config/opencode/feishu.log)')
  .option('-s, --serve', 'Auto-start opencode serve if not running')
  .action(async (options) => {
    try {
      const isDaemonChild = process.env.FEISHU_DAEMONIZED === '1';

      // Already-running check: ignore when we ARE the daemon child (parent already wrote PID).
      if (!isDaemonChild && existsSync(PID_FILE)) {
        const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim());
        try {
          process.kill(pid, 0);
          log.error({ pid }, 'Plugin is already running');
          console.error('   Use "opencode-feishu stop" to stop it first');
          process.exit(1);
        } catch {
          unlinkSync(PID_FILE);
        }
      }

      if (options.daemon && !isDaemonChild) {
        // Fork detached and exit this parent. The child re-enters `start` without --daemon.
        const { spawnDaemon } = await import('./core/daemon.js');
        spawnDaemon(process.argv.slice(2));
        process.exit(0);
      }

      // Foreground (or daemon child): claim the PID file with our own pid.
      const { writeFileSync, mkdirSync } = await import('fs');
      const pidDir = join(homedir(), '.config', 'opencode');
      if (!existsSync(pidDir)) mkdirSync(pidDir, { recursive: true });
      writeFileSync(PID_FILE, process.pid.toString());

      await startStandalone({ configPath: options.config, autoServe: options.serve });
    } catch (err) {
      log.error({ err }, 'Failed to start');
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Check plugin status')
  .option('--json', 'Emit JSON instead of human output')
  .action(async (options) => {
    const { readStatus, readPid, isProcessAlive, statusFileAgeMs, HEARTBEAT_STALE_AFTER_MS } =
      await import('./core/daemon.js');

    const pid = readPid();
    const alive = pid != null && isProcessAlive(pid);
    const snap = readStatus();
    const age = statusFileAgeMs();
    const stale = age != null && age > HEARTBEAT_STALE_AFTER_MS;

    const state: 'running' | 'stale' | 'stopped' | 'zombie' =
      !pid ? 'stopped' :
      !alive ? 'zombie' :
      stale ? 'stale' :
      'running';

    if (options.json) {
      process.stdout.write(JSON.stringify({ state, pid, snap, heartbeatAgeMs: age }, null, 2) + '\n');
      process.exit(state === 'running' ? 0 : 1);
    }

    switch (state) {
      case 'stopped':
        console.log('📭 Plugin is not running');
        console.log('   Start it: opencode-feishu start [--daemon]');
        break;
      case 'zombie':
        console.log(`⚠️  PID file points to ${pid}, but that process is not running`);
        console.log('   Clean up: opencode-feishu stop');
        break;
      case 'stale':
        console.log(`⚠️  Plugin PID ${pid} is alive but heartbeat is stale (${Math.round((age || 0) / 1000)}s old)`);
        console.log('   It may be hung; consider restarting');
        break;
      case 'running':
        console.log(`✅ Plugin running`);
        console.log(`   PID:         ${pid}`);
        if (snap) {
          const uptimeSec = Math.floor((Date.now() - snap.startedAt) / 1000);
          console.log(`   Uptime:      ${formatUptime(uptimeSec)}`);
          console.log(`   OpenCode:    ${snap.opencodeUrl}`);
          console.log(`   Feishu WS:   ${snap.feishuConnected ? 'connected' : 'disconnected'}`);
          console.log(`   Sessions:    ${snap.sessionCount}`);
          console.log(`   Heartbeat:   ${Math.round((age || 0) / 1000)}s ago`);
        }
        break;
    }

    process.exit(state === 'running' ? 0 : 1);
  });

function formatUptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s % 60}s`);
  return parts.join(' ');
}

program
  .command('doctor')
  .description('Run preflight checks against the current config')
  .option('-c, --config <path>', 'Configuration file path')
  .option('--json', 'Emit JSON instead of human output')
  .action(async (options) => {
    const { ConfigManager } = await import('./core/config.js');
    const preflight = await import('./setup/preflight.js');
    const mgr = new ConfigManager(options.config);
    const config = mgr.exists() ? mgr.load() : null;
    const results = await preflight.runAll(config, { configPath: mgr.getConfigPath() });

    if (options.json) {
      process.stdout.write(JSON.stringify(results, null, 2) + '\n');
    } else {
      for (const r of results) {
        process.stdout.write(`${r.ok ? '✅' : '❌'} ${r.label}\n`);
        if (r.detail) process.stdout.write(`   ${r.detail}\n`);
        if (!r.ok && r.fix) process.stdout.write(`   🛠  fix: ${r.fix}\n`);
      }
    }

    process.exit(results.every(r => r.ok) ? 0 : 1);
  });

program
  .command('logs')
  .description('Show recent plugin logs')
  .option('-n, --lines <n>', 'Lines to show from the tail', '50')
  .option('-f, --follow', 'Follow the log as it grows')
  .option('--json', 'Emit raw NDJSON')
  .option('--log-file <path>', 'Override log path')
  .action(async (options) => {
    const { readFileSync, watchFile, unwatchFile, statSync } = await import('fs');
    const { join } = await import('path');
    const { homedir } = await import('os');

    const logPath = options.logFile || process.env.FEISHU_LOG_FILE || join(homedir(), '.config', 'opencode', 'feishu.log');

    if (!existsSync(logPath)) {
      process.stderr.write(`Log file not found: ${logPath}. Start the plugin first.\n`);
      process.exit(1);
    }

    const n = parseInt(options.lines, 10) || 50;
    const isTTY = process.stdout.isTTY;

    const LEVEL_COLORS: Record<number, string> = {
      10: '\x1b[90m', 20: '\x1b[90m', 30: '\x1b[32m', 40: '\x1b[33m', 50: '\x1b[31m', 60: '\x1b[31m',
    };
    const LEVEL_NAMES: Record<number, string> = {
      10: 'TRACE', 20: 'DEBUG', 30: 'INFO ', 40: 'WARN ', 50: 'ERROR', 60: 'FATAL',
    };
    const RESET = '\x1b[0m';

    function formatLine(line: string): string {
      if (options.json) return line + '\n';
      let rec: any;
      try { rec = JSON.parse(line); } catch { return line + '\n'; }
      const date = new Date(rec.time);
      const hh = String(date.getHours()).padStart(2, '0');
      const mm = String(date.getMinutes()).padStart(2, '0');
      const ss = String(date.getSeconds()).padStart(2, '0');
      const lvl = rec.level ?? 30;
      const color = isTTY ? (LEVEL_COLORS[lvl] || '') : '';
      const levelName = (LEVEL_NAMES[lvl] || String(lvl)).padEnd(5);
      const mod = rec.module ?? '-';
      const msg = rec.msg ?? '';
      const extraKeys = Object.keys(rec).filter(k => !['level', 'time', 'module', 'msg', 'pid', 'hostname', 'v'].includes(k));
      const extra = extraKeys.map(k => `${k}=${JSON.stringify(rec[k])}`).join(' ');
      return `${color}${hh}:${mm}:${ss} ${levelName} [${mod}] ${msg}${extra ? ' ' + extra : ''}${RESET}\n`;
    }

    function emitTail(path: string, count: number) {
      const data = readFileSync(path, 'utf-8');
      const lines = data.split('\n').filter(l => l.length > 0);
      const tail = lines.slice(-count);
      for (const line of tail) {
        process.stdout.write(formatLine(line));
      }
      return tail.length;
    }

    emitTail(logPath, n);

    if (options.follow) {
      let prevSize = statSync(logPath).size;

      watchFile(logPath, { interval: 500 }, (curr) => {
        if (curr.size > prevSize) {
          const fd = openSync(logPath, 'r');
          const buf = Buffer.alloc(curr.size - prevSize);
          readSync(fd, buf, 0, buf.length, prevSize);
          closeSync(fd);
          const lines = buf.toString('utf-8').split('\n').filter(l => l.length > 0);
          for (const line of lines) {
            process.stdout.write(formatLine(line));
          }
          prevSize = curr.size;
        } else if (curr.size < prevSize) {
          prevSize = curr.size;
        }
      });

      process.on('SIGINT', () => {
        unwatchFile(logPath);
        process.exit(0);
      });

      await new Promise(() => {});
    }
  });

program
  .command('stop')
  .description('Stop the Feishu plugin')
  .action(() => {
    if (!existsSync(PID_FILE)) {
      console.log('📭 Plugin is not running');
      return;
    }

    try {
      const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim());
      process.kill(pid, 'SIGTERM');
      console.log(`🛑 Stopped plugin (PID: ${pid})`);
    } catch (err: any) {
      if (err.code === 'ESRCH') {
        console.log('⚠️  Process not found, cleaning up PID file');
      } else {
        console.error('❌ Failed to stop plugin:', err.message);
      }
    } finally {
      try {
        unlinkSync(PID_FILE);
      } catch {}
    }
  });

// Profile management commands
const profile = program
  .command('profile')
  .description('Manage multiple Feishu configurations');

profile
  .command('list')
  .description('List all profiles')
  .option('--json', 'Emit JSON output')
  .action(async (options) => {
    const mgr = new ProfileManager();
    const profiles = mgr.list();

    if (options.json) {
      process.stdout.write(JSON.stringify(profiles, null, 2) + '\n');
    } else {
      if (profiles.length === 0) {
        console.log('No profiles found. Create one with: opencode-feishu profile add <name>');
        return;
      }
      console.log('Profiles:');
      for (const p of profiles) {
        const active = p.isActive ? ' *' : '  ';
        const status = p.config ? '✓' : '✗';
        console.log(`${active} ${status} ${p.name} (${p.path})`);
      }
    }
  });

profile
  .command('add <name>')
  .description('Add a new profile (copies current config)')
  .action(async (name) => {
    const { ConfigManager } = await import('./core/config.js');
    const mgr = new ProfileManager();
    
    // Try to load current config
    const currentConfigMgr = new ConfigManager();
    let config: any;
    try {
      config = currentConfigMgr.load();
    } catch {
      console.error('❌ No current config found. Run setup first.');
      process.exit(1);
    }

    mgr.save(name, config);
    console.log(`✅ Profile "${name}" created`);
  });

profile
  .command('use <name>')
  .description('Switch to a profile')
  .action(async (name) => {
    const mgr = new ProfileManager();
    
    if (mgr.use(name)) {
      console.log(`✅ Now using profile "${name}"`);
    } else {
      console.error(`❌ Profile "${name}" not found`);
      process.exit(1);
    }
  });

profile
  .command('delete <name>')
  .description('Delete a profile')
  .action(async (name) => {
    const mgr = new ProfileManager();
    
    if (mgr.delete(name)) {
      console.log(`✅ Profile "${name}" deleted`);
    } else {
      console.error(`❌ Profile "${name}" not found`);
      process.exit(1);
    }
  });

profile
  .command('rename <old> <new>')
  .description('Rename a profile')
  .action(async (oldName, newName) => {
    const mgr = new ProfileManager();
    
    if (mgr.rename(oldName, newName)) {
      console.log(`✅ Profile "${oldName}" renamed to "${newName}"`);
    } else {
      console.error(`❌ Failed to rename: "${oldName}" not found or "${newName}" already exists`);
      process.exit(1);
    }
  });

profile
  .command('clone <source> <target>')
  .description('Clone a profile')
  .action(async (source, target) => {
    const mgr = new ProfileManager();
    
    if (mgr.clone(source, target)) {
      console.log(`✅ Profile "${source}" cloned to "${target}"`);
    } else {
      console.error(`❌ Failed to clone: source not found or target already exists`);
      process.exit(1);
    }
  });

profile
  .command('show [name]')
  .description('Show profile configuration')
  .option('--json', 'Emit JSON output')
  .action(async (name, options) => {
    const mgr = new ProfileManager();
    
    const profileName = name || mgr.getActive()?.name;
    if (!profileName) {
      console.error('❌ No profile specified and no active profile');
      process.exit(1);
    }

    const config = mgr.get(profileName);
    if (!config) {
      console.error(`❌ Profile "${profileName}" not found`);
      process.exit(1);
    }

    if (options.json) {
      process.stdout.write(JSON.stringify(config, null, 2) + '\n');
    } else {
      console.log(`Profile: ${profileName}`);
      console.log(`  appId: ${config.appId}`);
      console.log(`  domain: ${config.domain}`);
      console.log(`  opencodeUrl: ${config.opencodeUrl}`);
      console.log(`  streaming: ${config.streaming}`);
      console.log(`  requireMention: ${config.requireMention}`);
      console.log(`  groupPolicy: ${config.groupPolicy}`);
      if (config.allowlist?.length) {
        console.log(`  allowlist: ${config.allowlist.length} entries`);
      }
    }
  });

// Parse command line arguments
program.parse();

// If no command provided, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
