import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import type { SessionInfo, PendingInteraction } from '../core/types.js';
import type { OpenCodeClient } from '../opencode/client.js';
import type { HookManager } from './hook-manager.js';
import { createLogger } from './logger.js';

const log = createLogger('SessionManager');

const DEFAULT_STORAGE_PATH = join(homedir(), '.config', 'opencode', 'feishu-sessions.json');
const PERSIST_DEBOUNCE_MS = 500;
const STORAGE_VERSION = 1;

interface PersistedSession {
  chatId: string;
  chatType: 'p2p' | 'group';
  sessionId: string;
}

interface PersistedState {
  version: number;
  sessions: PersistedSession[];
}

export interface SessionManagerOptions {
  /** Override the persistence file path (defaults to ~/.config/opencode/feishu-sessions.json). */
  storagePath?: string;
  /** Set false to disable persistence entirely (tests). Default true. */
  persist?: boolean;
  /** Hook manager for lifecycle events */
  hookManager?: HookManager;
  /** OpenCode server URL (for hook context) */
  opencodeUrl?: string;
}

export class SessionManager {
  private sessions = new Map<string, SessionInfo>();
  private creating = new Map<string, Promise<SessionInfo>>();
  private opencode: OpenCodeClient;
  private storagePath: string;
  private persistEnabled: boolean;
  private saveTimer?: NodeJS.Timeout;
  private pendingSave?: Promise<void>;
  private hookManager?: HookManager;
  private opencodeUrl: string;

  constructor(opencode: OpenCodeClient, options: SessionManagerOptions = {}) {
    this.opencode = opencode;
    this.storagePath = options.storagePath ?? DEFAULT_STORAGE_PATH;
    this.persistEnabled = options.persist !== false;
    this.hookManager = options.hookManager;
    this.opencodeUrl = options.opencodeUrl || 'http://localhost:19876';

    if (this.persistEnabled) {
      this.restore();
    }
  }

  async getOrCreateSession(
    chatId: string,
    chatType: 'p2p' | 'group'
  ): Promise<SessionInfo> {
    const existing = this.sessions.get(chatId);
    if (existing) {
      // Reconcile against OpenCode: if the session was deleted server-side
      // (e.g. user purged via OpenCode CLI), drop the mapping and recreate
      // rather than failing on first sendPrompt with a 404.
      const alive = await this.opencode.sessionExists(existing.id);
      if (alive) return existing;

      log.warn(
        { chatId, sessionId: existing.id },
        'Persisted session no longer exists in OpenCode, recreating',
      );
      this.sessions.delete(chatId);
    }

    // Prevent concurrent creation for the same chatId
    const pending = this.creating.get(chatId);
    if (pending) return pending;

    const promise = (async (): Promise<SessionInfo> => {
      const session = await this.opencode.createSession(
        `Feishu ${chatType} ${chatId}`
      );
      const info: SessionInfo = {
        id: session.id,
        chatId,
        chatType,
        status: 'idle',
      };
      this.sessions.set(chatId, info);
      log.info({ chatId, chatType, sessionId: session.id }, 'Created new session');
      this.markDirty();

      // Fire hook on session creation (awaited — must complete before user message)
      if (this.hookManager) {
        try {
          await this.hookManager.run('onSessionCreated', {
            sessionId: session.id,
            opencodeUrl: this.opencodeUrl,
          });
        } catch (err) {
          log.error({ err }, 'onSessionCreated hook failed');
        }
      }

      return info;
    })();

    this.creating.set(chatId, promise);
    try {
      return await promise;
    } finally {
      this.creating.delete(chatId);
    }
  }

  getSession(chatId: string): SessionInfo | undefined {
    return this.sessions.get(chatId);
  }

  getChatIdBySession(sessionId: string): string | undefined {
    for (const [chatId, session] of this.sessions.entries()) {
      if (session.id === sessionId) {
        return chatId;
      }
    }
    return undefined;
  }

  updateStatus(chatId: string, status: 'idle' | 'busy'): void {
    const session = this.sessions.get(chatId);
    if (session) {
      session.status = status;
      log.info({ chatId, status }, 'Session status updated');
    }
  }

  setCurrentMessage(chatId: string, messageId: string): void {
    const session = this.sessions.get(chatId);
    if (session) {
      session.currentMessageId = messageId;
      session.lastUpdateTime = Date.now();
    }
  }

