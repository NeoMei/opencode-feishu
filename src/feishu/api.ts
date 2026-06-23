import * as Lark from '@larksuiteoapi/node-sdk';
import type { FeishuConfig, FeishuMessage, CardContent } from '../core/types.js';
import { resolveAppSecret } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { silentLogger } from './silent-logger.js';

const log = createLogger('FeishuAPI');

interface UserNameCacheEntry {
  name: string;
  timestamp: number;
}

const USERNAME_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const USERNAME_CACHE_MAX_SIZE = 10000; // Prevent unbounded growth

export class FeishuAPI {
  private client: Lark.Client;
  private appId: string;
  private appSecret: string;
  private domain: Lark.Domain;
  private botOpenId?: string;
  private userNameCache = new Map<string, UserNameCacheEntry>();

  constructor(config: FeishuConfig) {
    this.appId = config.appId;
    this.appSecret = resolveAppSecret(config);
    this.domain = config.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu;

    this.client = new Lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: this.domain,
      logger: silentLogger,
    });
  }

  async initialize(): Promise<void> {
    try {
      const res: any = await this.client.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      });
      // Feishu returns {code, msg, bot:{open_id,...}} at top level for this endpoint
      const openId: string | undefined = res?.bot?.open_id || res?.data?.bot?.open_id;
      if (openId) {
        this.botOpenId = openId;
        log.info({ openId }, 'Bot open_id resolved');
      } else {
        log.warn('Could not resolve bot open_id from /bot/v3/info');
      }
    } catch (err) {
      log.warn({ err }, 'Failed to fetch bot info');
    }
  }

  /** SDK client — exposed so FeishuEventSource can mount WSClient on the same credentials. */
  getClient(): Lark.Client {
    return this.client;
  }

  getCredentials(): { appId: string; appSecret: string; domain: Lark.Domain } {
    return { appId: this.appId, appSecret: this.appSecret, domain: this.domain };
  }

  getBotOpenId(): string | undefined {
    return this.botOpenId;
  }

  /** 获取 tenant access token，用于原生 HTTP 调用绕过 SDK 编码问题 */
  private async getToken(): Promise<string> {
    const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: this.appId,
        app_secret: this.appSecret,
      }),
    });
    if (!res.ok) throw new Error(`Failed to get token: HTTP ${res.status}`);
    const data: any = await res.json();
    if (data.code !== 0) throw new Error(`Token API error: ${data.msg}`);
    return data.tenant_access_token;
  }

  async sendText(chatId: string, text: string): Promise<FeishuMessage> {
    const res = await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
    log.info({ resCode: res.code, resMsg: res.msg, hasData: !!res.data, messageId: res.data?.message_id }, 'sendText response');
    if (res.code !== 0) {
      throw new Error(`Failed to send text: ${res.msg || 'Unknown error'}`);
    }
    if (!res.data?.message_id) {
      throw new Error('sendText returned invalid data: missing message_id');
    }
    return res.data as unknown as FeishuMessage;
  }

  async sendCard(chatId: string, card: CardContent): Promise<FeishuMessage> {
    const res = await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });
    log.info({ resCode: res.code, resMsg: res.msg, hasData: !!res.data, messageId: res.data?.message_id }, 'sendCard response');
    if (res.code !== 0) {
      throw new Error(`Failed to send card: ${res.msg || 'Unknown error'}`);
    }
    if (!res.data?.message_id) {
      throw new Error('sendCard returned invalid data: missing message_id');
    }
    return res.data as unknown as FeishuMessage;
  }

  async updateCard(messageId: string, card: CardContent): Promise<boolean> {
    try {
      const res = await this.client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });
      log.info({ resCode: res.code, resMsg: res.msg, messageId }, 'updateCard response');
        if (res.code !== 0) {
        // 230020 = "Update the single messages too frequently".
        // 200340 = "MessageNotPersisted" — card has been patched too many times.
        // Return false so caller can fall back to sendCard for critical updates.
        if (res.code === 230020 || res.code === 200340) {
          log.warn({ resCode: res.code, resMsg: res.msg, messageId }, 'updateCard hit limit, returning false');
          return false;
        }
        throw new Error(`Failed to update message: ${res.msg || 'Unknown error'}`);
      }
      return true;
    } catch (err: any) {
      // The SDK throws AxiosError on HTTP 4xx; Feishu encodes the code in the body.
      const code = err?.response?.data?.code;
      if (code === 230020 || code === 200340) {
        log.warn({ code, messageId }, 'updateCard hit limit, returning false');
        return false;
      }
      throw err;
    }
  }

  /**
   * Get user name by user_id with 24h cache.
   * Falls back to user_id if the API call fails.
   */
  async getUserName(userId: string): Promise<string> {
    const now = Date.now();
    const cached = this.userNameCache.get(userId);
    if (cached && now - cached.timestamp < USERNAME_CACHE_TTL_MS) {
      return cached.name;
    }

    try {
      const res: any = await this.client.request({
        method: 'GET',
        url: '/open-apis/contact/v3/users/' + userId,
        params: { user_id_type: 'union_id' },
      });
      const name = res?.data?.user?.name || userId;
      // Evict oldest entries when cache exceeds max size
      if (this.userNameCache.size >= USERNAME_CACHE_MAX_SIZE) {
        const oldest = [...this.userNameCache.entries()]
          .sort((a, b) => a[1].timestamp - b[1].timestamp)
          .slice(0, Math.floor(USERNAME_CACHE_MAX_SIZE * 0.1))
          .map(e => e[0]);
        for (const key of oldest) this.userNameCache.delete(key);
      }
      this.userNameCache.set(userId, { name, timestamp: now });
      return name;
    } catch (err) {
      log.warn({ err, userId }, 'Failed to fetch user name');
      return userId;
    }
  }

  /**
   * Download media (image, file, audio, video) from Feishu message resources.
   * Uses the correct Feishu API: /open-apis/im/v1/messages/{message_id}/resources/{file_key}
   * Returns the raw Buffer.
   */
  async downloadMedia(messageId: string, fileKey: string, type: 'image' | 'file'): Promise<Buffer> {
    try {
      log.info({ messageId, fileKey, type }, 'Downloading media from Feishu');
      
      // 用原生 fetch 绕过 Lark SDK 的二进制响应编码问题
      // SDK 的 client.request() 对 type=file 会损坏二进制数据
      try {
        const token = await this.getToken();
        const apiUrl = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=${type}`;
        const response = await fetch(apiUrl, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        log.info({ size: buffer.length }, 'Downloaded via direct fetch');
        return buffer;
      } catch (fetchErr) {
        log.warn({ fetchErr }, 'Direct fetch failed, falling back to SDK');
      }
      const res: any = await this.client.request({
        method: 'GET',
        url: `/open-apis/im/v1/messages/${messageId}/resources/${fileKey}`,
        params: { type },
      });
      
      // For binary responses, the SDK might return the data directly
      if (Buffer.isBuffer(res)) {
        return res;
      }
      
      // Check if response is a string (binary data as string)
      if (typeof res === 'string') {
        return Buffer.from(res, 'binary');
      }
      
      // Check if response has data field
      if (res.data) {
        // If data is a buffer
        if (Buffer.isBuffer(res.data)) {
          return res.data;
        }
        // If data is a string (binary data as string)
        if (typeof res.data === 'string') {
          return Buffer.from(res.data, 'binary');
        }
        // If data contains a URL
        if (typeof res.data === 'object') {
          const downloadUrl = res.data.url || res.data.file_url || res.data.image_url;
          if (downloadUrl) {
            const response = await fetch(downloadUrl);
            if (!response.ok) {
              throw new Error(`Failed to fetch media from URL: ${response.status}`);
            }
            return Buffer.from(await response.arrayBuffer());
          }
        }
      }
      
      // If the response itself might be binary data
      if (res && typeof res === 'object') {
        // Try to extract binary data from response
        const responseData = res.data || res.body || res;
        if (Buffer.isBuffer(responseData)) {
          return responseData;
        }
        if (typeof responseData === 'string') {
          return Buffer.from(responseData, 'binary');
        }
      }
      
      throw new Error(`Unexpected response format from media download: ${typeof res}`);
    } catch (err) {
      log.error({ err, messageId, fileKey, type }, 'Failed to download media');
      throw err;
    }
  }

  /**
   * Upload an image (JPEG/PNG/GIF/WEBP) to Feishu and return its image_key.
   * The image_key can be used in card `img` elements.
   */
  async uploadImage(imageBuffer: Buffer): Promise<string> {
    const res = await this.client.im.v1.image.create({
      data: {
        image_type: 'message',
        image: imageBuffer,
      },
    });
    if (!res?.image_key) {
      throw new Error('Image upload failed: no image_key returned');
    }
    log.info({ imageKey: res.image_key }, 'Image uploaded');
    return res.image_key;
  }

  /**
   * Upload a file to Feishu and return its file_key.
   * Uses native fetch because the SDK's client.request() does not support
   * multipart/form-data (it serialises FormData as an empty JSON object {}).
   */
  async uploadFile(buffer: Buffer, fileName: string, mimeType: string): Promise<string> {
    // Force token refresh before upload to avoid expired token issues
    const tokenManager = (this.client as any).tokenManager;
    if (tokenManager?.getTenantAccessToken) {
      await tokenManager.getTenantAccessToken();
    }
    const token = await tokenManager?.getTenantAccessToken();
    if (!token) {
      throw new Error('Failed to obtain tenant access token for file upload');
    }

    const domainUrl = this.domain === Lark.Domain.Lark
      ? 'https://open.larksuite.com'
      : 'https://open.feishu.cn';

    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimeType }), fileName);
    form.append('file_name', fileName);

    const res = await fetch(`${domainUrl}/open-apis/im/v1/files`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: form,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`File upload failed: ${res.status} ${text}`);
    }

    const data: any = await res.json();
    if (data.code !== 0) {
      throw new Error(`File upload failed: ${data.msg || 'Unknown error'}`);
    }

    const fileKey = data.data?.file_key;
    if (!fileKey) {
      throw new Error('File upload failed: no file_key returned');
    }

    log.info({ fileKey, fileName }, 'File uploaded');
    return fileKey;
  }
}
