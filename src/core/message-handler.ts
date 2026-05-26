import type { FeishuConfig, FeishuMessage, FeishuCardAction, CardContent } from '../core/types.js';
import type { SessionManager } from '../core/session-manager.js';
import type { FeishuAPI } from '../feishu/api.js';
import type { OpenCodeClient } from '../opencode/client.js';
import { FeishuCard } from '../feishu/card.js';
import { MessageDeduplicator } from './dedup.js';
import { FileDownloader } from './file-downloader.js';
import { createLogger } from './logger.js';
import { getWorkdirManager } from './workdir-manager.js';

const log = createLogger('MessageHandler');

export class MessageHandler {
  private config: FeishuConfig;
  private sessionManager: SessionManager;
  private feishuApi: FeishuAPI;
  private opencode: OpenCodeClient;
  private dedup: MessageDeduplicator;
  private fileDownloader: FileDownloader;
  private botName: string;
  private availableCommands: Map<string, { type: 'tui' | 'session' | 'custom', description?: string }> = new Map();
  private chatModelOverrides: Map<string, { providerID: string; modelID: string }> = new Map();
  private lastKnownModel?: string;

  constructor(
    config: FeishuConfig,
    sessionManager: SessionManager,
    feishuApi: FeishuAPI,
    opencode: OpenCodeClient,
    botName = 'opencode',
  ) {
    this.config = config;
    this.sessionManager = sessionManager;
    this.feishuApi = feishuApi;
    this.opencode = opencode;
    this.botName = botName;
    this.dedup = new MessageDeduplicator(config.dedupTtl || 600_000);
    this.fileDownloader = new FileDownloader();
    
    // Load available commands on startup
    this.loadAvailableCommands();
  }

  private async loadAvailableCommands(): Promise<void> {
    try {
      log.info('Loading available commands from OpenCode');
      const commands = await this.opencode.getCommands();
      
      if (commands && Array.isArray(commands)) {
        for (const cmd of commands) {
          if (cmd.name) {
            this.availableCommands.set(cmd.name, {
              type: cmd.source === 'mcp' ? 'custom' : 'session',
              description: cmd.description
            });
            log.info({ name: cmd.name, source: cmd.source, description: cmd.description }, 'Loaded command');
          }
        }
        log.info({ count: this.availableCommands.size }, 'Loaded available commands');
      } else {
        log.warn({ commands }, 'No commands loaded from OpenCode');
      }
      
      // Also add known TUI commands
      const tuiCommands = [
        'session.list', 'session.new', 'session.share', 'session.interrupt', 'session.compact',
        'session.page.up', 'session.page.down', 'session.line.up', 'session.line.down',
        'session.half.page.up', 'session.half.page.down', 'session.first', 'session.last',
        'prompt.clear', 'prompt.submit', 'agent.cycle'
      ];
      
      for (const cmd of tuiCommands) {
        if (!this.availableCommands.has(cmd)) {
          this.availableCommands.set(cmd, { type: 'tui' });
        }
      }
      
    } catch (err) {
      log.error({ err }, 'Failed to load available commands');
    }
  }

  private async syncModelOverride(chatId: string): Promise<void> {
    try {
      const fs = await import('fs');
      const path = await import('path');
      const configPath = path.join(this.opencode.getDirectory(), '.opencode', 'config.json');
      if (!fs.existsSync(configPath)) return;
      
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const currentModel = config?.model as string | undefined;
      if (!currentModel) return;

      if (this.lastKnownModel !== currentModel) {
        const [providerID, modelID] = currentModel.split('/');
        if (providerID && modelID) {
          this.chatModelOverrides.set(chatId, { providerID, modelID });
          log.info({ chatId, model: currentModel }, 'Model changed, override set');
        }
        this.lastKnownModel = currentModel;
      }
    } catch (err) {
      log.warn({ err }, 'Failed to sync model override');
    }
  }

