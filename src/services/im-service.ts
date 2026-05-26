import { BaseService } from './base-service.js';
import type { FeishuAPI } from '../feishu/api.js';
import type { FeishuMessage, MessageReplyOptions, MessageSearchResult, ResourceDownloadResult } from '../types/extended.js';

/**
 * IM (Instant Messaging) Service
 * Provides message operations: send, reply, search, download resources
 */
export class IMService extends BaseService {
  constructor(api: FeishuAPI) {
    super(api);
  }

  /**
   * Send a text message to a chat.
   */
  async sendTextMessage(chatId: string, text: string): Promise<FeishuMessage> {
    this.validateRequired(chatId, 'chatId');
    this.validateRequired(text, 'text');

    return this.call('sendTextMessage', () =>
      this.api.sendText(chatId, text),
    );
  }

  /**
   * Send an interactive card to a chat.
   */
  async sendCardMessage(chatId: string, card: any): Promise<FeishuMessage> {
    this.validateRequired(chatId, 'chatId');

    return this.call('sendCardMessage', () =>
      this.api.sendCard(chatId, card),
    );
  }

  /**
   * Send a post (rich text) message to a chat.
   * Supports text, links, mentions, images in one message.
   */
  async sendPostMessage(
    chatId: string,
    title: string,
    content: Array<{ tag: 'text' | 'a' | 'at'; text?: string; href?: string; user_id?: string }>,
  ): Promise<FeishuMessage> {
    this.validateRequired(chatId, 'chatId');

    return this.call('sendPostMessage', async () => {
      const client = this.api.getClient();

      const res = await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'post',
          content: JSON.stringify({
            post: {
              zh_cn: {
                title,
                content: [content],
              },
            },
          }),
        },
      });

      if (res.code !== 0) {
        throw new Error(`Failed to send post message: ${res.msg || 'Unknown error'}`);
      }

      return res.data as unknown as FeishuMessage;
    });
  }

  /**
   * Send a document link as an interactive card.
   * Displays document title, description, and a clickable button.
   */
  async sendDocumentCard(
    chatId: string,
    docInfo: {
      title: string;
      url: string;
      description?: string;
      docType?: 'doc' | 'docx' | 'wiki' | 'sheet';
    },
  ): Promise<FeishuMessage> {
    this.validateRequired(chatId, 'chatId');
    this.validateRequired(docInfo.title, 'title');
    this.validateRequired(docInfo.url, 'url');

    return this.call('sendDocumentCard', async () => {
      const iconMap: Record<string, string> = {
        doc: '📄',
        docx: '📝',
        wiki: '📚',
        sheet: '📊',
      };

      const card = {
        config: { wide_screen_mode: true },
        header: {
          template: 'blue' as const,
          title: {
            tag: 'plain_text' as const,
            content: `${iconMap[docInfo.docType || 'doc']} ${docInfo.title}`,
          },
        },
        elements: [
          ...(docInfo.description
            ? [
                {
                  tag: 'div',
                  text: {
                    tag: 'lark_md',
                    content: docInfo.description,
                  },
                },
              ]
            : []),
          {
            tag: 'action',
            actions: [
              {
                tag: 'button',
                text: {
                  tag: 'plain_text',
                  content: '查看文档',
                },
                type: 'primary',
                url: docInfo.url,
              },
            ],
          },
        ],
      };

      return this.api.sendCard(chatId, card);
    });
  }

  /**
   * Reply to a specific message.
   * Supports replying in thread.
   */
  async replyMessage(options: MessageReplyOptions): Promise<FeishuMessage> {
    this.validateRequired(options.chatId, 'chatId');
    this.validateRequired(options.content, 'content');

    return this.call('replyMessage', async () => {
      const client = this.api.getClient();

      const data: { receive_id: string; msg_type: string; content: string; root_id?: string } = {
        receive_id: options.chatId,
        msg_type: options.msgType || 'text',
        content: JSON.stringify({ text: options.content }),
      };

      if (options.replyInThread && options.rootId) {
        data.root_id = options.rootId;
      }

      const res = await client.im.v1.message.create({
        params: {
          receive_id_type: 'chat_id'
        },
        data,
      });

      if (res.code !== 0) {
        throw new Error(`Failed to reply message: ${res.msg || 'Unknown error'}`);
      }

      return res.data as unknown as FeishuMessage;
    });
  }

  /**
   * Search messages in a chat or globally.
   */
  async searchMessages(query: string, options?: {
    chatId?: string;
    pageSize?: number;
    pageToken?: string;
  }): Promise<MessageSearchResult> {
    this.validateRequired(query, 'query');

    return this.call('searchMessages', async () => {
      const client = this.api.getClient();
      
      const params: Record<string, any> = {
        query,
        ...this.buildPagination(options?.pageSize || 20, options?.pageToken),
      };

      if (options?.chatId) {
        params.chat_id = options.chatId;
      }

      const res: any = await client.request({
        method: 'GET',
        url: '/open-apis/im/v1/messages',
        params,
      });

      if (res.code !== 0) {
        throw new Error(`Failed to search messages: ${res.msg || 'Unknown error'}`);
      }

      const data = res.data || {};
      return {
        messages: (data.items || []) as unknown as FeishuMessage[],
        hasMore: data.has_more || false,
        pageToken: data.page_token,
      };
    });
  }

  /**
   * Download a resource (image/file) from a message.
   * Supports range requests for large files.
   */
  async downloadResource(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file',
    outputPath?: string,
  ): Promise<ResourceDownloadResult> {
    this.validateRequired(messageId, 'messageId');
    this.validateRequired(fileKey, 'fileKey');

    return this.call('downloadResource', async () => {
      const buffer = await this.api.downloadMedia(messageId, fileKey, type);
      
      // Generate output path if not provided
      const finalPath = outputPath || `${Date.now()}_${fileKey}`;
      
      // Save to file system (using FileDownloader)
      const { FileDownloader } = await import('../core/file-downloader.js');
      const downloader = new FileDownloader();
      const result = await downloader.saveBuffer(
        buffer,
        finalPath,
        type === 'image' ? 'image/jpeg' : 'application/octet-stream',
      );

      return {
        filePath: result.filePath,
        fileName: result.fileName,
        mimeType: result.mimeType,
        size: buffer.length,
      };
    });
  }

  /**
   * Get message history for a chat.
   */
  async getMessageHistory(chatId: string, options?: {
    pageSize?: number;
    pageToken?: string;
  }): Promise<MessageSearchResult> {
    this.validateRequired(chatId, 'chatId');

    return this.call('getMessageHistory', async () => {
      const client = this.api.getClient();
      
      const res: any = await client.request({
        method: 'GET',
        url: '/open-apis/im/v1/messages',
        params: {
          container_id_type: 'chat',
          container_id: chatId,
          ...this.buildPagination(options?.pageSize || 20, options?.pageToken),
        },
      });

      if (res.code !== 0) {
        throw new Error(`Failed to get message history: ${res.msg || 'Unknown error'}`);
      }

      const data = res.data || {};
      return {
        messages: (data.items || []) as unknown as FeishuMessage[],
        hasMore: data.has_more || false,
        pageToken: data.page_token,
      };
    });
  }
}
