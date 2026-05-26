import { BaseService } from './base-service.js';
import type { FeishuAPI } from '../feishu/api.js';
import type { ChatInfo, ChatSearchResult, ChatMember } from '../types/extended.js';

/**
 * Chat/Group Service
 * Provides chat operations: search, create, manage members
 */
export class ChatService extends BaseService {
  constructor(api: FeishuAPI) {
    super(api);
  }

  /**
   * Search for chats by keyword.
   */
  async searchChats(
    query: string,
    options?: {
      searchTypes?: string[];
      memberIds?: string[];
      pageSize?: number;
      pageToken?: string;
    },
  ): Promise<ChatSearchResult> {
    this.validateRequired(query, 'query');

    return this.call('searchChats', async () => {
      const client = this.api.getClient();

      const res: any = await client.request({
        method: 'POST',
        url: '/open-apis/im/v1/chats/search',
        data: {
          query,
          ...(options?.searchTypes ? { search_types: options.searchTypes } : {}),
          ...(options?.memberIds ? { member_ids: options.memberIds } : {}),
          ...this.buildPagination(options?.pageSize || 20, options?.pageToken),
        },
      });

      if (res.code !== 0) {
        throw new Error(`Failed to search chats: ${res.msg || 'Unknown error'}`);
      }

      const data = res.data || {};
      const chats = (data.items || []).map((chat: any) => ({
        chatId: chat.chat_id,
        name: chat.name,
        description: chat.description,
        ownerId: chat.owner_id,
        memberCount: chat.member_count,
        chatType: chat.chat_type,
        createTime: chat.create_time,
      }));

      return {
        chats,
        hasMore: data.has_more || false,
        pageToken: data.page_token,
      };
    });
  }

  /**
   * Get chat info by ID.
   */
  async getChatInfo(chatId: string): Promise<ChatInfo> {
    this.validateRequired(chatId, 'chatId');

    return this.call('getChatInfo', async () => {
      const client = this.api.getClient();

      const res: any = await client.im.v1.chat.get({
        path: { chat_id: chatId },
      });

      if (res.code !== 0) {
        throw new Error(`Failed to get chat info: ${res.msg || 'Unknown error'}`);
      }

      const data = res.data || {};
      return {
        chatId: data.chat_id,
        name: data.name,
        description: data.description,
        ownerId: data.owner_id,
        memberCount: data.member_count,
        chatType: data.chat_type,
        createTime: data.create_time,
      };
    });
  }

  /**
   * Create a new chat/group.
   */
  async createChat(options: {
    name: string;
    description?: string;
    memberIds?: string[];
    chatType?: 'group' | 'p2p';
  }): Promise<ChatInfo> {
    this.validateRequired(options.name, 'name');

    return this.call('createChat', async () => {
      const client = this.api.getClient();

      const res: any = await client.im.v1.chat.create({
        data: {
          name: options.name,
          description: options.description,
          ...(options.memberIds ? { user_id_list: options.memberIds } : {}),
          chat_type: options.chatType || 'group',
        },
      });

      if (res.code !== 0) {
        throw new Error(`Failed to create chat: ${res.msg || 'Unknown error'}`);
      }

      const data = res.data || {};
      return {
        chatId: data.chat_id,
        name: options.name,
        description: options.description,
        chatType: options.chatType || 'group',
      };
    });
  }

  /**
   * Get chat members.
   */
  async getChatMembers(
    chatId: string,
    options?: {
      pageSize?: number;
      pageToken?: string;
    },
  ): Promise<{ members: ChatMember[]; hasMore: boolean; pageToken?: string }> {
    this.validateRequired(chatId, 'chatId');

    return this.call('getChatMembers', async () => {
      const client = this.api.getClient();

      const res: any = await client.im.v1.chatMembers.get({
        path: { chat_id: chatId },
        params: this.buildPagination(options?.pageSize || 100, options?.pageToken),
      });

      if (res.code !== 0) {
        throw new Error(`Failed to get chat members: ${res.msg || 'Unknown error'}`);
      }

      const data = res.data || {};
      const members = (data.items || []).map((member: any) => ({
        openId: member.member_id,
        userId: member.user_id,
        name: member.name,
        role: member.role,
      }));

      return {
        members,
        hasMore: data.has_more || false,
        pageToken: data.page_token,
      };
    });
  }

  /**
   * Add members to a chat.
   */
  async addChatMembers(chatId: string, memberIds: string[]): Promise<void> {
    this.validateRequired(chatId, 'chatId');
    if (!memberIds || memberIds.length === 0) {
      throw new Error('memberIds cannot be empty');
    }

    return this.call('addChatMembers', async () => {
      const client = this.api.getClient();

      const res: any = await client.im.v1.chatMembers.create({
        path: { chat_id: chatId },
        data: {
          id_list: memberIds,
        },
      });

      if (res.code !== 0) {
        throw new Error(`Failed to add chat members: ${res.msg || 'Unknown error'}`);
      }
    });
  }

  /**
   * Remove members from a chat.
   */
  async removeChatMembers(chatId: string, memberIds: string[]): Promise<void> {
    this.validateRequired(chatId, 'chatId');
    if (!memberIds || memberIds.length === 0) {
      throw new Error('memberIds cannot be empty');
    }

    return this.call('removeChatMembers', async () => {
      const client = this.api.getClient();

      const res: any = await client.im.v1.chatMembers.delete({
        path: { chat_id: chatId },
        data: {
          id_list: memberIds,
        },
      });

      if (res.code !== 0) {
        throw new Error(`Failed to remove chat members: ${res.msg || 'Unknown error'}`);
      }
    });
  }
}