  async handleMessage(message: FeishuMessage): Promise<void> {
    try {
      log.info({
        chat_id: message.chat_id,
        chat_type: message.chat_type,
        sender_type: message.sender?.sender_type,
        content: message.content?.substring(0, 100)
      }, 'Received message');

      // 处理 lark-cli 返回的消息格式
      if (!message.sender) {
        log.warn('Message missing sender info, skipping');
        return;
      }

      // Skip messages from the bot itself
      if (message.sender.sender_type === 'app') {
        log.info('Skipping message from app/bot itself');
        return;
      }

      // Deduplicate: skip if we've seen this message before
      if (this.dedup.isDuplicate(message.message_id)) {
        log.info({ messageId: message.message_id }, 'Duplicate message, skipping');
        return;
      }

      const chatId = message.chat_id;
      const chatType = message.chat_type;

      log.info({ chatType, sender: message.sender.sender_id?.union_id || 'unknown' }, 'Processing message');

      // Check mention requirement for groups
      if (chatType === 'group' && this.config.requireMention) {
        log.info({ mentions: message.mentions }, 'Checking mentions');
        // 飞书 mention.id 里是机器人的 user 维度 id（open_id/union_id），
        // 不是应用维度的 app_id (cli_*)。用从 /bot/v3/info 拉到的 open_id 比较。
        const botOpenId = this.feishuApi.getBotOpenId();
        const isMentioned = message.mentions?.some(
          m => !!botOpenId && m.id?.open_id === botOpenId
        );

        if (!isMentioned) {
          log.info({ chatId }, 'Ignoring message without mention in group');
          return;
        }
        log.info('Bot was mentioned');
      }

      // Check group policy
      if (chatType === 'group' && this.config.groupPolicy === 'disabled') {
        log.info('Group messages disabled');
        return;
      }

      // Check allowlist
      if (this.config.allowlist && this.config.allowlist.length > 0) {
        const senderId = message.sender.sender_id?.union_id;
        if (!senderId || !this.config.allowlist.includes(senderId)) {
          log.info({ senderId }, 'Sender not in allowlist');
          return;
        }
      }

      // Get or create session
      log.info({ chatId }, 'Getting or creating session');
      const session = await this.sessionManager.getOrCreateSession(chatId, chatType);
      log.info({ sessionId: session.id, status: session.status }, 'Session ready');

      // Check if session is busy (atomic check-and-set).
      // Allow messages through when there's a pending interaction — the user
      // might be replying to a question or permission request via text.
      if (session.status === 'busy' && !session.pendingInteraction) {
        log.info('Session is busy, sending busy message');
        await this.feishuApi.sendText(
          chatId,
          '⏳ 正在处理上一条消息，请稍候...'
        );
        return;
      }

      // Clear previous turn's card reference so a new card is created for this turn.
      // (EventHandler no longer clears this on session.idle to avoid race conditions.)
      this.sessionManager.clearCurrentMessage(chatId);

      // Resolve sender name (with cache)
      const senderUnionId = message.sender.sender_id?.union_id || 'unknown';
      const senderName = await this.feishuApi.getUserName(senderUnionId);
      log.info({ senderName, senderId: senderUnionId }, 'Resolved sender name');

      // Extract content and download files based on message type
      let text = '';
      const files: Array<{ filePath: string; fileName: string; mimeType: string }> = [];

      try {
        const content = JSON.parse(message.content);
        switch (message.message_type) {
          case 'text':
            text = content.text || '';
            break;
          case 'image': {
            const result = await this.downloadMedia(
              message.message_id,
              content.image_key,
              'image',
              'image.jpg',
              'image/jpeg',
              '图片'
            );
            text = result.text;
            if (result.file) files.push(result.file);
            break;
          }
          case 'file': {
            const result = await this.downloadMedia(
              message.message_id,
              content.file_key,
              'file',
              content.file_name || 'unknown',
              'application/octet-stream',
              '文件'
            );
            text = result.text;
            if (result.file) files.push(result.file);
            break;
          }
          case 'audio': {
            const result = await this.downloadMedia(
              message.message_id,
              content.file_key,
              'file',
              'audio.opus',
              'audio/opus',
              '语音'
            );
            text = result.text;
            if (result.file) files.push(result.file);
            break;
          }
          case 'media': {
            const result = await this.downloadMedia(
              message.message_id,
              content.file_key,
              'file',
              content.file_name || 'video.mp4',
              'video/mp4',
              '视频'
            );
            text = result.text;
            if (result.file) files.push(result.file);
            break;
          }
          case 'sticker':
            text = `[表情消息]`;
            break;
          default:
            text = `[不支持的消息类型: ${message.message_type}]`;
        }
        log.info({ text: text.substring(0, 100), type: message.message_type, files: files.length }, 'Extracted content');
      } catch {
        log.warn({ content: message.content, type: message.message_type }, 'Failed to parse message content');
        text = `[不支持的消息类型: ${message.message_type}]`;
      }

      // Remove @mention from text if present
      if (message.mentions) {
        for (const mention of message.mentions) {
          text = text.replace(mention.key, '').trim();
        }
        log.info({ text: text.substring(0, 100) }, 'Text after removing mentions');
      }

      // Prepend sender name in group chats for context
      if (chatType === 'group' && senderName && senderName !== senderUnionId) {
        text = `[${senderName}]: ${text}`;
      }

      if (!text) {
        log.info('Empty text content, ignoring');
        return;
      }

      log.info({ chatType, chatId, text: text.substring(0, 100) }, 'Message content');

      // Handle admin restart commands - only exact slash commands
      const trimmedText = text.trim().toLowerCase();
      if (trimmedText === '/restart' || trimmedText === '/重启') {
        await this.handleRestartCommand(chatId);
        return;
      }

      // Check for pending interaction reply before proceeding with normal message flow
      const pendingInteraction = this.sessionManager.getPendingInteraction?.(chatId);
      if (pendingInteraction) {
        try {
          const handled = await this.handleInteractionReply(
            chatId, text.trim(), pendingInteraction,
          );
          if (handled) return;
          // The user's message does not match an interaction reply pattern.
          // Do NOT clear the pending interaction — the user may still click the
          // card buttons. Instead, tell them to finish the interaction first.
        } catch {
          // Error handling interaction reply: clear to prevent the user from
          // getting permanently stuck.
          this.sessionManager.clearPendingInteraction(chatId);
        }

        await this.feishuApi.sendText(
          chatId,
          pendingInteraction.kind === 'permission'
            ? '⏳ 请先处理上方的权限请求（点击卡片按钮），或等待当前任务完成。'
            : '⏳ 请先处理上方的选择（点击卡片按钮或回复选项），或等待当前任务完成。'
        );
        return;
      }

      // Atomically check and set busy status to prevent race conditions
      const currentSession = this.sessionManager.getSession(chatId);
      if (!currentSession || currentSession.status === 'busy') {
        log.info('Session became busy during processing, skipping');
        return;
      }
      this.sessionManager.updateStatus(chatId, 'busy');

      // Skip separate thinking card — the streaming card (created on first flushCard)
      // already shows "💭 点点思考中..." as its header with no blank body.

      // Send message to OpenCode
      try {
        const slashCommand = this.parseSlashCommand(text);
        
        // Note: restart commands are handled above before slash command parsing
        // to ensure only exact /restart or /重启 triggers restart
        
        if (slashCommand) {
          // Map common shortcuts to TUI commands
          const commandMappings: Record<string, string> = {
            'new': 'session.new',
            'share': 'session.share',
            'interrupt': 'session.interrupt',
            'compact': 'session.compact',
            'pageup': 'session.page.up',
            'pagedown': 'session.page.down',
            'lineup': 'session.line.up',
            'linedown': 'session.line.down',
            'halfpageup': 'session.half.page.up',
            'halfpagedown': 'session.half.page.down',
            'first': 'session.first',
            'last': 'session.last',
            'clear': 'prompt.clear',
            'submit': 'prompt.submit',
            'nextagent': 'agent.cycle',
          };
          
          // Apply mapping if exists
          const mappedCommand = commandMappings[slashCommand.command] || slashCommand.command;
          if (mappedCommand !== slashCommand.command) {
            log.info({ original: slashCommand.command, mapped: mappedCommand }, 'Mapped command');
          }
          
          // Check if command needs special handling (list queries)
          const listCommands = ['models', 'agents', 'commands', 'sessions', 'tools', 'worktrees', 'files', 'status', 'config'];
          if (listCommands.includes(slashCommand.command)) {
            // Handle list commands by fetching data from OpenCode
            await this.handleListCommand(chatId, session.id, slashCommand.command, slashCommand.args);
          } else {
            // Check command type from cached commands
            const commandInfo = this.availableCommands.get(mappedCommand);
            
            if (commandInfo?.type === 'tui') {
              // TUI commands are executed via tui.executeCommand
              log.info({ sessionId: session.id, command: mappedCommand }, 'Executing TUI command');
              await this.opencode.executeTuiCommand(mappedCommand);
              log.info('TUI command executed successfully');
              // Send confirmation and set session to idle
              await this.feishuApi.sendText(chatId, `✅ 已执行命令: /${slashCommand.command}`);
              this.sessionManager.updateStatus(chatId, 'idle');
              this.sessionManager.clearCurrentMessage(chatId);
            } else {
              // All other commands (session commands and custom commands)
              // are sent as session commands
              log.info({ sessionId: session.id, command: slashCommand.command, args: slashCommand.args, type: commandInfo?.type || 'unknown' }, 'Sending command to OpenCode');
              await this.opencode.sendCommand(session.id, slashCommand.command, slashCommand.args);
              log.info('Command sent successfully');
            }
          }
        } else {
          log.info({ sessionId: session.id, files: files.length }, 'Sending prompt to OpenCode');
          // Inject chat context so the AI knows the current chat_id for Feishu operations
          const workdirManager = getWorkdirManager();
          const currentWorkdir = workdirManager.get();
          const workdirInfo = currentWorkdir ? `当前工作目录: ${currentWorkdir}\n` : '';
          const contextPrefix = `[系统上下文] 当前飞书对话ID: ${chatId}\n\n` +
            workdirInfo +
            `你配置了飞书 MCP 工具，可以使用以下工具来操作飞书文档、日历等：\n` +
            `- docx.v1.document.create — 创建飞书文档\n` +
            `- docx.v1.documentBlockChildren.create — 在文档中插入内容\n` +
            `- docx.v1.documentBlock.patch — 更新文档块\n` +
            `- drive.v1.file.createFolder — 创建文件夹\n` +
            `- drive.v1.media.uploadPrepare/uploadFinish — 上传文件\n` +
            `当用户请求创建飞书文档时，请直接调用 MCP 工具创建，不要在回复中询问。\n` +
            `重要：飞书文档的访问链接必须使用 https://www.feishu.cn/docx/ 域名，不要使用 https://open.feishu.cn/docx/ 域名。\n\n`;
          await this.syncModelOverride(chatId);
          const modelOverride = this.chatModelOverrides.get(chatId);
          if (modelOverride) {
            session.currentModel = `${modelOverride.providerID}/${modelOverride.modelID}`;
            log.info({ chatId, model: session.currentModel }, 'Sent prompt with model override');
          }
          await this.opencode.sendPrompt(session.id, contextPrefix + text, files.length > 0 ? files : undefined, this.config.thinkingLanguage, modelOverride);
          log.info('Prompt sent successfully');
        }
      } catch (err) {
        log.error({ err }, 'Failed to send prompt');

        // Extract meaningful error message from various error formats
        let errorMessage: string;
        if (err instanceof Error) {
          errorMessage = err.message;
        } else if (typeof err === 'object' && err !== null) {
          const errObj = err as any;
          if (errObj.data?.message) {
            errorMessage = errObj.data.message;
          } else if (errObj.message) {
            errorMessage = errObj.message;
          } else {
            try {
              errorMessage = JSON.stringify(err);
            } catch {
              errorMessage = String(err);
            }
          }
        } else {
          errorMessage = String(err);
        }

        log.info({ errorMessage, errType: typeof err }, 'Creating error card with message');
        const errorCard = FeishuCard.createErrorCard(errorMessage);
        log.info({ cardContent: errorCard.elements[0]?.text?.content }, 'Error card content');
        
        // Set status to idle BEFORE sending the error card to prevent
        // EventHandler from sending a duplicate error card via session.error event.
        this.sessionManager.updateStatus(chatId, 'idle');
        this.sessionManager.clearCurrentMessage(chatId);
        
        // Mark error as handled to prevent duplicate error cards
        const session = this.sessionManager.getSession(chatId);
        if (session) {
          session.errorHandled = true;
        }
        
        await this.feishuApi.sendCard(
          chatId,
          errorCard
        );
      }

    } catch (err) {
      log.error({ err }, 'Error handling message');

      try {
        await this.feishuApi.sendText(
          message.chat_id,
          '❌ 处理消息时出错，请稍后重试'
        );
      } catch (sendErr) {
        log.error({ err: sendErr }, 'Failed to send error message');
      }
    }
  }


