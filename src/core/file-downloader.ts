import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createLogger } from './logger.js';

const log = createLogger('FileDownloader');

const DEFAULT_ATTACHMENTS_DIR = join(homedir(), '.config', 'opencode', 'feishu-attachments');
const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB limit

export interface DownloadedFile {
  filePath: string;
  fileName: string;
  mimeType: string;
}

/**
 * Download files from Feishu to local storage.
 * Files are saved to ~/.config/opencode/feishu-attachments/
 */
export class FileDownloader {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || DEFAULT_ATTACHMENTS_DIR;
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }
  }

  /**
   * Download a file from a URL and save it locally.
   * Returns the local file path.
   */
  async downloadFromUrl(url: string, fileName: string, mimeType: string): Promise<DownloadedFile> {
    try {
      log.info({ url, fileName }, 'Downloading file from URL');
      
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
      
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > MAX_FILE_SIZE) {
        throw new Error(`File too large: ${contentLength} bytes (max ${MAX_FILE_SIZE})`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      
      if (buffer.length > MAX_FILE_SIZE) {
        throw new Error(`File too large: ${buffer.length} bytes (max ${MAX_FILE_SIZE})`);
      }

      // Sanitize filename
      const safeName = this.sanitizeFileName(fileName);
      const timestamp = Date.now();
      const uniqueName = `${timestamp}_${safeName}`;
      const filePath = join(this.baseDir, uniqueName);

      writeFileSync(filePath, buffer);
      
      log.info({ filePath, size: buffer.length }, 'File downloaded successfully');
      
      return { filePath, fileName: safeName, mimeType };
    } catch (err) {
      log.error({ err, url, fileName }, 'Failed to download file');
      throw err;
    }
  }

  /**
   * Save a buffer directly to a file.
   */
  async saveBuffer(buffer: Buffer, fileName: string, mimeType: string): Promise<DownloadedFile> {
    if (buffer.length > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${buffer.length} bytes (max ${MAX_FILE_SIZE})`);
    }

    const safeName = this.sanitizeFileName(fileName);
    const timestamp = Date.now();
    const uniqueName = `${timestamp}_${safeName}`;
    const filePath = join(this.baseDir, uniqueName);

    writeFileSync(filePath, buffer);
    
    log.info({ filePath, size: buffer.length }, 'Buffer saved to file');
    
    return { filePath, fileName: safeName, mimeType };
  }



  private sanitizeFileName(name: string): string {
    // Remove path traversal characters and limit length
    return name
      .replace(/[\x00-\x1f\x7f]/g, '') // Control chars
      .replace(/[/\\?%<>|":]/g, '_') // Invalid path chars
      .substring(0, 200); // Limit length
  }
}
