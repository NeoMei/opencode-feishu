import { BaseService } from './base-service.js';
import type { FeishuAPI } from '../feishu/api.js';
import { createLogger } from '../core/logger.js';
import type {
  DocumentInfo,
  DocumentContent,
  DocumentSearchResult,
  ResourceUploadResult,
  FeishuMessage
} from '../types/extended.js';

const log = createLogger('DocService');

/**
 * Document Service
 * Provides document operations: create, read, search, update
 * Uses Feishu SDK semantic methods where available.
 */
export class DocService extends BaseService {
  constructor(api: FeishuAPI) {
    super(api);
  }

  /**
   * Create a new blank docx document.
   */
  async createDocument(options: {
    title?: string;
    parentToken?: string;
  }): Promise<{ documentId: string; revisionId: number; url: string; title: string }> {
    return this.call('createDocument', async () => {
      const client = this.api.getClient();

      const res: any = await client.docx.v1.document.create({
        data: {
          folder_token: options.parentToken,
        },
      });

      if (res.code !== 0) {
        throw new Error(`Failed to create document: ${res.msg || 'Unknown error'} (code: ${res.code})`);
      }

      const doc = res.data?.document;

      return {
        documentId: doc.document_id,
        revisionId: doc.revision_id,
        // Feishu CN docs are hosted at www.feishu.cn, not open.feishu.cn
        url: doc.url || `https://www.feishu.cn/docx/${doc.document_id}`,
        title: options.title || doc.title || 'Untitled',
      };
    });
  }

  /**
   * Create a document from Markdown content.
   * Creates a blank document, then inserts parsed blocks via SDK.
   */
  async createDocumentFromMarkdown(
    title: string,
    markdown: string,
    options?: {
      parentToken?: string;
    },
  ): Promise<{ documentId: string; revisionId: number; url: string; title: string }> {
    this.validateRequired(title, 'title');
    this.validateRequired(markdown, 'markdown');

    // Step 1: Create a blank document
    const doc = await this.createDocument({
      title,
      parentToken: options?.parentToken,
    });

    // Step 2: Insert content under the document root block
    // The root block ID of a Feishu doc is the document_id itself
    try {
      await this.insertBlocks(doc.documentId, doc.documentId, `# ${title}\n\n${markdown}`, 'markdown');
    } catch (err) {
      log.warn({ err, documentId: doc.documentId }, 'Failed to insert content into document');
    }

    return doc;
  }

  /**
   * Fetch document content with support for detail levels and scopes.
   */
  async fetchDocument(
    docToken: string,
    options?: {
      detail?: 'simple' | 'with-ids' | 'full';
      scope?: 'outline' | 'section' | 'range' | 'keyword';
      docFormat?: 'xml' | 'markdown' | 'text';
      startBlockId?: string;
      endBlockId?: string;
      keyword?: string;
      maxDepth?: number;
    },
  ): Promise<DocumentContent> {
    this.validateRequired(docToken, 'docToken');

    return this.call('fetchDocument', async () => {
      const client = this.api.getClient();

      const params: Record<string, any> = {};

      if (options?.detail) {
        params.detail = options.detail;
      }

      if (options?.docFormat) {
        params.document_format = options.docFormat;
      }

      if (options?.scope) {
        params.scope = options.scope;

        if (options.scope === 'section' || options.scope === 'range') {
          if (options.startBlockId) {
            params.start_block_id = options.startBlockId;
          }
          if (options.scope === 'range' && options.endBlockId) {
            params.end_block_id = options.endBlockId;
          }
        }

        if (options.scope === 'keyword' && options.keyword) {
          params.keyword = options.keyword;
        }

        if (options.scope === 'outline' && options.maxDepth !== undefined) {
          params.max_depth = options.maxDepth;
        }
      }

      const res: any = await client.request({
        method: 'GET',
        url: `/open-apis/docx/v1/documents/${docToken}/content`,
        params,
      });

      if (res.code !== 0) {
        throw new Error(`Failed to fetch document: ${res.msg || 'Unknown error'} (code: ${res.code})`);
      }

      const data = res.data || {};
      return {
        documentId: docToken,
        title: data.title || 'Untitled',
        content: data.content,
        revisionId: data.revision_id,
      };
    });
  }