  /**
   * Try to parse the user message as a reply to a pending interaction.
   * Returns true if handled.
   */
  private async handleInteractionReply(
    chatId: string,
    text: string,
    interaction: import('./types.js').PendingInteraction,
  ): Promise<boolean> {
    try {
      if (interaction.kind === 'permission') {
        const perm = interaction.data;
        let reply: 'once' | 'always' | 'reject' | undefined;

        if (text === '确认' || text === '同意' || text === '允许' || text === 'yes' || text === 'y') {
          reply = 'once';
        } else if (text === '始终' || text === '总是' || text === 'always') {
          reply = 'always';
        } else if (text === '拒绝' || text === '否' || text === '不同意' || text === 'no' || text === 'n') {
          reply = 'reject';
        }

        if (!reply) return false;

        log.info({ chatId, permissionId: perm.id, reply }, 'Replying to permission');
        await this.opencode.replyPermission(perm.id, reply);
        this.sessionManager.clearPendingInteraction(chatId);

        await this.feishuApi.sendCard(
          chatId,
          FeishuCard.createInteractionRepliedCard('permission', reply),
        );
        return true;
      }

      if (interaction.kind === 'question') {
        const q = interaction.data;
        // Parse answers: comma or space separated indices/labels
        const selections = text.split(/[,，\s]+/).filter(s => s.length > 0);
        if (selections.length === 0) return false;

        const answers: string[][] = [];
        for (const [qIdx, question] of q.questions.entries()) {
          const answer: string[] = [];
          for (const sel of selections) {
            // Try numeric index first
            const idx = parseInt(sel, 10);
            if (!isNaN(idx) && idx >= 1 && idx <= question.options.length) {
              answer.push(question.options[idx - 1].label);
            } else {
              // Try matching label
              const match = question.options.find(o =>
                o.label === sel || o.label.toLowerCase() === sel.toLowerCase(),
              );
              if (match) answer.push(match.label);
            }
          }
          // Deduplicate
          const unique = [...new Set(answer)];
          if (unique.length > 0) {
            answers.push(unique);
          } else if (qIdx < q.questions.length - 1) {
            // This question has no valid answer but there are more questions
            answers.push([]);
          }
        }

        if (answers.length === 0 || answers.every(a => a.length === 0)) {
          // Not a valid question reply, let normal processing handle it
          return false;
        }

        log.info({ chatId, requestId: q.id, answers }, 'Replying to question');
        await this.opencode.replyQuestion(q.id, answers);
        this.sessionManager.clearPendingInteraction(chatId);

        const label = answers.map(a => a.join(', ')).join('; ');
        await this.feishuApi.sendCard(chatId, FeishuCard.createInteractionRepliedCard('question', label));
        return true;
      }

      return false;
    } catch (err) {
      log.error({ err, chatId, interactionKind: interaction.kind }, 'Failed to handle interaction reply');
      // Don't return true on error — let the message fall through so user isn't stuck
      return false;
    }
  }