  appendContent(chatId: string, delta: string, partId?: string, field?: string): void {
    const session = this.sessions.get(chatId);
    if (!session) return;

    // Handle thinking/reasoning content separately from main content
    if (field === 'thinking' || field === 'reasoning') {
      // Track thinking part ID to know when thinking transitions to answer
      if (partId && session.thinkingPartId && session.thinkingPartId !== partId) {
        session.thinkingContent = '';
      }
      session.thinkingPartId = partId;
      session.thinkingContent = (session.thinkingContent || '') + delta;
      session.lastUpdateTime = Date.now();
      return;
    }

    // In quiet mode, only show the LAST text part (skip intermediate reasoning)
    // When a new part starts, clear previous content
    if (partId && session.currentPartId && session.currentPartId !== partId) {
      session.currentContent = '';
    }
    session.currentPartId = partId;

    session.currentContent = (session.currentContent || '') + delta;
    session.lastUpdateTime = Date.now();
  }

  clearCurrentMessage(chatId: string): void {
    const session = this.sessions.get(chatId);
    if (session) {
      session.currentMessageId = undefined;
      session.currentContent = undefined;
      session.currentPartId = undefined;
      session.thinkingContent = undefined;
      session.thinkingPartId = undefined;
      session.tools = undefined;
      session.retryMessage = undefined;
      session.modelSelection = undefined;
      session.agentSelection = undefined;
      session.interactionReplied = undefined;
      log.info({ chatId }, 'Session current message cleared');
    }
  }

  /** Drop the mapping for a chat — used when OpenCode session was purged server-side. */
  dropSession(chatId: string): void {
    if (this.sessions.delete(chatId)) {
      log.info({ chatId }, 'Dropped stale session mapping');
      this.markDirty();
    }
  }

  getAllSessions(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  setPendingInteraction(chatId: string, interaction: PendingInteraction): void {
    const session = this.sessions.get(chatId);
    if (session) {
      session.pendingInteraction = interaction;
    }
  }

  getPendingInteraction(chatId: string): PendingInteraction | undefined {
    return this.sessions.get(chatId)?.pendingInteraction;
  }

  clearPendingInteraction(chatId: string): void {
    const session = this.sessions.get(chatId);
    if (session) {
      session.pendingInteraction = undefined;
    }
  }

  async cleanup(): Promise<void> {
    log.info({ sessionCount: this.sessions.size }, 'Cleaning up sessions');

    // Flush first — must persist the chat_id→session_id mapping BEFORE
    // clearing in-memory state, otherwise flush() would save an empty list.
    await this.flush();

    for (const [, session] of this.sessions.entries()) {
      try {
        if (session.status === 'busy') {
          await this.opencode.abortSession(session.id);
        }
      } catch (err) {
        log.error({ err, sessionId: session.id }, 'Failed to cleanup session');
      }
    }

    // Process is exiting; drop in-memory state. Next start restores from disk.
    this.sessions.clear();
  }

  /** Force immediate persistence of any pending writes (shutdown). */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (this.pendingSave) {
      await this.pendingSave;
    }
    await this.save();
  }

  // -------- persistence internals --------

  private markDirty(): void {
    if (!this.persistEnabled) return;

    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.pendingSave = this.save().catch(err => {
        log.error({ err }, 'Background persist failed');
      });
    }, PERSIST_DEBOUNCE_MS);
  }

  private async save(): Promise<void> {
    if (!this.persistEnabled) return;

    const state: PersistedState = {
      version: STORAGE_VERSION,
      sessions: Array.from(this.sessions.values()).map(s => ({
        chatId: s.chatId,
        chatType: s.chatType,
        sessionId: s.id,
      })),
    };

    const dir = dirname(this.storagePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Atomic-ish write: write to tmp + rename.
    const tmp = `${this.storagePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    const { renameSync } = await import('fs');
    renameSync(tmp, this.storagePath);

    log.debug({ path: this.storagePath, count: state.sessions.length }, 'Persisted sessions');
  }

  private restore(): void {
    if (!existsSync(this.storagePath)) return;

    try {
      const raw = readFileSync(this.storagePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      if (parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.sessions)) {
        log.warn({ path: this.storagePath, version: parsed.version }, 'Unknown session file version, starting fresh');
        return;
      }

      for (const s of parsed.sessions) {
        if (!s?.chatId || !s?.sessionId || !s?.chatType) continue;
        this.sessions.set(s.chatId, {
          id: s.sessionId,
          chatId: s.chatId,
          chatType: s.chatType,
          status: 'idle',
        });
      }
      log.info({ count: this.sessions.size, path: this.storagePath }, 'Restored sessions from disk');
    } catch (err) {
      log.warn({ err, path: this.storagePath }, 'Failed to restore sessions, starting fresh');
    }
  }
}
