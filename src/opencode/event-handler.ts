import type { SessionManager } from '../core/session-manager.js';
import type { FeishuAPI } from '../feishu/api.js';
import type { ToolState, PendingInteraction } from '../core/types.js';
import type { HookManager } from '../core/hook-manager.js';
import { FeishuCard } from '../feishu/card.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('EventHandler');

const UPDATE_THROTTLE_MS = 2000;

export class OpenCodeEventHandler {
  private sessionManager: SessionManager;
  private feishuApi: FeishuAPI;
  private isRunning = false;
  private hookManager?: HookManager;
  private opencodeUrl: string;
  private showProcess: 'none' | 'tools' | 'thinking' | 'full';
  private botName: string;
  private thinkingLanguage: 'chinese' | 'english';
  private autoApprove: boolean;
  private opencode: any;
  constructor(
    sessionManager: SessionManager,
    feishuApi: FeishuAPI,
    hookManager?: HookManager,
    opencodeUrl?: string,
    showProcess: 'none' | 'tools' | 'thinking' | 'full' = 'none',
    botName = 'opencode',
    thinkingLanguage: 'chinese' | 'english' = 'chinese',
    autoApprove = false,
    opencode: any = null,
  ) {
    this.sessionManager = sessionManager;
    this.feishuApi = feishuApi;
    this.hookManager = hookManager;
    this.opencodeUrl = opencodeUrl || 'http://localhost:19876';
    this.showProcess = showProcess;
    this.botName = botName;
    this.thinkingLanguage = thinkingLanguage;
    this.autoApprove = autoApprove;
    this.opencode = opencode;
  }

  /**
   * Check if thinking content should be shown based on showProcess config.
   */
  private shouldShowThinking(): boolean {
    return this.showProcess === 'thinking' || this.showProcess === 'full';
  }

  /**
   * Check if tools should be shown based on showProcess config.
   */
  private shouldShowTools(): boolean {
    return this.showProcess === 'tools' || this.showProcess === 'full';
  }