  /**
   * Handle a card button click (card.action.trigger event).
   * Parses the button value and routes to the appropriate OpenCode API.
   * Returns a card callback response for Feishu (toast / updated card).
   */
  async handleCardAction(action: FeishuCardAction): Promise<{ toast?: { type: string; content: string }; card?: CardContent } | undefined> {
    const { chatId, messageId } = action;
    const value = action.action.value;

    if (!value || typeof value !== 'object') {
      log.warn({ chatId, messageId, value }, 'Card action missing value');
      return { toast: { type: 'error', content: '无效操作' } };
    }

    const actionType = value.action || value._oc;
    log.info({ chatId, messageId, actionType, value }, 'Card action received');
    
    // Handle navigation commands (TUI operations)
    if (actionType === 'nav') {
      return this.handleNavigationCardAction(chatId, messageId, value);
    }

    // Handle model selection
    if (actionType === 'model') {
      return this.handleModelCardAction(chatId, messageId, value, action.action.option);
    }

    // Handle agent selection
    if (actionType === 'agent') {
      return this.handleAgentCardAction(chatId, messageId, value, action.action.option);
    }

    // Handle session operations (switch/share/delete)
    if (actionType === 'sess') {
      return this.handleSessionCardAction(chatId, messageId, value);
    }

    // Handle status refresh
    if (actionType === 'status') {
      return this.handleStatusCardAction(chatId, messageId, value);
    }

    // Handle task control (interrupt/abort)
    if (actionType === 'ctrl') {
      return this.handleCtrlCardAction(chatId, messageId, value);
    }

    // Handle command execution
    if (actionType === 'cmd') {
      return this.handleCommandCardAction(chatId, messageId, value);
    }

    if (actionType !== 'perm' && actionType !== 'q') {
      log.warn({ chatId, actionType, value }, 'Unknown card action type');
      return { toast: { type: 'error', content: '不支持的操作' } };
    }

    // Verify there is a pending interaction for this chat
    const pending = this.sessionManager.getPendingInteraction(chatId);
    const session = this.sessionManager.getSession(chatId);
    log.info({ chatId, messageId, hasPending: !!pending, pendingKind: pending?.kind, currentMessageId: session?.currentMessageId }, 'Checking pending interaction');
    if (!pending) {
      log.info({ chatId, messageId, currentMessageId: session?.currentMessageId }, 'No pending interaction for this chat, ignoring card action');
      const valueId = (value.id || '').toString();
      // If the button looks like an AI-generated permission card (not from OpenCode's permission.asked event),
      // simulate a text reply so the AI can continue processing.
      const isAiGeneratedPerm = actionType === 'perm' && valueId.startsWith('perm-');
      if (isAiGeneratedPerm) {
        const replyMap: Record<string, string> = {
          once: '确认',
          always: '始终允许',
          reject: '拒绝',
        };
        const replyText = replyMap[value.reply as string] || '确认';
        const confirmMap: Record<string, string> = {
          once: '已授权一次',
          always: '已永久授权',
          reject: '已拒绝',
        };
        const confirmText = confirmMap[value.reply as string] || '已授权';

        try {
          // Wait for card update to complete before sending prompt,
          // so the user sees the confirmation state immediately.
          await this.feishuApi.updateCard(messageId, FeishuCard.createInteractionRepliedCard('permission', value.reply as string));
          log.info({ chatId, messageId }, 'Updated AI-generated perm card to confirmed state');
        } catch (err) {
          log.warn({ err, chatId, messageId }, 'Failed to update AI-generated perm card');
        }

        // Re-bind currentMessageId to the clicked card so subsequent
        // flushCard calls update the same card instead of creating a new one.
        if (session) {
          this.sessionManager.setCurrentMessage(chatId, messageId);
          log.info({ chatId, messageId }, 'Re-bound currentMessageId to clicked card');
        }

        // Simulate user text reply to OpenCode so the AI continues
        if (session) {
          try {
            await this.opencode.sendPrompt(session.id, replyText);
            log.info({ chatId, replyText }, 'Simulated permission reply sent to OpenCode');
          } catch (err) {
            log.error({ err, chatId, replyText }, 'Failed to send simulated permission reply');
          }
        }

        return { toast: { type: 'success', content: confirmText } };
      }

      // Real OpenCode permission IDs are `per_*`. If we see one with no pending,
      // it's almost always a duplicate event (Feishu re-delivery or quick re-click)
      // for a request we already handled. The card is already in confirmation state
      // from the first click — return success silently rather than misleading
      // "已过期" warning.
      const isRealOpencodePerm = actionType === 'perm' && valueId.startsWith('per_');
      if (isRealOpencodePerm) {
        log.info({ chatId, messageId, valueId }, 'Permission already processed (likely duplicate event), returning success');
        return { toast: { type: 'success', content: '已处理' } };
      }
      // Update the card to remove stale buttons so the user doesn't keep clicking
      this.feishuApi.updateCard(messageId, FeishuCard.createExpiredCard())
        .then(() => log.info({ chatId, messageId }, 'Updated stale card to expired state'))
        .catch((err: any) => log.warn({ err, chatId, messageId }, 'Failed to update stale card to expired'));
      return { toast: { type: 'warning', content: '该操作已过期' } };
    }

    // Route to the appropriate handler
    if (actionType === 'perm') {
      return this.handlePermissionCardAction(chatId, messageId, value, pending);
    }

    return this.handleQuestionCardAction(chatId, messageId, value, pending);
  }

  private async handlePermissionCardAction(
    chatId: string,
    messageId: string,
    value: Record<string, unknown>,
    pending: import('./types.js').PendingInteraction,
  ): Promise<{ toast: { type: string; content: string }; card?: CardContent }> {
    if (pending.kind !== 'permission') {
      return { toast: { type: 'error', content: '当前不是权限请求' } };
    }

    const reply = value.reply as 'once' | 'always' | 'reject' | undefined;
    if (!reply || !['once', 'always', 'reject'].includes(reply)) {
      return { toast: { type: 'error', content: '无效的权限响应' } };
    }

    const perm = pending.data;
    log.info({ chatId, permissionId: perm.id, reply }, 'Card action: replying to permission');

    const confirmText = reply === 'reject'
      ? '已拒绝该权限请求。'
      : reply === 'always'
        ? '已永久授权该权限。'
        : '已授权一次该权限。';
    const confirmCard = FeishuCard.createInteractionRepliedCard('permission', reply);

    // Update in-memory state synchronously so concurrent flushCard / re-clicks
    // see the new state immediately. This must happen BEFORE we return so the
    // caller doesn't process duplicate events.
    this.sessionManager.clearPendingInteraction(chatId);
    const session = this.sessionManager.getSession(chatId);
    if (session) {
      // Re-bind currentMessageId to the clicked card so subsequent flushCard
      // calls update the same card the user sees (AI may have sent cards via
      // MCP, causing currentMessageId to diverge from the clicked messageId).
      if (messageId !== session.currentMessageId) {
        this.sessionManager.setCurrentMessage(chatId, messageId);
      }
      // Mark that the interaction was handled via card click so flushCard
      // won't overwrite the confirmation state with AI streaming output.
      session.interactionReplied = true;
    }
    this.sessionManager.updateStatus(chatId, 'idle');

    // Fire the network calls in the background and return the toast immediately.
    // Feishu's UI has a strict callback timeout — awaiting both replyPermission
    // and updateCard (~500ms total) was overrunning it and causing the client
    // to display its own error popup despite our handler succeeding.
    void (async () => {
      try {
        await this.opencode.replyPermission(perm.id, reply);
        log.info({ chatId, permissionId: perm.id }, 'replyPermission relayed to OpenCode');
      } catch (err) {
        log.error({ err, chatId, permissionId: perm.id }, 'replyPermission failed (background)');
      }
      try {
        // Use sendCard to create a new confirmation card instead of patching
        // the old card. This avoids 200340 (MessageNotPersisted) when the
        // streaming card has exhausted its PATCH budget during a long
        // permission-pending period.
        const newMsg = await this.feishuApi.sendCard(chatId, confirmCard);
        log.info({ chatId, newMessageId: newMsg?.message_id, permissionId: perm.id }, 'Confirmation card sent');
        if (newMsg?.message_id) {
          this.sessionManager.setCurrentMessage(chatId, newMsg.message_id);
          log.info({ chatId, newMessageId: newMsg.message_id }, 'Re-bound currentMessageId to confirmation card');
        }
      } catch (err) {
        log.error({ err, chatId, messageId }, 'sendCard for confirmation failed (background)');
      }
    })();

    return { toast: { type: 'success', content: confirmText } };
  }