  /**
   * Get document outline (table of contents).
   */
  async getDocumentOutline(
    docToken: string,
    maxDepth?: number,
  ): Promise<Array<{ level: number; text: string; blockId: string }>> {
    const content = await this.fetchDocument(docToken, {
      scope: 'outline',
      maxDepth: maxDepth || 3,
      docFormat: 'xml',
    });

    const outline: Array<{ level: number; text: string; blockId: string }> = [];
    const headingRegex = /<h(\d)[^>]*id="([^"]+)"[^>]*>([^<]*)<\/h\d>/gi;
    let match;

    while ((match = headingRegex.exec(content.content || '')) !== null) {
      outline.push({
        level: parseInt(match[1], 10),
        text: match[3].trim(),
        blockId: match[2],
      });
    }

    return outline;
  }

  /**
   * Update a single block's content via SDK patch.
   */
  async patchBlock(
    docToken: string,
    blockId: string,
    blockData: any,
  ): Promise<void> {
    this.validateRequired(docToken, 'docToken');
    this.validateRequired(blockId, 'blockId');

    return this.call('patchBlock', async () => {
      const client = this.api.getClient();

      const res: any = await client.docx.v1.documentBlock.patch({
        path: {
          document_id: docToken,
          block_id: blockId,
        },
        data: blockData,
      });

      if (res.code !== 0) {
        throw new Error(`Failed to patch block: ${res.msg || 'Unknown error'} (code: ${res.code})`);
      }
    });
  }

  /**
   * Search documents in cloud space.
   */
  async searchDocuments(query: string, options?: {
    pageSize?: number;
    pageToken?: string;
    filters?: {
      docTypes?: string[];
      creatorIds?: string[];
      folderTokens?: string[];
      openTime?: { start?: string; end?: string };
      createTime?: { start?: string; end?: string };
      onlyTitle?: boolean;
      onlyComment?: boolean;
    };
  }): Promise<DocumentSearchResult> {
    this.validateRequired(query, 'query');

    return this.call('searchDocuments', async () => {
      const client = this.api.getClient();

      const body: Record<string, any> = {
        query,
        search_key: query,
        page_size: options?.pageSize || 20,
      };

      if (options?.pageToken) {
        body.page_token = options.pageToken;
      }

      const filters: Record<string, any> = {};

      if (options?.filters) {
        const f = options.filters;

        if (f.docTypes?.length) {
          filters.doc_types = f.docTypes;
        }

        if (f.creatorIds?.length) {
          filters.creator_ids = f.creatorIds;
        }

        if (f.folderTokens?.length) {
          filters.folder_tokens = f.folderTokens;
        }

        if (f.openTime) {
          filters.open_time = {};
          if (f.openTime.start) filters.open_time.start = new Date(f.openTime.start).getTime() / 1000;
          if (f.openTime.end) filters.open_time.end = new Date(f.openTime.end).getTime() / 1000;
        }

        if (f.createTime) {
          filters.create_time = {};
          if (f.createTime.start) filters.create_time.start = new Date(f.createTime.start).getTime() / 1000;
          if (f.createTime.end) filters.create_time.end = new Date(f.createTime.end).getTime() / 1000;
        }

        if (f.onlyTitle) {
          filters.only_title = true;
        }

        if (f.onlyComment) {
          filters.only_comment = true;
        }
      }

      if (Object.keys(filters).length > 0) {
        body.filter = filters;
      }

      const res: any = await client.request({
        method: 'POST',
        url: '/open-apis/search/v2/doc_wiki/search',
        data: body,
      });

      if (res.code !== 0) {
        throw new Error(`Failed to search documents: ${res.msg || 'Unknown error'}`);
      }

      const data = res.data || {};
      return {
        documents: (data.items || []).map((item: any) => this.parseSearchResult(item)),
        hasMore: data.has_more || false,
        pageToken: data.page_token,
      };
    });
  }

  /**
   * Share a document to a chat as an interactive card.
   */
  async shareDocument(
    chatId: string,
    docToken: string,
    options?: {
      description?: string;
      docType?: 'doc' | 'docx' | 'wiki' | 'sheet';
    },
  ): Promise<FeishuMessage> {
    this.validateRequired(chatId, 'chatId');
    this.validateRequired(docToken, 'docToken');

    return this.call('shareDocument', async () => {
      let title = '文档';
      let url = '';

      try {
        const docInfo = await this.fetchDocument(docToken, { detail: 'simple' });
        title = docInfo.title || title;
        url = `https://www.feishu.cn/docx/${docToken}`;
      } catch {
        url = `https://www.feishu.cn/docx/${docToken}`;
      }

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
            content: `${iconMap[options?.docType || 'doc']} ${title}`,
          },
        },
        elements: [
          ...(options?.description
            ? [
                {
                  tag: 'div',
                  text: {
                    tag: 'lark_md' as const,
                    content: options.description,
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
                  tag: 'plain_text' as const,
                  content: '查看文档',
                },
                type: 'primary' as const,
                url,
              },
            ],
          },
        ],
      };

      return this.api.sendCard(chatId, card);
    });
  }

  /**
   * Upload a resource (image/file) to a document.
   */
  async uploadResource(
    filePath: string,
    fileName?: string,
  ): Promise<ResourceUploadResult> {
    this.validateRequired(filePath, 'filePath');

    return this.call('uploadResource', async () => {
      const { readFileSync } = await import('fs');
      const { basename } = await import('path');

      const buffer = readFileSync(filePath);
      const name = fileName || basename(filePath);
      const mimeType = this.guessMimeType(name);

      const fileKey = await this.api.uploadFile(buffer, name, mimeType);

      return {
        fileKey,
        fileName: name,
        mimeType,
      };
    });
  }

  // ── Private helpers ──

  /**
   * Insert blocks under a parent block.
   */
  private async insertBlocks(
    documentId: string,
    parentBlockId: string,
    content: string,
    format?: 'xml' | 'markdown',
  ): Promise<void> {
    const client = this.api.getClient();
    const blocks = this.parseContentToBlocks(content, format);

    const res: any = await client.docx.v1.documentBlockChildren.create({
      path: {
        document_id: documentId,
        block_id: parentBlockId,
      },
      data: {
        children: blocks,
      },
    });

    if (res.code !== 0) {
      throw new Error(`Failed to insert blocks: ${res.msg || 'Unknown error'} (code: ${res.code})`);
    }
  }

  private parseSearchResult(item: any): DocumentInfo {
    return {
      documentId: item.docs_token || item.token || item.document_id,
      title: item.title || 'Untitled',
      url: item.url || item.document_url,
      type: this.mapDocType(item.doc_type || item.type),
      createTime: item.create_time ? new Date(item.create_time * 1000).toISOString() : undefined,
      updateTime: item.open_time ? new Date(item.open_time * 1000).toISOString() : undefined,
      ownerId: item.creator_id,
    };
  }

  private mapDocType(type: string): 'doc' | 'docx' | 'wiki' | 'sheet' {
    const typeMap: Record<string, any> = {
      'DOC': 'doc',
      'DOCX': 'docx',
      'WIKI': 'wiki',
      'SHEET': 'sheet',
      'BITABLE': 'doc',
    };
    return typeMap[type?.toUpperCase()] || 'docx';
  }

  private guessMimeType(fileName: string): string {
    const ext = fileName.split('.').pop()?.toLowerCase();
    const mimeMap: Record<string, string> = {
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
      'pdf': 'application/pdf',
      'doc': 'application/msword',
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'xls': 'application/vnd.ms-excel',
      'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
    return mimeMap[ext || ''] || 'application/octet-stream';
  }

  private parseContentToBlocks(content: string, format?: 'xml' | 'markdown'): any[] {
    if (format === 'markdown') {
      return this.markdownToBlocks(content);
    }
    return this.xmlToBlocks(content);
  }

  private markdownToBlocks(markdown: string): any[] {
    const blocks: any[] = [];
    const lines = markdown.split('\n');

    for (const line of lines) {
      if (line.startsWith('# ')) {
        blocks.push({
          block_type: 3,
          heading1: { elements: [{ text_run: { content: line.slice(2) } }] },
        });
      } else if (line.startsWith('## ')) {
        blocks.push({
          block_type: 4,
          heading2: { elements: [{ text_run: { content: line.slice(3) } }] },
        });
      } else if (line.startsWith('- ')) {
        blocks.push({
          block_type: 12,
          bullet: { elements: [{ text_run: { content: line.slice(2) } }] },
        });
      } else if (line.trim()) {
        blocks.push({
          block_type: 2,
          text: { elements: [{ text_run: { content: line } }] },
        });
      }
    }

    return blocks;
  }

  private xmlToBlocks(xml: string): any[] {
    const blocks: any[] = [];

    const headingRegex = /<h(\d)>([^<]*)<\/h\d>/g;
    let match;
    while ((match = headingRegex.exec(xml)) !== null) {
      const level = parseInt(match[1], 10);
      const text = match[2];
      const blockTypeNum = level === 1 ? 3 : level === 2 ? 4 : 5;
      const blockTypeName = level === 1 ? 'heading1' : level === 2 ? 'heading2' : 'heading3';
      blocks.push({
        block_type: blockTypeNum,
        [blockTypeName]: { elements: [{ text_run: { content: text } }] },
      });
    }

    const pRegex = /<p>([^<]*)<\/p>/g;
    while ((match = pRegex.exec(xml)) !== null) {
      blocks.push({
        block_type: 2,
        text: { elements: [{ text_run: { content: match[1] } }] },
      });
    }

    return blocks;
  }
}
