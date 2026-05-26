import { BaseService } from './base-service.js';
import type { FeishuAPI } from '../feishu/api.js';
import type { UserInfo, UserSearchResult } from '../types/extended.js';

/**
 * Contact/ User Service
 * Provides user operations: search, get info, department query
 */
export class ContactService extends BaseService {
  constructor(api: FeishuAPI) {
    super(api);
  }

  /**
   * Search users by keyword (name, email, phone).
   */
  async searchUsers(
    query: string,
    options?: {
      pageSize?: number;
      pageToken?: string;
    },
  ): Promise<UserSearchResult> {
    this.validateRequired(query, 'query');

    return this.call('searchUsers', async () => {
      const client = this.api.getClient();

      const res: any = await client.request({
        method: 'POST',
        url: '/open-apis/contact/v3/users/batch_get_id',
        data: {
          query,
          ...this.buildPagination(options?.pageSize || 20, options?.pageToken),
        },
      });

      if (res.code !== 0) {
        // Try alternative search endpoint
        const searchRes: any = await client.request({
          method: 'GET',
          url: '/open-apis/contact/v3/users',
          params: {
            query,
            ...this.buildPagination(options?.pageSize || 20, options?.pageToken),
          },
        });

        if (searchRes.code !== 0) {
          throw new Error(`Failed to search users: ${searchRes.msg || res.msg || 'Unknown error'}`);
        }

        const data = searchRes.data || {};
        return {
          users: (data.items || []).map((user: any) => this.parseUser(user)),
          hasMore: data.has_more || false,
          pageToken: data.page_token,
        };
      }

      const data = res.data || {};
      return {
        users: (data.user_list || []).map((user: any) => this.parseUser(user)),
        hasMore: false,
      };
    });
  }

  /**
   * Get user info by ID.
   */
  async getUserInfo(userId: string): Promise<UserInfo> {
    this.validateRequired(userId, 'userId');

    return this.call('getUserInfo', async () => {
      const client = this.api.getClient();

      const res: any = await client.contact.v3.user.get({
        path: { user_id: userId },
        params: { user_id_type: 'open_id' },
      });

      if (res.code !== 0) {
        throw new Error(`Failed to get user info: ${res.msg || 'Unknown error'}`);
      }

      return this.parseUser(res.data?.user);
    });
  }

  /**
   * Get current bot info.
   */
  async getBotInfo(): Promise<{ openId: string; name: string }> {
    return this.call('getBotInfo', async () => {
      const client = this.api.getClient();

      const res: any = await client.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      });

      if (res.code !== 0) {
        throw new Error(`Failed to get bot info: ${res.msg || 'Unknown error'}`);
      }

      return {
        openId: res.data?.bot?.open_id,
        name: res.data?.bot?.app_name || 'Bot',
      };
    });
  }

  /**
   * Get user list by department.
   */
  async getDepartmentUsers(
    departmentId: string,
    options?: {
      pageSize?: number;
      pageToken?: string;
    },
  ): Promise<UserSearchResult> {
    this.validateRequired(departmentId, 'departmentId');

    return this.call('getDepartmentUsers', async () => {
      const client = this.api.getClient();

      const res: any = await client.contact.v3.user.findByDepartment({
        params: {
          department_id_type: 'open_department_id',
          department_id: departmentId,
          ...this.buildPagination(options?.pageSize || 50, options?.pageToken),
        },
      });

      if (res.code !== 0) {
        throw new Error(`Failed to get department users: ${res.msg || 'Unknown error'}`);
      }

      const data = res.data || {};
      return {
        users: (data.items || []).map((user: any) => this.parseUser(user)),
        hasMore: data.has_more || false,
        pageToken: data.page_token,
      };
    });
  }

  /**
   * Parse user object from API response.
   */
  private parseUser(user: any): UserInfo {
    if (!user) {
      return {
        openId: '',
        name: 'Unknown',
      };
    }

    return {
      openId: user.open_id || user.union_id || '',
      unionId: user.union_id,
      userId: user.user_id,
      name: user.name || user.en_name || 'Unknown',
      enName: user.en_name,
      email: user.email,
      mobile: user.mobile,
      avatar: user.avatar?.avatar_origin,
      department: user.department_name,
      tenantKey: user.tenant_key,
    };
  }
}