  private async handleQuestionCardAction(
    chatId: string,
    messageId: string,
    value: Record<string, unknown>,
    pending: import('./types.js').PendingInteraction,
  ): Promise<{ toast: { type: string; content: string }; card?: CardContent }> {
    if (pending.kind !== 'question') {
      return { toast: { type: 'error', content: '当前不是问题选择' } };
    }

    const answers = value.ans as string[][] | undefined;
    if (!answers || !Array.isArray(answers)) {
      return { toast: { type: 'error', content: '无效的选择' } };
    }

    const q = pending.data;
    log.info({ chatId, requestId: q.id, answers }, 'Card action: replying to question');

    const label = answers.map(a => a.join(', ')).join('; ');
    const confirmCard = FeishuCard.createInteractionRepliedCard('question', label);

    // Update in-memory state synchronously and return immediately, doing the
    // network calls in the background — see handlePermissionCardAction for the
    // rationale on returning fast.
    this.sessionManager.clearPendingInteraction(chatId);
    const session = this.sessionManager.getSession(chatId);
    if (session) {
      if (messageId !== session.currentMessageId) {
        this.sessionManager.setCurrentMessage(chatId, messageId);
      }
      session.interactionReplied = true;
    }
    this.sessionManager.updateStatus(chatId, 'idle');

    void (async () => {
      try {
        await this.opencode.replyQuestion(q.id, answers);
        log.info({ chatId, requestId: q.id }, 'replyQuestion relayed to OpenCode');
      } catch (err) {
        log.error({ err, chatId, requestId: q.id }, 'replyQuestion failed (background)');
      }
      try {
        // Use sendCard instead of updateCard to avoid 200340 when the
        // streaming card's PATCH budget is exhausted.
        const newMsg = await this.feishuApi.sendCard(chatId, confirmCard);
        log.info({ chatId, newMessageId: newMsg?.message_id, requestId: q.id }, 'Confirmation card sent');
        if (newMsg?.message_id) {
          this.sessionManager.setCurrentMessage(chatId, newMsg.message_id);
          log.info({ chatId, newMessageId: newMsg.message_id }, 'Re-bound currentMessageId to confirmation card');
        }
      } catch (err) {
        log.error({ err, chatId, messageId }, 'sendCard for confirmation failed (background)');
      }
    })();

    return { toast: { type: 'success', content: `已提交选择：${label}` } };
  }

  private async handleNavigationCardAction(
    chatId: string,
    messageId: string,
    value: Record<string, unknown>,
  ): Promise<{ toast?: { type: string; content: string }; card?: CardContent } | undefined> {
    const cmd = value.cmd as string;
    const sessionId = value.sessionId as string;

    if (!cmd) {
      log.warn({ chatId, messageId, value }, 'Navigation action missing cmd');
      return { toast: { type: 'error', content: '无效的导航操作' } };
    }

    log.info({ chatId, messageId, cmd, sessionId }, 'Card action: navigation command');

    try {
      await this.opencode.sendCommand(sessionId || chatId, cmd);
      log.info({ chatId, messageId, cmd }, 'Navigation command sent to OpenCode');
      return { toast: { type: 'success', content: '已执行' } };
    } catch (err) {
      log.error({ err, chatId, messageId, cmd }, 'Failed to send navigation command');
      return { toast: { type: 'error', content: '执行失败' } };
    }
  }

  private async handleModelCardAction(
    chatId: string,
    messageId: string,
    value: Record<string, unknown>,
    option?: string,
  ): Promise<{ toast?: { type: string; content: string }; card?: CardContent } | undefined> {
    let modelKey: string;

    if (option) {
      modelKey = option;
    } else {
      const providerID = value.providerID as string;
      const modelID = value.modelID as string;
      if (!providerID || !modelID) {
        log.warn({ chatId, messageId, value }, 'Model action missing providerID or modelID');
        return { toast: { type: 'error', content: '无效的模型选择' } };
      }
      modelKey = `${providerID}/${modelID}`;
    }

    const [providerID, modelID] = modelKey.split('/');
    if (!providerID || !modelID) {
      log.warn({ chatId, messageId, modelKey }, 'Invalid model key format');
      return { toast: { type: 'error', content: '无效的模型格式' } };
    }

    log.info({ chatId, messageId, modelKey }, 'Switching model');

    const session = this.sessionManager.getSession(chatId);
    if (session) {
      session.currentModel = modelKey;
      session.modelSelection = undefined;
      session.interactionReplied = true;
      if (messageId !== session.currentMessageId) {
        this.sessionManager.setCurrentMessage(chatId, messageId);
      }
    }

    try {
      await this.opencode.updateConfig({ model: modelKey });
      this.chatModelOverrides.set(chatId, { providerID, modelID });
      log.info({ chatId, modelKey }, 'Model switched, override set for next prompt');

      const doneCard = FeishuCard.createStreamingCard({
        content: '',
        botName: this.botName,
        done: true,
        currentModel: modelKey,
        showProcess: this.config.showProcess || 'none',
      });
      return { toast: { type: 'success', content: `已切换到 ${modelKey}` }, card: doneCard };
    } catch (err) {
      log.error({ err, chatId, modelKey }, 'Failed to switch model');
      return { toast: { type: 'error', content: '切换模型失败' } };
    }
  }

