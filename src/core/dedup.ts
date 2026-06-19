import { createLogger } from './logger.js';

const log = createLogger('MessageDeduplicator');

interface DedupEntry {
  timestamp: number;
}

/**
 * Simple in-memory message deduplicator with TTL.
 * Prevents processing the same message multiple times (e.g. from WS reconnects).
 */
export class MessageDeduplicator {
  private seen = new Map<string, DedupEntry>();
  private ttlMs: number;
  private cleanupInterval?: NodeJS.Timeout;

  constructor(ttlMs = 600_000) {
    // Default 10 minutes
    this.ttlMs = ttlMs;
    // Run cleanup every TTL interval
    this.cleanupInterval = setInterval(() => this.cleanup(), ttlMs);
    // Ensure cleanup doesn't keep process alive
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Check if a message has been seen before.
   * If not, record it and return false.
   * If yes, return true (it's a duplicate).
   */
  isDuplicate(messageId: string): boolean {
    const now = Date.now();
    const entry = this.seen.get(messageId);

    if (entry && now - entry.timestamp < this.ttlMs) {
      log.debug({ messageId, ageMs: now - entry.timestamp }, 'Duplicate message detected');
      return true;
    }

    this.seen.set(messageId, { timestamp: now });
    return false;
  }

  /**
   * Clean up expired entries.
   */
  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, entry] of this.seen.entries()) {
      if (now - entry.timestamp > this.ttlMs) {
        this.seen.delete(id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      log.debug({ cleaned, remaining: this.seen.size }, 'Dedup cache cleaned');
    }
  }
}
