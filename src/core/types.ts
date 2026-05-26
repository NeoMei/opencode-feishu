// Core types for the Feishu plugin

export interface HookConfig {
  /** Script to run when a new session is created. Receives sessionId via HOOK_SESSION_ID env var. */
  onSessionCreated?: string;
  /** Script to run when a session becomes idle (after processing completes). Receives sessionId via HOOK_SESSION_ID env var. */
  onSessionIdle?: string;
}

export interface FeishuConfig {
  appId: string;
  /**
   * App secret for obtaining tenant_access_token via the SDK.
   * Can be omitted from the file if FEISHU_APP_SECRET env var is set at runtime.
   */
  appSecret?: string;
  domain: 'feishu' | 'lark';
  opencodeUrl: string;
  streaming: boolean;
  requireMention: boolean;
  groupPolicy: 'open' | 'allowlist' | 'disabled';
  allowlist?: string[];
  /** Message deduplication TTL in milliseconds (default: 600000 = 10 min) */
  dedupTtl?: number;
  /** Hook scripts for lifecycle events */
  hooks?: HookConfig;
  /** 
   * Show thinking process and tool execution in cards.
   * - 'none': Only show final answer (default, cleanest)
   * - 'tools': Show tool execution status only
   * - 'thinking': Show thinking process only (collapsed by default)
   * - 'full': Show everything - thinking, tools, and final answer
   */
  showProcess?: 'none' | 'tools' | 'thinking' | 'full';
  /** 
   * Default working directory for bash commands.
   * If set, all bash commands will use this directory unless overridden.
   */
  workdir?: string;
  /**
   * Language for AI thinking process display.
   * - 'chinese': Force Chinese thinking and reasoning (default)
   * - 'english': Keep original English thinking
   */
  thinkingLanguage?: 'chinese' | 'english';
  /**
   * Auto-approve all permission requests without user interaction.
   * When enabled, permission cards will be auto-approved with "always" reply.
   * @default false
   */
  autoApprove?: boolean;
  /**
   * Display name for the bot in card headers.
   * Overrides auto-detection from soul/IDENTITY.md.
   */
  botName?: string;
}

export interface FeishuMessage {
  message_id: string;
  root_id?: string;
  parent_id?: string;
  chat_id: string;
  chat_type: 'p2p' | 'group';
  sender: {
    sender_id: {
      union_id: string;
      user_id?: string;
      open_id?: string;
    };
    sender_type: string;
    tenant_key: string;
  };
  content: string;
  message_type: string;
  create_time: string;
  update_time?: string;
  mentions?: Array<{
    key: string;
    id: {
      union_id: string;
      user_id?: string;
      open_id?: string;
    };
    name: string;
    tenant_key: string;
  }>;
}

export interface ToolState {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'error';
  error?: string;
}

export interface PendingPermission {
  id: string;
  permission: string;
  patterns: string[];
  title: string;
}

export interface PendingQuestion {
  id: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiple?: boolean;
    custom?: boolean;
  }>;
}

export type PendingInteraction =
  | { kind: 'permission'; data: PendingPermission }
  | { kind: 'question'; data: PendingQuestion };

export interface SessionInfo {
  id: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  status: 'idle' | 'busy';
  currentMessageId?: string;
  currentContent?: string;
  currentPartId?: string;
  lastUpdateTime?: number;
  tools?: ToolState[];
  retryMessage?: string;
  pendingInteraction?: PendingInteraction;
  interactionMessageId?: string;
  /** When true, flushCard should not update the card (user already saw confirmation via card reply). */
  interactionReplied?: boolean;
  /** Thinking/reasoning process content, shown when showProcess is 'thinking' or 'full' */
  thinkingContent?: string;
  /** Current thinking part ID to track when thinking transitions to answer */
  thinkingPartId?: string;
  /** When true, indicates an error card was already sent for this session. Prevents duplicate error cards. */
  errorHandled?: boolean;
  /** Current model being used for this session (for display in card header) */
  currentModel?: string;
  /** Current agent being used for this session */
  currentAgent?: string;
  /** Model selection state for /models command (rendered inside streaming card) */
  modelSelection?: {
    providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>;
    currentModel?: string;
  };
  /** Agent selection state for /agents command (rendered inside streaming card) */
  agentSelection?: {
    agents: Array<{ name: string; description?: string; mode?: string }>;
    currentAgent?: string;
  };
}

/**
 * 一张飞书交互卡片的"内容体"。用于 im +messages-send 的 --content 字段，
 * 以及 PATCH /open-apis/im/v1/messages/<id> 里的 content 字段。
 * 外层的 msg_type 不在这里，由发送端单独传。
 */
export interface CardContent {
  config?: {
    wide_screen_mode?: boolean;
  };
  header?: {
    title: {
      tag: 'plain_text' | 'lark_md';
      content: string;
    };
  };
  elements: Array<{
    tag: string;
    [key: string]: any;
  }>;
}

export interface FeishuCredentials {
  appId: string;
  appSecret: string;
  tenantKey?: string;
}

/**
 * Normalized shape of a Feishu card action trigger event.
 * Emitted by FeishuEventSource when a user clicks an interactive card button.
 */
export interface FeishuCardAction {
  messageId: string;
  chatId: string;
  operator: {
    openId: string;
    userId?: string;
    name?: string;
  };
  action: {
    value?: Record<string, unknown>;
    tag: string;
    name?: string;
    option?: string;
  };
}