  private async handleAgentCardAction(
    chatId: string,
    messageId: string,
    value: Record<string, unknown>,
    option?: string,
  ): Promise<{ toast?: { type: string; content: string }; card?: CardContent } | undefined> {
    const agentName = option || (value.name as string);
    if (!agentName) {
      log.warn({ chatId, messageId, value }, 'Agent action missing name');
      return { toast: { type: 'error', content: '无效的代理选择' } };
    }

    log.info({ chatId, messageId, agentName }, 'Switching agent');

    const session = this.sessionManager.getSession(chatId);
    if (session) {
      session.currentAgent = agentName;
      session.agentSelection = undefined;
      session.interactionReplied = true;
      if (messageId !== session.currentMessageId) {
        this.sessionManager.setCurrentMessage(chatId, messageId);
      }
    }

    try {
      await this.opencode.updateConfig({ default_agent: agentName });
      log.info({ chatId, agentName }, 'Agent switched');

      const doneCard = FeishuCard.createStreamingCard({
        content: '',
        botName: this.botName,
        done: true,
        currentAgent: agentName,
        showProcess: this.config.showProcess || 'none',
      });
      return { toast: { type: 'success', content: `已切换到代理 ${agentName}` }, card: doneCard };
    } catch (err) {
      log.error({ err, chatId, agentName }, 'Failed to switch agent');
      return { toast: { type: 'error', content: '切换代理失败' } };
    }
  }

  private deduplicateAndSortSessions(sessions: any): Array<{ id: string; title?: string; created: number; updated: number }> {
    let sessList = Array.isArray(sessions)
      ? sessions.map((s: any) => ({ id: s.id, title: s.title, created: s.time?.created || 0, updated: s.time?.updated || 0 }))
      : [];
    
    const titleMap = new Map<string, any>();
    for (const sess of sessList) {
      const key = sess.title || sess.id;
      const existing = titleMap.get(key);
      if (!existing || sess.updated > existing.updated) {
        titleMap.set(key, sess);
      }
    }
    sessList = Array.from(titleMap.values());
    
    sessList.sort((a, b) => b.updated - a.updated);
    
    return sessList.slice(0, 20);
  }

  private async handleSessionCardAction(
    chatId: string,
    messageId: string,
    value: Record<string, unknown>,
  ): Promise<{ toast?: { type: string; content: string }; card?: CardContent } | undefined> {
    const op = value.op as string;
    const sessionId = value.id as string;
    const title = value.title as string;

    if (!op || !sessionId) {
      return { toast: { type: 'error', content: '无效操作' } };
    }

    log.info({ chatId, messageId, op, sessionId }, 'Session card action');

    try {
      if (op === 'switch') {
        await this.opencode.selectSession(sessionId);
        const displayTitle = title || sessionId.substring(0, 16);
        const doneCard = FeishuCard.createSessionSwitchedCard(displayTitle);
        return { toast: { type: 'success', content: `已切换到 ${displayTitle}` }, card: doneCard };
      }

      if (op === 'delete') {
        await this.opencode.deleteSession(sessionId);
        const sessions = await this.opencode.getSessions();
        const sessList = this.deduplicateAndSortSessions(sessions);
        const currentSession = this.sessionManager.getSession(chatId);
        const card = FeishuCard.createSessionsCard({
          sessions: sessList,
          currentSessionId: currentSession?.id || '',
        });
        return { toast: { type: 'success', content: `已删除 ${title || sessionId.substring(0, 8)}` }, card };
      }

      return { toast: { type: 'error', content: `未知操作: ${op}` } };
    } catch (err) {
      log.error({ err, chatId, op, sessionId }, 'Session card action failed');
      return { toast: { type: 'error', content: `操作失败: ${err instanceof Error ? err.message : String(err)}` } };
    }
  }

  private async handleStatusCardAction(
    chatId: string,
    messageId: string,
    value: Record<string, unknown>,
  ): Promise<{ toast?: { type: string; content: string }; card?: CardContent } | undefined> {
    const op = value.op as string;
    log.info({ chatId, messageId, op }, 'Status card action');

    try {
      let branch: string | undefined;
      let commit: string | undefined;
      let files: Array<{ path: string; status: string; added: number; removed: number }> = [];
      try {
        const vcsInfo = await this.opencode.getVcsInfo();
        branch = vcsInfo?.branch;
        commit = vcsInfo?.commit || vcsInfo?.hash;
      } catch { /* vcs not available */ }
      try {
        const fileStatus = await this.opencode.getStatus();
        if (Array.isArray(fileStatus)) {
          files = fileStatus;
        } else if (fileStatus?.files) {
          files = fileStatus.files;
        }
      } catch { /* file status not available */ }

      const card = FeishuCard.createStatusCard({ branch, commit, files });
      await this.feishuApi.updateCard(messageId, card);
      return { toast: { type: 'success', content: '状态已刷新' } };
    } catch (err) {
      log.error({ err, chatId }, 'Status refresh failed');
      return { toast: { type: 'error', content: '刷新失败' } };
    }
  }

  private async handleCtrlCardAction(
    chatId: string,
    messageId: string,
    value: Record<string, unknown>,
  ): Promise<{ toast?: { type: string; content: string }; card?: CardContent } | undefined> {
    const op = value.op as string;
    if (!op) {
      return { toast: { type: 'error', content: '无效操作' } };
    }

    const session = this.sessionManager.getSession(chatId);
    if (!session) {
      return { toast: { type: 'error', content: '无活跃会话' } };
    }

    log.info({ chatId, messageId, op, sessionId: session.id }, 'Task control action');

    try {
      if (op === 'interrupt') {
        await this.opencode.abortSession(session.id);
        return { toast: { type: 'info', content: '已暂停当前任务' } };
      }

      if (op === 'abort') {
        await this.opencode.abortSession(session.id);
        return { toast: { type: 'warning', content: '已终止任务' } };
      }

      return { toast: { type: 'error', content: `未知操作: ${op}` } };
    } catch (err) {
      log.error({ err, chatId, op }, 'Task control failed');
      return { toast: { type: 'error', content: `操作失败: ${err instanceof Error ? err.message : String(err)}` } };
    }
  }

