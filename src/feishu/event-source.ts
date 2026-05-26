import { EventEmitter } from 'events';
import * as Lark from '@larksuiteoapi/node-sdk';
import type { FeishuAPI } from './api.js';
import type { FeishuMessage, FeishuCardAction } from '../core/types.js';
import { createLogger } from '../core/logger.js';
import { silentLogger } from './silent-logger.js';

const log = createLogger('FeishuEventSource');

/**
 * Parse raw card.action.trigger event data into a normalized FeishuCardAction.
 * Matches the shape produced by Lark SDK's normalizeCardAction().
 */
function parseCardAction(event: any): FeishuCardAction | null {
  const messageId = event.context?.open_message_id ?? event.open_message_id;
  const chatId = event.context?.open_chat_id ?? event.open_chat_id;
  const operatorOpenId = event.operator?.open_id;
  if (!messageId || !chatId || !operatorOpenId) {
    return null;
  }
  return {
    messageId,
    chatId,
    operator: {
      openId: operatorOpenId,
      userId: event.operator?.user_id,
      name: event.operator?.name,
    },
    action: {
      value: event.action?.value,
      tag: event.action?.tag ?? 'unknown',
      name: event.action?.name,
      option: event.action?.option,
    },
  };
}

/**
 * Long-connection event source backed by Lark.WSClient.
 *
 * Emits `message` (FeishuMessage) for every `im.message.receive_v1` event.
 * Emits `cardAction` (FeishuCardAction) for every `card.action.trigger` event.
 * Emits `error` on fatal WSClient errors. Reconnection is handled internally
 * by the SDK (autoReconnect=true, ping/pong loop, exponential backoff).
 */
export class FeishuEventSource extends EventEmitter {
  private wsClient?: Lark.WSClient;
  private api: FeishuAPI;
  private started = false;

  constructor(api: FeishuAPI) {
    super();
    this.api = api;
  }

  async connect(): Promise<void> {
    if (this.started) {
      log.warn('Already started');
      return;
    }

    const { appId, appSecret, domain } = this.api.getCredentials();
    this.wsClient = new Lark.WSClient({
      appId,
      appSecret,
      domain,
      logger: silentLogger,
      autoReconnect: true,
    });

    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        // Adapt SDK event payload → FeishuMessage shape expected by MessageHandler:
        // SDK splits sender and message at top level; our MessageHandler expects
        // sender to live inside the message object.
        const message = {
          ...data.message,
          sender: data.sender,
        } as unknown as FeishuMessage;
        this.emit('message', message);
        return { ok: true };
      },
      'card.action.trigger': async (data: any) => {
        const action = parseCardAction(data);
        if (!action) {
          log.warn({ data }, 'Failed to parse card action event');
          return { toast: { type: 'error', content: '无效的操作' } };
        }
        log.info({ chatId: action.chatId, messageId: action.messageId, tag: action.action.tag }, 'Card action triggered');
        // Hand off to the listener (MessageHandler). The return value from
        // the listener is propagated back to Feishu as the card callback response.
        const result = await this.emitCardAction(action);
        const response = result ?? { toast: { type: 'success', content: '已处理' } };
        // Feishu card callback requires { type: "raw", data: { ...card } } wrapper
        if (response.card && typeof response.card === 'object' && !response.card.type) {
          response.card = { type: 'raw', data: response.card };
        }
        return response;
      },
      // Suppress SDK warnings for events we intentionally don't handle
      'im.chat.access_event.bot_p2p_chat_entered_v1': async () => ({ ok: true }),
      'im.message.message_read_v1': async () => ({ ok: true }),
    });

    // WSClient.start() resolves when the WS connection is established.
    // Any connection failure beyond the first attempt is handled by autoReconnect.
    try {
      await this.wsClient.start({ eventDispatcher: dispatcher });
      this.started = true;
      log.info('Started (WSClient long connection)');
    } catch (err) {
      this.wsClient = undefined;
      log.error({ err }, 'Failed to start WSClient');
      throw err;
    }
  }

  /**
   * Emit cardAction and await the first listener's return value.
   * This lets us propagate the card callback response back to Feishu.
   */
  private async emitCardAction(action: FeishuCardAction): Promise<any> {
    const listeners = this.listeners('cardAction');
    if (listeners.length === 0) {
      log.warn('No cardAction listener registered');
      return undefined;
    }
    // Await the first listener; EventEmitter normally ignores async returns,
    // but the EventDispatcher.invoke() caller awaits our handler return.
    return (listeners[0] as any)(action);
  }

  async disconnect(): Promise<void> {
    if (!this.wsClient) return;
    try {
      this.wsClient.close({ force: true });
    } catch (err) {
      log.warn({ err }, 'Close error');
    }
    this.wsClient = undefined;
    this.started = false;
    log.info('Disconnected');
  }

  isConnected(): boolean {
    return this.started;
  }
}
