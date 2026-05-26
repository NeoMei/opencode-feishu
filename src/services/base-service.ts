import type { FeishuAPI } from '../feishu/api.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('BaseService');

/**
 * Base service class for all Feishu service implementations.
 * Provides common functionality and error handling.
 */
export abstract class BaseService {
  protected api: FeishuAPI;

  constructor(api: FeishuAPI) {
    this.api = api;
  }

  /**
   * Wrap an API call with consistent error handling and logging.
   */
  protected async call<T>(
    operation: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      log.info({ operation }, `Executing ${operation}`);
      const result = await fn();
      log.info({ operation }, `${operation} succeeded`);
      return result;
    } catch (err) {
      log.error({ err, operation }, `${operation} failed`);
      throw err;
    }
  }

  /**
   * Validate that a required parameter is not empty.
   */
  protected validateRequired(param: string | undefined, name: string): void {
    if (!param || param.trim() === '') {
      throw new Error(`${name} is required`);
    }
  }

  /**
   * Build pagination parameters.
   */
  protected buildPagination(pageSize?: number, pageToken?: string): Record<string, any> {
    const params: Record<string, any> = {};
    if (pageSize) params.page_size = pageSize;
    if (pageToken) params.page_token = pageToken;
    return params;
  }
}
