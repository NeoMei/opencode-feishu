import { ConfigManager } from './core/config.js';
import { SessionManager } from './core/session-manager.js';
import { MessageHandler } from './core/message-handler.js';
import { HookManager } from './core/hook-manager.js';
import { FeishuAPI } from './feishu/api.js';
import { FeishuEventSource } from './feishu/event-source.js';
import type { FeishuMessage } from './core/types.js';
import { OpenCodeClient } from './opencode/client.js';
import { OpenCodeEventHandler } from './opencode/event-handler.js';
import { createLogger } from './core/logger.js';
import { startStatusWriter } from './core/daemon.js';
import { initWorkdirManager } from './core/workdir-manager.js';
import { OpenCodeServeManager, isOpencodeServerRunning } from './core/opencode-serve-manager.js';

const log = createLogger('standalone');

export interface StartStandaloneOptions {
  configPath?: string;
  autoServe?: boolean;
}

export async function startStandalone(options: StartStandaloneOptions = {}): Promise<void> {
  const { configPath, autoServe = false } = options;
  console.log('🚀 Starting OpenCode Feishu Plugin (Standalone Mode)\n');
  console.log('💡 功能特性：');
  console.log('   • 支持私聊和群聊（需@机器人）');
  console.log('   • 支持文本、图片、文件、语音、视频消息');
  console.log('   • AI 回复实时流式显示');
  console.log('   • 消息去重和用户名显示');
  console.log('   • 飞书文档：创建、读取、编辑、搜索、分享');
  console.log('   • 日历日程：查看、创建、管理日程');
  console.log('   • 任务管理：创建、分配、跟踪任务');
  console.log('   • 审批流程：查询、批准、拒绝审批');
  console.log('   • 多配置管理：支持多个飞书应用配置\n');

  // 1. Load configuration
  const configManager = new ConfigManager(configPath);
  const config = configManager.load();

  // Initialize workdir manager (persistent working directory for bash commands)
  const workdirManager = initWorkdirManager(config.workdir);
  const currentWorkdir = workdirManager.get();
  if (currentWorkdir) {
    console.log(`📁 Workdir: ${currentWorkdir}`);
  }

  // Resolve bot display name from config or fallback
  const botName = config.botName || 'opencode';
  console.log(`🤖 Bot name: ${botName}`);

  console.log('📋 Configuration:');
  console.log(`   App ID: ${config.appId}`);
  console.log(`   Domain: ${config.domain}`);
  console.log(`   OpenCode: ${config.opencodeUrl}`);
  console.log(`   Streaming: ${config.streaming}`);
  console.log(`   Require Mention: ${config.requireMention}`);
  console.log();

  // 2. Ensure OpenCode server is running (auto-start if requested)
  const opencodePort = parseInt(new URL(config.opencodeUrl).port || '19876', 10);
  const opencodeHostname = new URL(config.opencodeUrl).hostname || '127.0.0.1';
  let serveManager: OpenCodeServeManager | undefined;

  const serverRunning = await isOpencodeServerRunning(config.opencodeUrl, process.env.OPENCODE_SERVER_PASSWORD);
  if (serverRunning) {
    console.log('✅ OpenCode server already running\n');
  } else if (autoServe) {
    console.log('🚀 OpenCode server not running, starting it...');
    serveManager = new OpenCodeServeManager({
      port: opencodePort,
      hostname: opencodeHostname,
      directory: process.cwd(),
      password: process.env.OPENCODE_SERVER_PASSWORD,
    });
    try {
      await serveManager.start();
      console.log('✅ OpenCode server started\n');
    } catch (err) {
      log.error({ err }, 'Failed to start OpenCode server');
      console.error('\n❌ Failed to start OpenCode server');
      console.error('   Make sure `opencode` CLI is installed and available in PATH');
      process.exit(1);
    }
  } else {
    console.log('⚠️  OpenCode server not running');
    console.log('   Start it manually: opencode serve --port ' + opencodePort);
    console.log('   Or use --serve to auto-start it\n');
  }

  // 3. Initialize OpenCode client
  console.log('🔌 Connecting to OpenCode...');
  const opencode = new OpenCodeClient({
    baseUrl: config.opencodeUrl,
    directory: process.cwd(),
    password: process.env.OPENCODE_SERVER_PASSWORD,
  });

  // Test OpenCode connection
  try {
    await opencode.listSessions();
    console.log('✅ OpenCode connected\n');
  } catch (err) {
    log.error({ err, opencodeUrl: config.opencodeUrl }, 'Failed to connect to OpenCode');
    const port = new URL(config.opencodeUrl).port || '19876';
    console.error('\n❌ Failed to connect to OpenCode server');
    console.error(`   URL: ${config.opencodeUrl}`);
    console.error('\n💡 Please start OpenCode server first:');
    console.error(`   opencode serve --port ${port}`);
    console.error('\nOr if you are using a different port, update the config:');
    console.error(`   opencode-feishu setup\n`);
    serveManager?.stop();
    process.exit(1);
  }

  // 3. Initialize Feishu API
  console.log('🔌 Connecting to Feishu...');
  const feishuApi = new FeishuAPI(config);
  await feishuApi.initialize();
  console.log('✅ Feishu API initialized\n');

  // 4. Initialize hook manager
  const hookManager = config.hooks
    ? new HookManager(config.hooks, process.cwd())
    : undefined;
  if (hookManager) {
    console.log('🪝 Hooks configured:');
    if (config.hooks?.onSessionCreated) console.log(`   onSessionCreated: ${config.hooks.onSessionCreated}`);
    if (config.hooks?.onSessionIdle) console.log(`   onSessionIdle: ${config.hooks.onSessionIdle}`);
    console.log();
  }

  // 5. Initialize session manager
  const sessionManager = new SessionManager(opencode, {
    hookManager,
    opencodeUrl: config.opencodeUrl,
  });

  // 6. Initialize message handler
  const messageHandler = new MessageHandler(
    config,
    sessionManager,
    feishuApi,
    opencode,
    botName,
  );

  // 7. Start event handler for streaming
  let eventHandler: OpenCodeEventHandler | undefined;

  if (config.streaming) {
    console.log('📡 Starting event stream...');
    eventHandler = new OpenCodeEventHandler(sessionManager, feishuApi, hookManager, config.opencodeUrl, config.showProcess, botName, config.thinkingLanguage, config.autoApprove, opencode);

    try {
      const eventStream = await opencode.subscribeEvents();
      eventHandler.start(eventStream).catch((err) => {
        log.error({ err }, 'Event stream error');
      });
      console.log('✅ Event stream started\n');
    } catch (err) {
      log.warn({ err }, 'Failed to start event stream');
      console.warn('   Streaming output will be disabled\n');
    }
  }

  // 8. Connect Feishu event source
  console.log('📡 Connecting to Feishu event stream...');
  const feishuEvents = new FeishuEventSource(feishuApi);

  feishuEvents.on('message', async (message: FeishuMessage) => {
    await messageHandler.handleMessage(message);
  });

  feishuEvents.on('cardAction', async (action) => {
    try {
      return await messageHandler.handleCardAction(action);
    } catch (err) {
      log.error({ err }, 'Card action handling failed');
      return { toast: { type: 'error', content: '操作处理失败' } };
    }
  });

  feishuEvents.on('error', (err: Error) => {
    log.error({ err }, 'Event stream error');
  });

  try {
    await feishuEvents.connect();
    console.log('✅ Feishu event stream connected\n');
  } catch (err) {
    log.error({ err }, 'Failed to connect to Feishu');
    process.exit(1);
  }

  // 9. Display status
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║     OpenCode Feishu Plugin Running             ║');
  console.log('╠════════════════════════════════════════════════╣');
  console.log(`║  Mode:        Standalone                        ║`);
  console.log(`║  OpenCode:    ${config.opencodeUrl.padEnd(36)} ║`);
  console.log(`║  Directory:   ${process.cwd().substring(0, 36).padEnd(36)} ║`);
  console.log(`║  Streaming:   ${(config.streaming ? 'Enabled' : 'Disabled').padEnd(36)} ║`);
  console.log('╚════════════════════════════════════════════════╝\n');

  console.log('Press Ctrl+C to stop\n');

  // 10. Start periodic status writer
  const stopStatusWriter = startStatusWriter({
    getSessionCount: () => sessionManager.getAllSessions().length,
    isFeishuConnected: () => feishuEvents.isConnected(),
    getOpencodeUrl: () => config.opencodeUrl,
  });

  // 11. Handle shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n🛑 Received ${signal}, shutting down...`);

    stopStatusWriter();

    if (eventHandler) eventHandler.stop();
    await feishuEvents.disconnect();
    await sessionManager.cleanup();

    // Stop opencode serve if we started it
    if (serveManager) {
      serveManager.stop();
    }

    console.log('👋 Goodbye!');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Keep process alive
  setInterval(() => {}, 1000);

  // 12. Health check and auto-restart
  const HEALTH_CHECK_INTERVAL_MS = 30_000;
  const MAX_CONSECUTIVE_FAILURES = 3;
  let consecutiveFailures = 0;

  const healthCheck = async () => {
    try {
      // Check OpenCode server
      const opencodeRunning = await isOpencodeServerRunning(config.opencodeUrl, process.env.OPENCODE_SERVER_PASSWORD);
      if (!opencodeRunning) {
        consecutiveFailures++;
        log.warn({ consecutiveFailures }, 'OpenCode server health check failed');
        
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          log.error('Max consecutive failures reached, restarting opencode serve...');
          try {
            // Kill existing process (excluding current process)
            const { execSync } = await import('child_process');
            const currentPid = process.pid;
            try {
              execSync(`pgrep -f "opencode serve" | grep -v "${currentPid}" | xargs -r kill 2>/dev/null || true`, { 
                stdio: 'ignore' 
              });
            } catch {
              // Ignore errors from pgrep/kill
            }
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Restart opencode serve
            execSync('nohup opencode serve --port 19876 > /tmp/opencode-serve.log 2>&1 &', {
              stdio: 'ignore'
            });
            
            // Wait for it to be ready
            let retries = 10;
            while (retries > 0) {
              await new Promise(resolve => setTimeout(resolve, 2000));
              const isRunning = await isOpencodeServerRunning(config.opencodeUrl, process.env.OPENCODE_SERVER_PASSWORD);
              if (isRunning) {
                log.info('OpenCode server restarted successfully');
                consecutiveFailures = 0;
                break;
              }
              retries--;
            }
            
            if (retries === 0) {
              log.error('Failed to restart OpenCode server after multiple attempts');
            }
          } catch (err) {
            log.error({ err }, 'Failed to restart OpenCode server');
          }
        }
      } else {
        if (consecutiveFailures > 0) {
          log.info('OpenCode server recovered');
        }
        consecutiveFailures = 0;
      }

      // Check Feishu connection
      if (!feishuEvents.isConnected()) {
        log.warn('Feishu connection lost, attempting to reconnect...');
        try {
          await feishuEvents.disconnect();
          await new Promise(resolve => setTimeout(resolve, 2000));
          await feishuEvents.connect();
          log.info('Feishu reconnected successfully');
        } catch (err) {
          log.error({ err }, 'Failed to reconnect to Feishu');
        }
      }
    } catch (err) {
      log.error({ err }, 'Health check error');
    }
  };

  // Run health check periodically
  setInterval(healthCheck, HEALTH_CHECK_INTERVAL_MS);
  log.info({ intervalMs: HEALTH_CHECK_INTERVAL_MS }, 'Health check started');
}