  private async handleCommandCardAction(
    chatId: string,
    messageId: string,
    value: Record<string, unknown>,
  ): Promise<{ toast?: { type: string; content: string }; card?: CardContent } | undefined> {
    const cmdName = value.name as string;
    if (!cmdName) {
      return { toast: { type: 'error', content: '无效命令' } };
    }

    log.info({ chatId, messageId, cmdName }, 'Command card action');

    // Handle /restart specially
    if (cmdName === 'restart') {
      await this.handleRestartCommand(chatId);
      return { toast: { type: 'success', content: '正在重启...' } };
    }

    // Auto-create session if needed
    let session = this.sessionManager.getSession(chatId);
    if (!session) {
      try {
        session = await this.sessionManager.getOrCreateSession(chatId, 'p2p');
      } catch (err) {
        return { toast: { type: 'error', content: `创建会话失败: ${err instanceof Error ? err.message : String(err)}` } };
      }
    }

    // List commands
    const listCommands = ['models', 'agents', 'commands', 'sessions', 'status'];
    if (listCommands.includes(cmdName)) {
      try {
        await this.handleListCommand(chatId, session.id, cmdName, '');
        return { toast: { type: 'success', content: `已执行 /${cmdName}` } };
      } catch (err) {
        return { toast: { type: 'error', content: `执行失败: ${err instanceof Error ? err.message : String(err)}` } };
      }
    }

    // Handle /new - create a new session
    if (cmdName === 'new') {
      try {
        const newSession = await this.opencode.createSession('Feishu p2p ' + chatId);
        return { toast: { type: 'success', content: `已创建新会话: ${(newSession.id || '').substring(0, 12)}...` } };
      } catch (err) {
        return { toast: { type: 'error', content: `创建会话失败: ${err instanceof Error ? err.message : String(err)}` } };
      }
    }

    const shortcuts: Record<string, string> = {
      'share': 'session.share',
      'interrupt': 'session.interrupt',
      'compact': 'session.compact',
    };

    const fullCmdName = shortcuts[cmdName] || cmdName;

    try {
      const commandInfo = this.availableCommands.get(fullCmdName);
      if (commandInfo?.type === 'tui') {
        await this.opencode.executeTuiCommand(fullCmdName);
      } else if (commandInfo?.type === 'custom') {
        await this.opencode.sendPrompt(session.id, `/${cmdName}`);
      } else {
        await this.opencode.sendCommand(session.id, fullCmdName, '');
      }
      return { toast: { type: 'success', content: `已执行 /${cmdName}` } };
    } catch (err) {
      log.error({ err, chatId, cmdName }, 'Command execution failed');
      return { toast: { type: 'error', content: `执行失败: ${err instanceof Error ? err.message : String(err)}` } };
    }
  }

  /**
   * Handle list commands (models, agents, commands, sessions) by fetching data from OpenCode.
   */
  private async handleListCommand(
    chatId: string,
    sessionId: string,
    command: string,
    args?: string,
  ): Promise<void> {
    log.info({ sessionId, command, args }, `Fetching ${command} list from OpenCode`);
    try {
      let message = '';
      switch (command) {
        case 'models': {
          const config = await this.opencode.getConfig();
          const currentModel = config?.model || undefined;
          const providerData = await this.opencode.listProviders();
          const allProviders = providerData?.all || providerData?.providers || [];
          const connected = new Set(providerData?.connected || []);

          const cardProviders = allProviders
            .filter((p: any) => connected.has(p.id))
            .map((p: any) => ({
              id: p.id,
              name: p.name || p.id,
              models: p.models
                ? Object.entries(p.models).map(([id, m]: [string, any]) => ({
                    id,
                    name: m.name || id,
                  }))
                : [],
            }))
            .filter((p: any) => p.models.length > 0);

          if (cardProviders.length === 0) {
            message = '暂无可用模型';
            await this.feishuApi.sendText(chatId, message);
          } else {
            const session = this.sessionManager.getSession(chatId);
            if (session) {
              session.modelSelection = { providers: cardProviders, currentModel };
            }
            const card = FeishuCard.createStreamingCard({
              content: '',
              botName: this.botName,
              done: false,
              showProcess: this.config.showProcess || 'none',
              modelSelection: { providers: cardProviders, currentModel },
            });
            if (session?.currentMessageId) {
              await this.feishuApi.updateCard(session.currentMessageId, card);
            } else {
              const msg = await this.feishuApi.sendCard(chatId, card);
              if (msg?.message_id && session) {
                this.sessionManager.setCurrentMessage(chatId, msg.message_id);
              }
            }
          }
          this.sessionManager.updateStatus(chatId, 'idle');
          log.info({ command }, `${command} rendered in streaming card`);
          return;
        }
        case 'agents': {
          const agents = await this.opencode.getAgents();
          const agentList = Array.isArray(agents)
            ? agents.filter((a: any) => a.mode !== 'subagent' && !a.hidden)
            : [];

          if (agentList.length === 0) {
            message = '暂无可用代理';
            await this.feishuApi.sendText(chatId, message);
          } else {
            const config = await this.opencode.getConfig();
            const currentAgent = config?.default_agent || config?.agent?.build?.name || 'build';
            const session = this.sessionManager.getSession(chatId);
            const agentItems = agentList.map((a: any) => ({
              name: a.name,
              description: a.description,
              mode: a.mode,
            }));
            if (session) {
              session.agentSelection = { agents: agentItems, currentAgent };
            }
            const card = FeishuCard.createStreamingCard({
              content: '',
              botName: this.botName,
              done: false,
              showProcess: this.config.showProcess || 'none',
              agentSelection: { agents: agentItems, currentAgent },
            });
            if (session?.currentMessageId) {
              await this.feishuApi.updateCard(session.currentMessageId, card);
            } else {
              const msg = await this.feishuApi.sendCard(chatId, card);
              if (msg?.message_id && session) {
                this.sessionManager.setCurrentMessage(chatId, msg.message_id);
              }
            }
          }
          this.sessionManager.updateStatus(chatId, 'idle');
          log.info({ command }, `${command} rendered in streaming card`);
          return;
        }
        case 'commands': {
          const cmdList = [
            { name: 'models', description: '选择模型' },
            { name: 'agents', description: '选择代理' },
            { name: 'commands', description: '查看所有命令' },
            { name: 'sessions', description: '管理会话' },
            { name: 'status', description: '项目状态' },
            { name: 'new', description: '创建新会话' },
            { name: 'compact', description: '压缩上下文' },
            { name: 'restart', description: '重启服务' },
            { name: 'init', description: '初始化 AGENTS.md' },
            { name: 'review', description: '审查代码变更' },
          ];
          await this.feishuApi.sendCard(chatId, FeishuCard.createCommandsCard(cmdList));
          this.sessionManager.updateStatus(chatId, 'idle');
          this.sessionManager.clearCurrentMessage(chatId);
          return;
        }
        case 'sessions': {
          const sessions = await this.opencode.getSessions();
          const sessList = this.deduplicateAndSortSessions(sessions);
          
          if (sessList.length === 0) {
            await this.feishuApi.sendText(chatId, '暂无会话');
          } else {
            const currentSession = this.sessionManager.getSession(chatId);
            await this.feishuApi.sendCard(chatId, FeishuCard.createSessionsCard({
              sessions: sessList,
              currentSessionId: currentSession?.id || '',
            }));
          }
          this.sessionManager.updateStatus(chatId, 'idle');
          this.sessionManager.clearCurrentMessage(chatId);
          return;
        }
        case 'tools': {
          const tools = await this.opencode.getTools();
          message = '**🔧 可用工具列表**\n\n';
          if (tools && Array.isArray(tools)) {
            for (const tool of tools) {
              message += `- ${tool.name || tool.id || 'Unknown'}`;
              if (tool.description) message += `: ${tool.description}`;
              message += '\n';
            }
          } else {
            message += '暂无工具信息\n';
          }
          break;
        }
        case 'worktrees': {
          const worktrees = await this.opencode.getWorktrees();
          message = '**🌳 工作树列表**\n\n';
          if (worktrees && Array.isArray(worktrees)) {
            for (const wt of worktrees) {
              message += `- ${wt.name || wt.id || 'Unknown'}`;
              if (wt.path) message += ` (${wt.path})`;
              message += '\n';
            }
          } else {
            message += '暂无工作树信息\n';
          }
          break;
        }
        case 'files': {
          const files = await this.opencode.getFiles(args);
          message = `**📁 文件列表${args ? ` (${args})` : ''}**\n\n`;
          if (files && Array.isArray(files)) {
            for (const file of files) {
              message += `- ${file.name || file.id || 'Unknown'}`;
              if (file.type) message += ` [${file.type}]`;
              message += '\n';
            }
          } else {
            message += '暂无文件信息\n';
          }
          break;
        }
        case 'status': {
          let branch: string | undefined;
          let commit: string | undefined;
          let files: Array<{ path: string; status: string; added: number; removed: number }> = [];
          try {
            const vcsInfo = await this.opencode.getVcsInfo();
            branch = vcsInfo?.branch;
            commit = vcsInfo?.commit || vcsInfo?.hash;
          } catch { /* vcs not available */ }
          try {
            const fileStatus = await this.opencode.getStatus();
            if (Array.isArray(fileStatus)) {
              files = fileStatus;
            } else if (fileStatus?.files) {
              files = fileStatus.files;
            }
          } catch { /* file status not available */ }
          await this.feishuApi.sendCard(chatId, FeishuCard.createStatusCard({ branch, commit, files }));
          this.sessionManager.updateStatus(chatId, 'idle');
          this.sessionManager.clearCurrentMessage(chatId);
          return;
        }
        case 'config': {
          const config = await this.opencode.getConfig();
          message = '**⚙️ 配置信息**\n\n';
          if (config) {
            message += `- 项目: ${config.name || 'Unknown'}\n`;
            message += `- 目录: ${config.directory || 'Unknown'}\n`;
            if (config.providers && Array.isArray(config.providers)) {
              message += `- Providers: ${config.providers.length}\n`;
            }
            if (config.agents && Array.isArray(config.agents)) {
              message += `- Agents: ${config.agents.length}\n`;
            }
          } else {
            message += '暂无配置信息\n';
          }
          break;
        }
      }

      await this.feishuApi.sendText(chatId, message);
      this.sessionManager.updateStatus(chatId, 'idle');
      this.sessionManager.clearCurrentMessage(chatId);
      log.info({ command }, `${command} list sent successfully`);
    } catch (err) {
      log.error({ err, command }, `Failed to fetch ${command} list`);
      await this.feishuApi.sendText(chatId, `❌ 获取${command}列表失败`);
      this.sessionManager.updateStatus(chatId, 'idle');
      this.sessionManager.clearCurrentMessage(chatId);
    }
  }