  async start(eventStream: { stream: AsyncGenerator<any, void, unknown> }): Promise<void> {
    if (this.isRunning) {
      log.warn('Already running');
      return;
    }

    this.isRunning = true;
    log.info('Started');

    try {
      for await (const event of eventStream.stream) {
        if (!this.isRunning) break;
        await this.handleEvent(event);
      }
    } catch (error) {
      log.error({ err: error }, 'Stream error');
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  stop(): void {
    this.isRunning = false;
    log.info('Stopped');
  }

  private async handleEvent(globalEvent: any): Promise<void> {
    try {
      const payload = globalEvent.payload || globalEvent;
      const props = payload.properties || payload;

      switch (payload.type) {
        case 'message.part.delta':
          await this.handleTextDelta(props);
          break;
        case 'message.part.updated':
          await this.handlePartUpdate(props);
          break;
        case 'session.status':
          await this.handleStatusChange(props);
          break;
        case 'session.error':
          await this.handleError(props);
          break;
        case 'session.idle':
          await this.handleSessionIdle(props);
          break;
        case 'permission.asked':
        case 'permission.updated':
          await this.handlePermissionAsked(props);
          break;
        case 'permission.replied':
          await this.handlePermissionReplied(props);
          break;
        case 'question.asked':
          await this.handleQuestionAsked(props);
          break;
        case 'question.replied':
          await this.handleQuestionReplied(props);
          break;
        case 'question.rejected':
          await this.handleQuestionRejected(props);
          break;
        case 'command.executed':
          await this.handleCommandExecuted(props);
          break;
        case 'server.heartbeat':
          // Silently ignore heartbeat events to reduce log noise
          break;
        default:
          log.debug({ type: payload.type }, 'Unhandled event type');
          break;
      }
    } catch (err) {
      log.error({ err }, 'Error handling event');
    }
  }

  private async handleTextDelta(properties: {
    sessionID: string;
    messageID: string;
    partID: string;
    field: string;
    delta: any;
  }): Promise<void> {
    if (!properties) return;

    // Handle non-string delta (e.g. object, array) by converting to string
    let deltaStr: string;
    if (typeof properties.delta === 'string') {
      deltaStr = properties.delta;
    } else if (properties.delta === null || properties.delta === undefined) {
      deltaStr = '';
    } else if (typeof properties.delta === 'object') {
      // If it's an object, try to extract text content or stringify
      deltaStr = properties.delta.text || properties.delta.content || JSON.stringify(properties.delta);
    } else {
      deltaStr = String(properties.delta);
    }

    // Skip empty deltas
    if (!deltaStr) {
      return;
    }

    log.info({ field: properties.field, partID: properties.partID?.substring(0, 20), deltaLen: deltaStr.length, deltaPreview: deltaStr.substring(0, 80) }, 'Text delta');
    
    // Translate English thinking/reasoning content to Chinese when set to chinese mode
    if ((properties.field === 'thinking' || properties.field === 'reasoning') && this.thinkingLanguage === 'chinese' && this.containsEnglish(deltaStr)) {
      deltaStr = this.translateToChinese(deltaStr);
    }
    
    const chatId = this.sessionManager.getChatIdBySession(properties.sessionID);
    if (!chatId) return;

    // Determine if we should show this field based on showProcess config
    const shouldShowField = this.shouldShowField(properties.field);
    if (!shouldShowField) {
      return;
    }

    this.sessionManager.appendContent(chatId, deltaStr, properties.partID, properties.field);
    await this.flushCard(chatId);
  }

  /**
   * Determine if a field should be displayed based on showProcess config.
   */
  private shouldShowField(field?: string): boolean {
    switch (this.showProcess) {
      case 'full':
        return true;
      case 'thinking':
        return field === 'text' || field === 'thinking' || field === 'reasoning';
      case 'tools':
        return field === 'text' || !field;
      case 'none':
      default:
        return !field || field === 'text';
    }
  }

  private async handlePartUpdate(properties: {
    sessionID: string;
    part: any;
  }): Promise<void> {
    // Skip tool display if not showing tools
    if (!this.shouldShowTools()) return;

    const { part } = properties;
    if (part?.type !== 'tool') return;

    const chatId = this.sessionManager.getChatIdBySession(properties.sessionID);
    if (!chatId) return;

    const session = this.sessionManager.getSession(chatId);
    if (!session) return;

    const status = part.state?.status as ToolState['status'] | undefined;
    if (!status) return;

    if (!session.tools) session.tools = [];
    const partId: string = part.id || part.state?.id || part.state?.title || '';
    const name: string = part.state?.title || part.tool || partId || 'tool';

    const existing = partId ? session.tools.find(t => t.id === partId) : undefined;
    if (existing) {
      existing.status = status;
      existing.name = name;
      if (status === 'error') existing.error = part.state?.error;
    } else {
      session.tools.push({
        id: partId,
        name,
        status,
        ...(status === 'error' ? { error: part.state?.error } : {}),
      });
    }

    // Tool transitions are rare relative to text deltas — flush immediately
    // so users see progress without waiting for the text throttle window.
    await this.flushCard(chatId, { force: true });
  }

  private async handleStatusChange(properties: {
    sessionID: string;
    status: { type: string; message?: string };
  }): Promise<void> {
    const chatId = this.sessionManager.getChatIdBySession(properties.sessionID);
    if (!chatId) return;

    const session = this.sessionManager.getSession(chatId);
    if (!session) return;

    switch (properties.status.type) {
      case 'busy':
        session.status = 'busy';
        if (session.retryMessage) {
          // 重试结束、正常执行恢复，清掉 retry 通知并刷一次
          session.retryMessage = undefined;
          await this.flushCard(chatId, { force: true });
        }
        break;

      case 'idle':
        // 不在这里清理 currentMessage，等 session.idle 事件做 final flush 后再清
        // 但如果用户在处理交互（权限/问题），保持 busy 状态，防止新消息绕过检查。
        if (session.pendingInteraction) {
          log.info({ chatId, interactionKind: session.pendingInteraction.kind }, 'OpenCode reports idle but pending interaction remains; keeping status busy');
          session.status = 'busy';
        } else {
          session.status = 'idle';
        }
        break;

      case 'retry':
        session.retryMessage = properties.status.message || '等待重试';
        await this.flushCard(chatId, { force: true });
        break;
    }
  }

  private async handleError(properties: {
    sessionID?: string;
    error: string;
  }): Promise<void> {
    if (!properties.sessionID) return;
    const chatId = this.sessionManager.getChatIdBySession(properties.sessionID);
    if (!chatId) return;

    // If the session is already idle or error was already handled,
    // the error was likely already handled by MessageHandler.
    // Avoid sending a duplicate error card.
    const session = this.sessionManager.getSession(chatId);
    if (session?.status === 'idle') {
      log.info({ chatId, sessionId: properties.sessionID }, 'Session already idle, skipping duplicate error card');
      return;
    }
    if (session?.errorHandled) {
      log.info({ chatId, sessionId: properties.sessionID }, 'Error already handled, skipping duplicate error card');
      return;
    }

    await this.feishuApi.sendCard(chatId, FeishuCard.createErrorCard(properties.error));
    if (session) {
      session.tools = undefined;
      session.retryMessage = undefined;
    }
    this.sessionManager.updateStatus(chatId, 'idle');
    this.sessionManager.clearCurrentMessage(chatId);
  }

  private async handleSessionIdle(properties: {
    sessionID: string;
  }): Promise<void> {
    const chatId = this.sessionManager.getChatIdBySession(properties.sessionID);
    if (!chatId) return;

    const session = this.sessionManager.getSession(chatId);
    if (!session) return;

    const hasContent = !!(session.currentContent && session.currentContent.length > 0);
    const hasTools = !!(session.tools && session.tools.length > 0);
    // Always finalize the card if one exists, even when the bot turn produced
    // no text (e.g. slash commands that only trigger side effects).
    if (hasContent || hasTools || session.currentMessageId) {
      await this.flushCard(chatId, { force: true, done: true });
    }

    session.tools = undefined;
    session.retryMessage = undefined;
    session.interactionReplied = undefined;
    this.sessionManager.updateStatus(chatId, 'idle');
    // Don't clear currentMessageId here — let MessageHandler clear it when a
    // new user message arrives. This prevents race conditions where AI sends
    // a card (via MCP) and our flushCard updates the wrong message.

    // Fire hook on session idle (context may have been compressed)
    if (this.hookManager) {
      this.hookManager.run('onSessionIdle', {
        sessionId: properties.sessionID,
        opencodeUrl: this.opencodeUrl,
      }).catch(err => log.error({ err }, 'onSessionIdle hook failed'));
    }
  }

  private async handlePermissionAsked(properties: any): Promise<void> {
    log.info({ sessionID: properties.sessionID }, 'handlePermissionAsked called');
    const chatId = this.sessionManager.getChatIdBySession(properties.sessionID);
    if (!chatId) {
      log.warn({ sessionID: properties.sessionID }, 'getChatIdBySession returned undefined');
      return;
    }

    const perm = properties.permission || properties.type || 'unknown';
    const patterns: string[] = properties.patterns || (properties.pattern ? [properties.pattern] : []);
    const title = properties.title || `${perm}: ${patterns.join(', ')}`;
    const permId = properties.id || properties.permissionID || '';

    // Auto-approve: if enabled, automatically grant permission without user interaction
    if (this.autoApprove && this.opencode && permId) {
      log.info({ chatId, permissionId: permId, perm, patterns }, 'Auto-approving permission');
      void (async () => {
        try {
          await this.opencode.replyPermission(permId, 'always');
          log.info({ chatId, permissionId: permId }, 'Auto-approved permission');
        } catch (err) {
          log.error({ err, chatId, permissionId: permId }, 'Auto-approve failed');
        }
      })();
      return;
    }

    const interaction: PendingInteraction = {
      kind: 'permission',
      data: {
        id: properties.id || properties.permissionID || '',
        permission: perm,
        patterns,
        title,
      },
    };

    this.sessionManager.setPendingInteraction(chatId, interaction);
    const session = this.sessionManager.getSession(chatId);
    log.info({ chatId, permission: perm, patterns, currentMessageId: session?.currentMessageId }, 'Permission asked');
    await this.flushCard(chatId, { force: true });
  }

  private async handlePermissionReplied(properties: any): Promise<void> {
    const chatId = this.sessionManager.getChatIdBySession(properties.sessionID);
    if (!chatId) return;

    const reply = properties.reply || 'once';
    const hadPending = this.sessionManager.getPendingInteraction(chatId) !== undefined;
    log.info({ chatId, reply, hadPending }, 'Permission replied');

    // Only flush if the interaction was still pending (i.e. user replied via text).
    // If the user already clicked a card button, handleCardAction already updated
    // the card to a confirmation state — don't overwrite it.
    this.sessionManager.clearPendingInteraction(chatId);
    if (hadPending) {
      await this.flushCard(chatId, { force: true });
    }
    
    // Clear interactionReplied flag so subsequent AI streaming output can update the card.
    // The confirmation state has already been shown; now we need to allow the AI to continue.
    const session = this.sessionManager.getSession(chatId);
    if (session) {
      session.interactionReplied = undefined;
      log.info({ chatId }, 'Cleared interactionReplied to allow AI streaming');
    }
  }

  private async handleQuestionAsked(properties: any): Promise<void> {
    const chatId = this.sessionManager.getChatIdBySession(properties.sessionID);
    if (!chatId) return;

    const rawQuestions = properties.questions || [];
    const questions = rawQuestions.map((q: any) => ({
      question: q.question || '',
      header: q.header || q.question?.substring(0, 30) || '',
      options: (q.options || []).map((o: any) => ({
        label: o.label || '',
        description: o.description || '',
      })),
      multiple: !!q.multiple,
      custom: q.custom !== false,
    }));

    const interaction: PendingInteraction = {
      kind: 'question',
      data: {
        id: properties.id || properties.requestID || '',
        questions,
      },
    };

    this.sessionManager.setPendingInteraction(chatId, interaction);
    log.info({ chatId, questionCount: questions.length }, 'Question asked');
    await this.flushCard(chatId, { force: true });
  }

  private async handleQuestionReplied(properties: any): Promise<void> {
    const chatId = this.sessionManager.getChatIdBySession(properties.sessionID);
    if (!chatId) return;

    const answers = properties.answers || [];
    const label = answers.map((a: string[]) => a.join(', ')).join('; ');
    log.info({ chatId, label }, 'Question replied');

    const hadPending = this.sessionManager.getPendingInteraction(chatId) !== undefined;
    this.sessionManager.clearPendingInteraction(chatId);
    if (hadPending) {
      await this.flushCard(chatId, { force: true });
    }
    
    // Clear interactionReplied flag so subsequent AI streaming output can update the card.
    const session = this.sessionManager.getSession(chatId);
    if (session) {
      session.interactionReplied = undefined;
      log.info({ chatId }, 'Cleared interactionReplied to allow AI streaming');
    }
  }

  private async handleQuestionRejected(properties: any): Promise<void> {
    const chatId = this.sessionManager.getChatIdBySession(properties.sessionID);
    if (!chatId) return;

    log.info({ chatId }, 'Question rejected');

    const hadPending = this.sessionManager.getPendingInteraction(chatId) !== undefined;
    this.sessionManager.clearPendingInteraction(chatId);
    if (hadPending) {
      await this.flushCard(chatId, { force: true });
    }
    
    // Clear interactionReplied flag so subsequent AI streaming output can update the card.
    const session = this.sessionManager.getSession(chatId);
    if (session) {
      session.interactionReplied = undefined;
      log.info({ chatId }, 'Cleared interactionReplied to allow AI streaming');
    }
  }

  /**
   * Check if text contains significant English content.
   */
  private containsEnglish(text: string): boolean {
    const englishWords = text.match(/[a-zA-Z]{4,}/g) || [];
    const totalWords = text.split(/\s+/).filter(w => w.length > 0).length;
    return englishWords.length > 2 && (englishWords.length / totalWords) > 0.3;
  }

  /**
   * Simple translation: replace common English thinking phrases with Chinese.
   * This is a best-effort approach; full translation would require an API.
   */
  private translateToChinese(text: string): string {
    const replacements: [RegExp, string][] = [
      [/\b(let me|I'll|I will|I need to|I should|I'm going to)\b/gi, '让我'],
      [/\b(think|thinking|thought)\b/gi, '思考'],
      [/\b(analyze|analyzing|analysis)\b/gi, '分析'],
      [/\b(consider|considering)\b/gi, '考虑'],
      [/\b(first|firstly|first of all)\b/gi, '首先'],
      [/\b(next|then|after that|subsequently)\b/gi, '接下来'],
      [/\b(finally|in conclusion|to conclude)\b/gi, '最后'],
      [/\b(however|but|although|though)\b/gi, '但是'],
      [/\b(therefore|so|thus|hence)\b/gi, '因此'],
      [/\b(because|since|as|due to)\b/gi, '因为'],
      [/\b(for example|for instance|e\.g\.)\b/gi, '例如'],
      [/\b(in other words|that is|i\.e\.)\b/gi, '换句话说'],
      [/\b(look|looking|search|searching)\b/gi, '查找'],
      [/\b(find|found|finding)\b/gi, '找到'],
      [/\b(check|checking|verify|verifying)\b/gi, '检查'],
      [/\b(use|using|utilize)\b/gi, '使用'],
      [/\b(call|calling|invoke|invoking)\b/gi, '调用'],
      [/\b(execute|executing|run|running)\b/gi, '执行'],
      [/\b(get|getting|fetch|fetching|retrieve|retrieving)\b/gi, '获取'],
      [/\b(process|processing|handle|handling)\b/gi, '处理'],
      [/\b(try|trying|attempt|attempting)\b/gi, '尝试'],
      [/\b(need|needs|needed|require|required)\b/gi, '需要'],
      [/\b(want|wants|wanted|would like)\b/gi, '想要'],
      [/\b(help|helping|assist|assisting)\b/gi, '帮助'],
      [/\b(provide|providing|give|giving)\b/gi, '提供'],
      [/\b(create|creating|make|making)\b/gi, '创建'],
      [/\b(update|updating|modify|modifying)\b/gi, '更新'],
      [/\b(delete|deleting|remove|removing)\b/gi, '删除'],
      [/\b(add|adding|insert|inserting)\b/gi, '添加'],
      [/\b(now|currently|at the moment)\b/gi, '现在'],
      [/\b(here|this|that|these|those)\b/gi, '这个'],
      [/\b(user|users)\b/gi, '用户'],
      [/\b(file|files)\b/gi, '文件'],
      [/\b(data|information)\b/gi, '数据'],
      [/\b(result|results|output|outputs)\b/gi, '结果'],
      [/\b(error|errors|issue|issues|problem|problems)\b/gi, '错误'],
      [/\b(success|successful|successfully|done|completed)\b/gi, '成功'],
      [/\b(fail|failed|failure|failing)\b/gi, '失败'],
      [/\b(wait|waiting|pending)\b/gi, '等待'],
      [/\b(continue|continuing|proceed|proceeding)\b/gi, '继续'],
      [/\b(start|starting|begin|beginning)\b/gi, '开始'],
      [/\b(stop|stopping|end|ending|finish|finishing)\b/gi, '结束'],
      [/\b(ok|okay|alright|got it|understood)\b/gi, '好的'],
      [/\b(yes|yeah|yep|sure|of course)\b/gi, '是的'],
      [/\b(no|nope|not|don't|doesn't|didn't|won't|wouldn't|can't|cannot)\b/gi, '不'],
      [/\b(what|why|how|when|where|who|which)\b/gi, '什么'],
      [/\b(is|are|was|were|be|been|being)\b/gi, '是'],
      [/\b(have|has|had|do|does|did|will|would|could|should|may|might|can)\b/gi, ''],
      [/\b(the|a|an|this|that|these|those|my|your|his|her|its|our|their)\b/gi, ''],
      [/\b(and|or|but|so|yet|for|nor)\b/gi, ''],
      [/\b(to|of|in|on|at|by|with|from|as|into|through|during|before|after|above|below|between|under|over)\b/gi, ''],
      [/\b(it|its|it's|he|him|his|she|her|they|them|their|we|us|our|you|your|I|me|my|mine)\b/gi, ''],
    ];

    let result = text;
    for (const [pattern, replacement] of replacements) {
      result = result.replace(pattern, replacement);
    }

    // Clean up extra spaces and empty parentheses
    result = result.replace(/\s+/g, ' ').trim();
    result = result.replace(/\(\s*\)/g, '');
    result = result.replace(/\[\s*\]/g, '');

    return result || text; // Fallback to original if translation empties the text
  }

  private async handleCommandExecuted(properties: {
    sessionID: string;
    name?: string;
    arguments?: string;
  }): Promise<void> {
    const chatId = this.sessionManager.getChatIdBySession(properties.sessionID);
    if (!chatId) return;

    const commandName = properties.name || 'unknown';
    const args = properties.arguments || '';
    log.info({ chatId, command: commandName, args }, 'Command executed');

    // Append a command notice to the session content so the user sees
    // feedback in the card (and the thinking animation stops).
    const notice = `⚡ 命令 \`/${commandName}\`${args ? ` \`${args}\`` : ''} 已执行`;
    this.sessionManager.appendContent(chatId, notice);
    await this.flushCard(chatId, { force: true });
  }

  /**
   * 合成并推送主流式卡片（一个 chat 对应一张持续更新的卡片）。
   * - 首次调用：sendCard 新建一张并记录 message_id
   * - 后续调用：throttle 到 UPDATE_THROTTLE_MS，改成 updateCard
   * - force=true 绕过节流（工具状态变化 / 最终完成）
   */
  private async flushCard(
    chatId: string,
    opts: { force?: boolean; done?: boolean } = {},
  ): Promise<void> {
    const session = this.sessionManager.getSession(chatId);
    if (!session) return;

    // When the user replied via card button, the confirmation card should stay
    // as-is. Skip flushCard updates so the AI streaming output doesn't overwrite
    // the confirmation state. The flag is cleared on session.idle.
    if (session.interactionReplied) {
      log.info({ chatId, targetMessageId: session.currentMessageId, done: opts.done }, 'flushCard skipped: interaction was handled via card');
      return;
    }

    // When a permission interaction is pending and the card is not yet finalised,
    // freeze card updates to avoid exhausting Feishu's PATCH budget. The user may
    // take a long time to click "Confirm" / "Always" / "Reject", and every Text
    // delta that triggers a flushCard counts against the ~10-15 PATCH limit.
    // Freezing here ensures the card remains modifiable when the user clicks.
    //
    // Allow force=true (initial permission card creation from handlePermissionAsked
    // and tool status transitions) and done=true (final session.idle flush) through.
    if (session.pendingInteraction?.kind === 'permission' && !opts.force && !opts.done) {
      log.info({ chatId, interactionKind: session.pendingInteraction.kind }, 'flushCard skipped: permission interaction pending');
      return;
    }

    // Capture target message ID at the start so concurrent flushCard calls
    // don't race against each other and update different messages.
    const targetMessageId = session.currentMessageId;
    const content = session.currentContent || '';
    const thinkingContent = this.shouldShowThinking() ? (session.thinkingContent || '') : '';
    const tools = this.shouldShowTools() ? (session.tools || []) : [];
    const interaction = session.pendingInteraction;
    log.info({ chatId, hasInteraction: !!interaction, interactionKind: interaction?.kind, targetMessageId, force: opts.force, done: opts.done }, 'flushCard');
    const card = FeishuCard.createStreamingCard({
      content,
      thinkingContent,
      tools,
      done: !!opts.done,
      retry: session.retryMessage,
      showProcess: this.showProcess,
      botName: this.botName,
      interaction,
      currentModel: session.currentModel,
      currentAgent: session.currentAgent,
      modelSelection: session.modelSelection,
      agentSelection: session.agentSelection,
    });

    if (!targetMessageId) {
      try {
        const message = await this.feishuApi.sendCard(chatId, card);
        if (message && message.message_id) {
          // Only set currentMessageId if it hasn't been set by another concurrent flushCard
          if (!session.currentMessageId) {
            this.sessionManager.setCurrentMessage(chatId, message.message_id);
            log.info({ chatId, messageId: message.message_id }, 'sendCard created new card');
          } else {
            log.info({ chatId, messageId: message.message_id, existingMessageId: session.currentMessageId }, 'sendCard created card but currentMessageId already set by concurrent flushCard');
          }
        }
      } catch (err) {
        log.error({ err }, 'Failed to create card');
      }
      return;
    }

    const now = Date.now();
    const lastUpdate = session.lastUpdateTime || 0;
    if (!opts.force && now - lastUpdate <= UPDATE_THROTTLE_MS) {
      log.info({ chatId, targetMessageId, elapsed: now - lastUpdate }, 'flushCard throttled');
      return;
    }

    // Update timestamp immediately to prevent concurrent flushCard calls
    // from all passing the throttle check while this one awaits updateCard.
    session.lastUpdateTime = now;

    try {
      const updated = await this.feishuApi.updateCard(targetMessageId, card);
      if (updated) {
        log.info({ chatId, targetMessageId }, 'updateCard success');
      } else if (opts.done) {
        log.warn({ chatId, targetMessageId }, 'updateCard rate-limited on final update, falling back to sendCard');
        const newMsg = await this.feishuApi.sendCard(chatId, card);
        if (newMsg?.message_id) {
          this.sessionManager.setCurrentMessage(chatId, newMsg.message_id);
          log.info({ chatId, newMessageId: newMsg.message_id }, 'Fallback sendCard for final state');
        }
      }
    } catch (err) {
      log.error({ err }, 'Failed to update card');
      if (opts.done) {
        try {
          log.warn({ chatId, targetMessageId }, 'updateCard errored on final update, falling back to sendCard');
          const newMsg = await this.feishuApi.sendCard(chatId, card);
          if (newMsg?.message_id) {
            this.sessionManager.setCurrentMessage(chatId, newMsg.message_id);
          }
        } catch (sendErr) {
          log.error({ err: sendErr }, 'Fallback sendCard also failed');
        }
      }
    }
  }
}
