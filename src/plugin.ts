import type { Plugin, PluginInput } from './types/plugin.js';
import { ConfigManager } from './core/config.js';
import { SessionManager } from './core/session-manager.js';
import { MessageHandler } from './core/message-handler.js';
import { FeishuAPI } from './feishu/api.js';
import { FeishuEventSource } from './feishu/event-source.js';
import { OpenCodeClient } from './opencode/client.js';
import { OpenCodeEventHandler } from './opencode/event-handler.js';
import { createLogger } from './core/logger.js';
import { initWorkdirManager, getWorkdir } from './core/workdir-manager.js';

const log = createLogger('plugin');

const FeishuPlugin: Plugin = {
  id: 'feishu',

  server: async (input: PluginInput) => {
    const { client, project, directory } = input;

    log.info('Initializing...');

    try {
      const configManager = new ConfigManager();
      const config = configManager.load();

      log.info({ appId: config.appId, domain: config.domain }, 'Configuration loaded');

      // Initialize workdir manager (persistent working directory for bash commands)
      initWorkdirManager(config.workdir);
      const currentWorkdir = getWorkdir();
      if (currentWorkdir) {
        log.info({ workdir: currentWorkdir }, 'Workdir initialized');
      }

      const feishuApi = new FeishuAPI(config);
      await feishuApi.initialize();

      const opencode = new OpenCodeClient({
        baseUrl: config.opencodeUrl,
        directory: directory || project?.root || process.cwd(),
      });

      const botName = config.botName || 'opencode';

      const sessionManager = new SessionManager(opencode);
      const messageHandler = new MessageHandler(config, sessionManager, feishuApi, opencode, botName);

      let eventHandler: OpenCodeEventHandler | undefined;

      if (config.streaming) {
        eventHandler = new OpenCodeEventHandler(sessionManager, feishuApi, undefined, undefined, config.showProcess, botName, config.thinkingLanguage);

        try {
          const events = client.event?.subscribe
            ? await client.event.subscribe({})
            : await client.global.event({});
          eventHandler.start(events).catch((err: any) => {
            log.error({ err }, 'Event stream error');
          });
        } catch (err) {
          log.warn({ err }, 'Failed to start event stream');
        }
      }

      const feishuEvents = new FeishuEventSource(feishuApi);

      feishuEvents.on('message', async (message: any) => {
        try {
          await messageHandler.handleMessage(message);
        } catch (err) {
          log.error({ err }, 'Message handling failed');
        }
      });

      feishuEvents.on('cardAction', async (action) => {
        try {
          return await messageHandler.handleCardAction(action);
        } catch (err) {
          log.error({ err }, 'Card action handling failed');
          return { toast: { type: 'error', content: '操作处理失败' } };
        }
      });

      await feishuEvents.connect();
      log.info('Connected to Feishu');

      return {
        cleanup: async () => {
          log.info('Cleaning up...');
          if (eventHandler) eventHandler.stop();
          await feishuEvents.disconnect();
          await sessionManager.cleanup();
        },
      };
    } catch (err) {
      log.error({ err }, 'Initialization failed');
      throw err;
    }
  },
};

export default FeishuPlugin;