  /**
   * Parse a slash command from text.
   * Returns { command, args } if text starts with /, otherwise null.
   * Examples: `/help` → { command: 'help' }, `/compact all` → { command: 'compact', args: 'all' }
   */
  private parseSlashCommand(text: string): { command: string; args?: string } | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) return null;

    const withoutPrefix = trimmed.slice(1);
    const firstSpace = withoutPrefix.search(/\s/);

    if (firstSpace === -1) {
      return { command: withoutPrefix };
    }

    const command = withoutPrefix.slice(0, firstSpace);
    const args = withoutPrefix.slice(firstSpace + 1).trim();
    return { command, args: args || undefined };
  }

  /**
   * Unified media download handler for images, files, audio, and video.
   * Returns a text placeholder for the message and optionally the file info
   * for forwarding to OpenCode.
   */
  private async downloadMedia(
    messageId: string,
    fileKey: string | undefined,
    resourceType: 'image' | 'file',
    fileName: string,
    mimeType: string,
    typeLabel: string
  ): Promise<{ text: string; file?: { filePath: string; fileName: string; mimeType: string } }> {
    if (!fileKey) {
      return { text: `[${typeLabel}消息]` };
    }

    try {
      log.info({ messageId, fileKey, fileName }, `Downloading ${typeLabel}...`);
      const buffer = await this.feishuApi.downloadMedia(messageId, fileKey, resourceType);
      const downloaded = await this.fileDownloader.saveBuffer(buffer, fileName, mimeType);
      // opencode file part API 仅支持 image/text/audio/video 类型，
      // 其他 mime type（如 application/zip）会返回 BadRequest。
      // 对不支持的格式只传文本路径，让 opencode 直接读文件。
      const supportedMime = /^(image|text|audio|video)\//.test(mimeType);
      return {
        text: `[${typeLabel}已上传: ${downloaded.filePath}]`,
        ...(supportedMime ? { file: {
          filePath: downloaded.filePath,
          fileName: downloaded.fileName,
          mimeType,
        }} : {}),
      };
    } catch (err) {
      log.error({ err, messageId, fileKey, resourceType }, `Failed to download ${typeLabel}`);
      return { text: `[${typeLabel}消息（下载失败）]` };
    }
  }

  /**
   * Handle restart command from admin user.
   * Simple implementation: send message and fire-and-forget the restart script.
   */
  private async handleRestartCommand(chatId: string): Promise<void> {
    const { execSync, spawn } = await import('child_process');
    const path = await import('path');

    try {
      await this.feishuApi.sendText(chatId, '🔄 正在重启 OpenCode 服务...');

      // Find the restart script
      const possiblePaths = [
        path.join(process.cwd(), 'connectors', 'feishu', 'restart-serve.sh'),
        path.join(this.opencode.getDirectory(), 'connectors', 'feishu', 'restart-serve.sh'),
      ];

      let scriptPath = '';
      for (const p of possiblePaths) {
        try {
          execSync(`test -f "${p}"`, { stdio: 'ignore' });
          scriptPath = p;
          break;
        } catch {
          continue;
        }
      }

      if (!scriptPath) {
        log.error('restart-serve.sh not found');
        await this.feishuApi.sendText(chatId, '❌ 找不到重启脚本 connectors/feishu/restart-serve.sh');
        return;
      }

      // Fire-and-forget: spawn the restart script and don't wait for result
      const child = spawn('bash', [scriptPath, '19876'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();

      log.info({ scriptPath }, 'Restart script spawned');
    } catch (err) {
      log.error({ err }, 'Restart command failed');
      try {
        await this.feishuApi.sendText(chatId, `❌ 重启失败：${err instanceof Error ? err.message : String(err)}`);
      } catch { /* ignore */ }
    }
  }
}
