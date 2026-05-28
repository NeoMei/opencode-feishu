import { ConfigManager } from '../src/core/config.js';
import { SessionManager } from '../src/core/session-manager.js';
import { FeishuCard } from '../src/feishu/card.js';
import { FeishuEventSource } from '../src/feishu/event-source.js';
import { MessageHandler } from '../src/core/message-handler.js';
import { FeishuAPI } from '../src/feishu/api.js';

const mockClientRequest = jest.fn();
const mockMessageCreate = jest.fn();
const mockMessagePatch = jest.fn();
const mockWSClientStart = jest.fn();
const mockWSClientClose = jest.fn();

jest.mock('@larksuiteoapi/node-sdk', () => {
  return {
    __esModule: true,
    Client: jest.fn().mockImplementation(() => ({
      im: { v1: { message: { create: mockMessageCreate, patch: mockMessagePatch } } },
      request: mockClientRequest,
    })),
    WSClient: jest.fn().mockImplementation(() => ({
      start: mockWSClientStart,
      close: mockWSClientClose,
    })),
    EventDispatcher: jest.fn().mockImplementation(() => {
      const handlers: Record<string, any> = {};
      const inst = {
        register(map: Record<string, any>) {
          Object.assign(handlers, map);
          return inst;
        },
        __handlers: handlers,
      };
      return inst;
    }),
    Domain: { Feishu: 0, Lark: 1 },
    LoggerLevel: { fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 },
  };
});

describe('ConfigManager', () => {
  const testConfigPath = '/tmp/test-feishu-config.json';

  beforeEach(() => {
    try {
      require('fs').unlinkSync(testConfigPath);
    } catch {}
  });

  it('should create and load config', () => {
    const manager = new ConfigManager(testConfigPath);
    const config = {
      appId: 'cli_test123',
      domain: 'feishu' as const,
      opencodeUrl: 'http://localhost:19876',
      streaming: true,
      requireMention: true,
      groupPolicy: 'allowlist' as const,
    };

    manager.save(config);
    const loaded = manager.load();

    expect(loaded.appId).toBe(config.appId);
    expect(loaded.domain).toBe(config.domain);
  });

  it('should throw error for invalid config', () => {
    const manager = new ConfigManager(testConfigPath);

    expect(() => {
      manager.save({
        appId: 'invalid',
        domain: 'feishu' as const,
        opencodeUrl: 'not-a-url',
        streaming: true,
        requireMention: true,
        groupPolicy: 'allowlist' as const,
      });
    }).toThrow();
  });

  it('should load a config with appSecret', () => {
    const cfg = {
      appId: 'cli_withsecret',
      appSecret: 'the-secret-value',
      domain: 'feishu',
      opencodeUrl: 'http://localhost:19876',
      streaming: true,
      requireMention: true,
      groupPolicy: 'allowlist',
    };
    require('fs').writeFileSync(testConfigPath, JSON.stringify(cfg));

    const loaded = new ConfigManager(testConfigPath).load();
    expect(loaded.appId).toBe('cli_withsecret');
    expect(loaded.appSecret).toBe('the-secret-value');
  });
});

describe('FeishuCard', () => {
  it('should create error card', () => {
    const card = FeishuCard.createErrorCard('Test error');

    expect(card.header?.title.content).toContain('错误');
  });

  it('should create error card from Error object', () => {
    const card = FeishuCard.createErrorCard(new Error('Something went wrong'));

    expect(card.header?.title.content).toContain('错误');
    const allText = card.elements.map((e: any) => e.text?.content || '').join('\n');
    expect(allText).toContain('Something went wrong');
  });

  it('should create error card from unknown type', () => {
    const card = FeishuCard.createErrorCard(12345 as any);

    expect(card.header?.title.content).toContain('错误');
    const allText = card.elements.map((e: any) => e.text?.content || '').join('\n');
    expect(allText).toContain('12345');
  });

  it('should create streaming card with tools inline', () => {
    const card = FeishuCard.createStreamingCard({
      content: 'hello',
      botName: 'TestBot',
      showProcess: 'full',
      tools: [
        { id: '1', name: 'test-tool', status: 'running' },
      ],
    });

    expect(card.header?.title.content).toContain('执行工具');
    const allText = card.elements.map((e: any) => e.text?.content || '').join('\n');
    expect(allText).toContain('test-tool');
    expect(allText).toContain('hello');
  });

  it('should render completion header when done', () => {
    const card = FeishuCard.createStreamingCard({ content: 'done', botName: 'TestBot', done: true });
    expect(card.header?.title.content).toContain('完成');
  });

  it('should render retry notice in main card', () => {
    const card = FeishuCard.createStreamingCard({
      content: 'partial',
      botName: 'TestBot',
      retry: 'rate limit, backing off',
    });
    expect(card.header?.title.content).toContain('重试');
    const allText = card.elements.map((e: any) => e.text?.content || '').join('\n');
    expect(allText).toContain('rate limit');
  });

  it('should render permission buttons when interaction is pending', () => {
    const card = FeishuCard.createStreamingCard({
      content: '需要权限',
      botName: 'TestBot',
      interaction: {
        kind: 'permission',
        data: {
          id: 'perm-123',
          permission: 'file_access',
          patterns: ['/tmp/*'],
          title: '访问文件',
        },
      },
    });

    expect(card.header?.title.content).toContain('等待授权');
    const actions = card.elements.filter((e: any) => e.tag === 'action');
    expect(actions.length).toBeGreaterThan(0);
    const buttons = actions[0].actions;
    expect(buttons.length).toBe(3);
    expect(buttons[0].text.content).toBe('✅ 确认');
    expect(buttons[0].value).toEqual({ action: 'perm', id: 'perm-123', reply: 'once' });
    expect(buttons[1].value).toEqual({ action: 'perm', id: 'perm-123', reply: 'always' });
    expect(buttons[2].value).toEqual({ action: 'perm', id: 'perm-123', reply: 'reject' });
  });

  it('should render question option buttons when interaction is pending', () => {
    const card = FeishuCard.createStreamingCard({
      content: '请选择',
      botName: 'TestBot',
      interaction: {
        kind: 'question',
        data: {
          id: 'q-123',
          questions: [{
            question: '选择语言',
            header: '语言',
            options: [
              { label: 'TypeScript', description: 'TS' },
              { label: 'Python', description: 'PY' },
            ],
          }],
        },
      },
    });

    expect(card.header?.title.content).toContain('等待选择');
    const actions = card.elements.filter((e: any) => e.tag === 'action');
    expect(actions.length).toBe(2); // One action per option
    expect(actions[0].actions[0].text.content).toBe('1. TypeScript');
    expect(actions[0].actions[0].value).toEqual({ action: 'q', id: 'q-123', ans: [['TypeScript']] });
    expect(actions[1].actions[0].value).toEqual({ action: 'q', id: 'q-123', ans: [['Python']] });
  });
});

describe('SessionManager', () => {
  let sessionManager: SessionManager;
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      createSession: jest.fn().mockResolvedValue({ id: 'session-123' }),
      abortSession: jest.fn().mockResolvedValue(undefined),
      sessionExists: jest.fn().mockResolvedValue(true),
    };
    sessionManager = new SessionManager(mockClient, { persist: false });
  });

  it('should create new session', async () => {
    const session = await sessionManager.getOrCreateSession('chat-123', 'p2p');

    expect(session.id).toBe('session-123');
    expect(session.chatId).toBe('chat-123');
    expect(session.status).toBe('idle');
  });

  it('should reuse existing session', async () => {
    await sessionManager.getOrCreateSession('chat-123', 'p2p');
    const session2 = await sessionManager.getOrCreateSession('chat-123', 'p2p');

    expect(mockClient.createSession).toHaveBeenCalledTimes(1);
    expect(session2.id).toBe('session-123');
  });

  it('should update status', async () => {
    await sessionManager.getOrCreateSession('chat-123', 'p2p');
    sessionManager.updateStatus('chat-123', 'busy');

    const session = sessionManager.getSession('chat-123');
    expect(session?.status).toBe('busy');
  });

  it('should cleanup sessions', async () => {
    await sessionManager.getOrCreateSession('chat-123', 'p2p');
    sessionManager.updateStatus('chat-123', 'busy');

    await sessionManager.cleanup();

    expect(mockClient.abortSession).toHaveBeenCalledWith('session-123');
    expect(sessionManager.getAllSessions()).toHaveLength(0);
  });
});

describe('SessionManager persistence', () => {
  const makeMockClient = (overrides: any = {}) => ({
    createSession: jest.fn().mockResolvedValue({ id: 'new-session-id' }),
    abortSession: jest.fn().mockResolvedValue(undefined),
    sessionExists: jest.fn().mockResolvedValue(true),
    ...overrides,
  });

  const cleanupFile = (path: string) => {
    try {
      require('fs').unlinkSync(path);
    } catch {}
  };

  it('roundtrip: persist on create, restore on reconstruct', async () => {
    const storagePath = '/tmp/test-sm-roundtrip.json';
    cleanupFile(storagePath);

    const client1 = makeMockClient();
    const sm1 = new SessionManager(client1, { persist: true, storagePath });
    const session = await sm1.getOrCreateSession('chat-A', 'p2p');
    expect(session.id).toBe('new-session-id');

    await sm1.flush();

    const raw = require('fs').readFileSync(storagePath, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.version).toBe(1);
    expect(data.sessions).toContainEqual({
      chatId: 'chat-A',
      sessionId: 'new-session-id',
      chatType: 'p2p',
    });

    const client2 = makeMockClient();
    const sm2 = new SessionManager(client2, { persist: true, storagePath });
    expect(sm2.getSession('chat-A')?.id).toBe('new-session-id');
    expect(sm2.getSession('chat-A')?.chatType).toBe('p2p');
    expect(client2.createSession).not.toHaveBeenCalled();

    cleanupFile(storagePath);
  });

  it('reconciliation: existing session still alive -> reuse', async () => {
    const storagePath = '/tmp/test-sm-reuse.json';
    cleanupFile(storagePath);

    require('fs').writeFileSync(
      storagePath,
      JSON.stringify({
        version: 1,
        sessions: [{ chatId: 'chat-B', sessionId: 'sess-alive', chatType: 'p2p' }],
      })
    );

    const client = makeMockClient();
    const sm = new SessionManager(client, { persist: true, storagePath });
    const session = await sm.getOrCreateSession('chat-B', 'p2p');

    expect(session.id).toBe('sess-alive');
    expect(client.createSession).not.toHaveBeenCalled();
    expect(client.sessionExists).toHaveBeenCalledWith('sess-alive');

    cleanupFile(storagePath);
  });

  it('reconciliation: persisted session purged server-side -> recreate', async () => {
    const storagePath = '/tmp/test-sm-recreate.json';
    cleanupFile(storagePath);

    require('fs').writeFileSync(
      storagePath,
      JSON.stringify({
        version: 1,
        sessions: [{ chatId: 'chat-C', sessionId: 'sess-dead', chatType: 'p2p' }],
      })
    );

    const client = makeMockClient({
      sessionExists: jest.fn().mockResolvedValue(false),
      createSession: jest.fn().mockResolvedValue({ id: 'sess-new' }),
    });
    const sm = new SessionManager(client, { persist: true, storagePath });
    const session = await sm.getOrCreateSession('chat-C', 'p2p');

    expect(session.id).toBe('sess-new');
    expect(client.createSession).toHaveBeenCalledTimes(1);

    await sm.flush();

    const raw = require('fs').readFileSync(storagePath, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.sessions).toContainEqual({
      chatId: 'chat-C',
      sessionId: 'sess-new',
      chatType: 'p2p',
    });
    expect(data.sessions.some((s: any) => s.sessionId === 'sess-dead')).toBe(false);

    cleanupFile(storagePath);
  });

  it('dropSession removes from memory and marks dirty', async () => {
    const storagePath = '/tmp/test-sm-drop.json';
    cleanupFile(storagePath);

    require('fs').writeFileSync(
      storagePath,
      JSON.stringify({
        version: 1,
        sessions: [{ chatId: 'chat-D', sessionId: 'sess-X', chatType: 'p2p' }],
      })
    );

    const sm = new SessionManager(makeMockClient(), { persist: true, storagePath });
    sm.dropSession('chat-D');
    expect(sm.getSession('chat-D')).toBeUndefined();

    await sm.flush();

    const raw = require('fs').readFileSync(storagePath, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.version).toBe(1);
    expect(data.sessions).toEqual([]);

    cleanupFile(storagePath);
  });

  it('corrupt storage file -> start fresh, log warning', async () => {
    const storagePath = '/tmp/test-sm-corrupt.json';
    cleanupFile(storagePath);

    require('fs').writeFileSync(storagePath, '{"version": 999, "sessions": []}');

    const sm = new SessionManager(makeMockClient(), { persist: true, storagePath });
    expect(sm.getAllSessions().length).toBe(0);

    cleanupFile(storagePath);
  });
});

describe('MessageHandler', () => {
  let messageHandler: MessageHandler;
  let mockConfig: any;
  let mockSessionManager: any;
  let mockFeishuApi: any;
  let mockOpencode: any;

  beforeEach(() => {
    mockConfig = {
      appId: 'cli_test',
      requireMention: true,
      groupPolicy: 'allowlist',
      allowlist: [],
    };

    mockSessionManager = {
      getOrCreateSession: jest.fn().mockResolvedValue({
        id: 'session-123',
        status: 'idle',
      }),
      getSession: jest.fn().mockReturnValue({
        id: 'session-123',
        status: 'idle',
      }),
      updateStatus: jest.fn(),
      clearCurrentMessage: jest.fn(),
      setCurrentMessage: jest.fn(),
      getPendingInteraction: jest.fn().mockReturnValue(undefined),
      clearPendingInteraction: jest.fn(),
    };

    mockFeishuApi = {
      sendText: jest.fn().mockResolvedValue({ message_id: 'msg-123' }),
      sendCard: jest.fn().mockResolvedValue({ message_id: 'msg-123' }),
      updateCard: jest.fn().mockResolvedValue(undefined),
      getBotOpenId: jest.fn().mockReturnValue(undefined),
      getUserName: jest.fn().mockResolvedValue('user-1'),
    };

    mockOpencode = {
      sendPrompt: jest.fn().mockResolvedValue(undefined),
      replyPermission: jest.fn().mockResolvedValue(true),
      replyQuestion: jest.fn().mockResolvedValue(true),
    };

    // Initialize WorkdirManager before creating MessageHandler
    const { initWorkdirManager } = require('../src/core/workdir-manager.js');
    initWorkdirManager();

    messageHandler = new MessageHandler(
      mockConfig,
      mockSessionManager,
      mockFeishuApi,
      mockOpencode
    );
  });

  it('should handle p2p message', async () => {
    const message = {
      message_id: 'msg-1',
      chat_id: 'chat-123',
      chat_type: 'p2p',
      sender: {
        sender_id: { union_id: 'user-1' },
        sender_type: 'user',
        tenant_key: 'tenant-1',
      },
      content: JSON.stringify({ text: 'Hello' }),
      message_type: 'text',
      create_time: '1234567890',
    };

    await messageHandler.handleMessage(message as any);

    expect(mockSessionManager.getOrCreateSession).toHaveBeenCalledWith('chat-123', 'p2p');
    expect(mockOpencode.sendPrompt).toHaveBeenCalledWith(
      'session-123',
      expect.stringContaining('Hello'),
      undefined,
      undefined,
      undefined,
    );
  });

  it('should ignore bot messages', async () => {
    const message = {
      message_id: 'msg-1',
      chat_id: 'chat-123',
      chat_type: 'p2p',
      sender: {
        sender_id: { union_id: 'user-1' },
        sender_type: 'app',
        tenant_key: 'tenant-1',
      },
      content: JSON.stringify({ text: 'Hello' }),
      message_type: 'text',
      create_time: '1234567890',
    };

    await messageHandler.handleMessage(message as any);

    expect(mockOpencode.sendPrompt).not.toHaveBeenCalled();
  });

  it('should require mention in group', async () => {
    const message = {
      message_id: 'msg-1',
      chat_id: 'chat-123',
      chat_type: 'group',
      sender: {
        sender_id: { union_id: 'user-1' },
        sender_type: 'user',
        tenant_key: 'tenant-1',
      },
      content: JSON.stringify({ text: 'Hello' }),
      message_type: 'text',
      create_time: '1234567890',
      mentions: [],
    };

    await messageHandler.handleMessage(message as any);

    expect(mockOpencode.sendPrompt).not.toHaveBeenCalled();
  });

  it('should handle permission card action', async () => {
    const chatId = 'chat-123';
    mockSessionManager.getPendingInteraction = jest.fn().mockReturnValue({
      kind: 'permission',
      data: { id: 'perm-123', permission: 'test', patterns: [], title: 'Test' },
    });
    mockOpencode.replyPermission = jest.fn().mockResolvedValue(true);
    mockFeishuApi.sendCard = jest.fn().mockResolvedValue({ message_id: 'msg-new' });

    const action = {
      messageId: 'msg-456',
      chatId,
      operator: { openId: 'ou-user' },
      action: {
        value: { _oc: 'perm', id: 'perm-123', reply: 'once' },
        tag: 'button',
      },
    };

    const result = await messageHandler.handleCardAction(action as any);

    // Background task runs microtasks after handleCardAction returns;
    // flush the task queue so the async void callback completes.
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(mockOpencode.replyPermission).toHaveBeenCalledWith('perm-123', 'once');
    expect(mockSessionManager.clearPendingInteraction).toHaveBeenCalledWith(chatId);
    expect(mockFeishuApi.sendCard).toHaveBeenCalled();
    expect(result?.toast?.type).toBe('success');
  });

  it('should handle question card action', async () => {
    const chatId = 'chat-123';
    mockSessionManager.getPendingInteraction = jest.fn().mockReturnValue({
      kind: 'question',
      data: {
        id: 'q-123',
        questions: [{ question: 'Q1', header: 'Q1', options: [{ label: 'A', description: '' }] }],
      },
    });
    mockOpencode.replyQuestion = jest.fn().mockResolvedValue(true);
    mockFeishuApi.sendCard = jest.fn().mockResolvedValue({ message_id: 'msg-new' });

    const action = {
      messageId: 'msg-456',
      chatId,
      operator: { openId: 'ou-user' },
      action: {
        value: { _oc: 'q', id: 'q-123', ans: [['A']] },
        tag: 'button',
      },
    };

    const result = await messageHandler.handleCardAction(action as any);

    // Background task runs microtasks after handleCardAction returns;
    // flush the task queue so the async void callback completes.
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(mockOpencode.replyQuestion).toHaveBeenCalledWith('q-123', [['A']]);
    expect(mockSessionManager.clearPendingInteraction).toHaveBeenCalledWith(chatId);
    expect(mockFeishuApi.sendCard).toHaveBeenCalled();
    expect(result?.toast?.type).toBe('success');
  });

  it('should reject card action with no pending interaction', async () => {
    mockSessionManager.getPendingInteraction = jest.fn().mockReturnValue(undefined);

    const action = {
      messageId: 'msg-456',
      chatId: 'chat-123',
      operator: { openId: 'ou-user' },
      action: { value: { _oc: 'perm', reply: 'once' }, tag: 'button' },
    };

    const result = await messageHandler.handleCardAction(action as any);

    expect(mockOpencode.replyPermission).not.toHaveBeenCalled();
    expect(result?.toast?.type).toBe('warning');
  });
});

describe('EventHandler — permission race regression test', () => {
  // Simulate the race condition from the bug report:
  //   AI triggers permission.asked → Text deltas keep arriving → flushCard
  //   is called repeatedly → Feishu PATCH budget exhausted → user clicks
  //   "Confirm" → 200340 error → session stuck.
  //
  // Fix: flushCard must NOT update the card while a permission interaction
  // is pending (unless it's the final "done" flush or explicit force=true).
  it('should freeze card updates while permission is pending', async () => {
    const chatId = 'chat-race';
    const messageId = 'msg-456';

    let sendCardCalls = 0;
    let updateCardCalls = 0;

    const mockFeishuApi = {
      sendCard: jest.fn().mockImplementation(async () => {
        sendCardCalls++;
        return { message_id: messageId };
      }),
      updateCard: jest.fn().mockImplementation(async () => {
        updateCardCalls++;
      }),
    };

    const sessionState: any = {
      id: 'session-race',
      status: 'busy' as const,
      currentMessageId: undefined as string | undefined,
      currentContent: '',
      pendingInteraction: undefined as any,
      interactionReplied: undefined as boolean | undefined,
      tools: [] as any[],
      retryMessage: undefined as string | undefined,
      lastUpdateTime: 0,
    };

    const mockSessionManager = {
      getSession: jest.fn().mockReturnValue(sessionState),
      getChatIdBySession: jest.fn().mockReturnValue(chatId),
      appendContent: jest.fn().mockImplementation((_chatId: string, delta: string) => {
        sessionState.currentContent = (sessionState.currentContent || '') + delta;
      }),
      setCurrentMessage: jest.fn().mockImplementation((_chatId: string, mid: string) => {
        sessionState.currentMessageId = mid;
      }),
      updateStatus: jest.fn(),
      clearCurrentMessage: jest.fn(),
      setPendingInteraction: jest.fn().mockImplementation((_chatId: string, interaction: any) => {
        sessionState.pendingInteraction = interaction;
      }),
      clearPendingInteraction: jest.fn().mockImplementation(() => {
        sessionState.pendingInteraction = undefined;
      }),
      getPendingInteraction: jest.fn().mockImplementation(() => sessionState.pendingInteraction),
      getAllSessions: jest.fn().mockReturnValue([]),
    };

    const { OpenCodeEventHandler } = require('../src/opencode/event-handler.js');
    const handler = new OpenCodeEventHandler(
      mockSessionManager,
      mockFeishuApi,
      undefined,
      'http://localhost:19876',
      'full',
      '点点',
    );

    // PHASE 1: Permission asked → card created with buttons
    await handler.start({
      stream: (async function* () {
        yield {
          payload: {
            type: 'permission.asked',
            sessionID: 'session-race',
            permission: 'bash',
            patterns: ['read ~/.config/opencode/**'],
            title: 'bash: read ~/.config/opencode/**',
            id: 'per_abc123',
          },
        };
      })(),
    });

    handler.stop();

    // First flushCard (force=true) should have created a card
    expect(sendCardCalls).toBe(1);
    expect(sessionState.pendingInteraction).toBeDefined();
    expect(sessionState.pendingInteraction.kind).toBe('permission');

    // PHASE 2: Text deltas arrive while permission is pending
    sendCardCalls = 0;
    updateCardCalls = 0;
    sessionState.lastUpdateTime = 0;

    // Simulate many text deltas (AI continues outputting while waiting)
    await handler.start({
      stream: (async function* () {
        for (let i = 0; i < 15; i++) {
          yield {
            payload: {
              type: 'message.part.delta',
              sessionID: 'session-race',
              messageID: 'msg-abc',
              partID: 'part-1',
              field: 'text',
              delta: `Text chunk ${i}. `,
            },
          };
        }
      })(),
    });

    handler.stop();

    // Content was accumulated in-memory
    expect(sessionState.currentContent).toContain('Text chunk');

    // BUT the card must NOT have been updated — this is the key assertion
    expect(sendCardCalls).toBe(0);
    expect(updateCardCalls).toBe(0);

    // PHASE 3: User clicks "Confirm" → permission cleared → card updates again
    mockSessionManager.clearPendingInteraction();
    sendCardCalls = 0;
    updateCardCalls = 0;
    sessionState.lastUpdateTime = 0;

    await handler.start({
      stream: (async function* () {
        yield {
          payload: {
            type: 'session.idle',
            sessionID: 'session-race',
          },
        };
      })(),
    });

    handler.stop();

    // After permission is cleared, final flushCard should update the card
    expect(updateCardCalls).toBeGreaterThanOrEqual(1);
  });

  it('should NOT freeze card updates for question interactions', async () => {
    const chatId = 'chat-question';
    const messageId = 'msg-q';

    let updateCardCalls = 0;

    const mockFeishuApi = {
      sendCard: jest.fn().mockResolvedValue({ message_id: messageId }),
      updateCard: jest.fn().mockImplementation(async () => { updateCardCalls++; }),
    };

    const sessionState: any = {
      id: 'session-q',
      status: 'busy' as const,
      currentMessageId: messageId,
      currentContent: 'some text',
      pendingInteraction: {
        kind: 'question',
        data: { id: 'q-1', questions: [] },
      },
      interactionReplied: undefined as boolean | undefined,
      tools: [] as any[],
      retryMessage: undefined as string | undefined,
      lastUpdateTime: 0,
    };

    const mockSessionManager = {
      getSession: jest.fn().mockReturnValue(sessionState),
      getChatIdBySession: jest.fn().mockReturnValue(chatId),
      appendContent: jest.fn(),
      setCurrentMessage: jest.fn(),
      setPendingInteraction: jest.fn(),
      clearPendingInteraction: jest.fn(),
      getPendingInteraction: jest.fn().mockImplementation(() => sessionState.pendingInteraction),
      updateStatus: jest.fn(),
      clearCurrentMessage: jest.fn(),
      getAllSessions: jest.fn().mockReturnValue([]),
    };

    const { OpenCodeEventHandler } = require('../src/opencode/event-handler.js');
    const handler = new OpenCodeEventHandler(
      mockSessionManager,
      mockFeishuApi,
      undefined,
      'http://localhost:19876',
      'full',
      '点点',
    );

    // Text deltas should NOT be frozen for questions (only permission kind)
    await handler.start({
      stream: (async function* () {
        yield {
          payload: {
            type: 'message.part.delta',
            sessionID: 'session-q',
            messageID: 'msg-abc',
            partID: 'part-1',
            field: 'text',
            delta: 'Question text chunk.',
          },
        };
      })(),
    });

    handler.stop();

    // updateCard SHOULD be called for question interactions
    expect(updateCardCalls).toBeGreaterThanOrEqual(1);
  });
});

describe('FeishuEventSource', () => {
  let es: FeishuEventSource;
  let mockApi: any;

  beforeEach(() => {
    mockApi = {
      getCredentials: jest.fn().mockReturnValue({
        appId: 'cli_test',
        appSecret: 'test-secret',
        domain: 0,
      }),
    };
    es = new FeishuEventSource(mockApi);
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await es.disconnect();
  });

  it('should instantiate without opening a WSClient until connect() is called', () => {
    expect(es).toBeDefined();
    expect(es.isConnected()).toBe(false);
  });

  it("emits 'message' when WSClient receives im.message.receive_v1", async () => {
    const messagePromise = new Promise<any>((resolve) => {
      es.once('message', resolve);
    });

    await es.connect();

    const dispatcherInst = (require('@larksuiteoapi/node-sdk').EventDispatcher as jest.Mock).mock.results[0].value;
    const handler = dispatcherInst.__handlers['im.message.receive_v1'];
    expect(handler).toBeDefined();

    const fakePayload = {
      message: {
        message_id: 'msg-1',
        chat_id: 'chat-123',
        chat_type: 'p2p',
        content: JSON.stringify({ text: 'hi' }),
        message_type: 'text',
        create_time: '1234567890',
      },
      sender: {
        sender_id: { union_id: 'user-1' },
        sender_type: 'user',
        tenant_key: 'tenant-1',
      },
    };

    await handler(fakePayload);
    const emitted = await messagePromise;

    expect(emitted.chat_id).toBe('chat-123');
    expect(emitted.chat_type).toBe('p2p');
    expect(emitted.sender).toEqual(fakePayload.sender);
    expect(emitted.content).toBe(fakePayload.message.content);
    expect(emitted.message_id).toBe('msg-1');
  });

  it('calls WSClient.close({force:true}) on disconnect', async () => {
    await es.connect();
    expect(es.isConnected()).toBe(true);

    await es.disconnect();
    expect(mockWSClientClose).toHaveBeenCalledWith({ force: true });
    expect(es.isConnected()).toBe(false);
  });

  it("emits 'cardAction' when WSClient receives card.action.trigger", async () => {
    const actionPromise = new Promise<any>((resolve) => {
      es.once('cardAction', resolve);
    });

    await es.connect();

    const dispatcherInst = (require('@larksuiteoapi/node-sdk').EventDispatcher as jest.Mock).mock.results[0].value;
    const handler = dispatcherInst.__handlers['card.action.trigger'];
    expect(handler).toBeDefined();

    const fakePayload = {
      operator: { open_id: 'ou-user', user_id: 'user-1' },
      action: {
        value: { _oc: 'perm', id: 'perm-123', reply: 'once' },
        tag: 'button',
      },
      context: {
        open_message_id: 'om-msg',
        open_chat_id: 'oc-chat',
      },
    };

    // Invoke handler directly; it returns a Promise that resolves to the listener result
    const result = await handler(fakePayload);
    const emitted = await actionPromise;

    expect(emitted.chatId).toBe('oc-chat');
    expect(emitted.messageId).toBe('om-msg');
    expect(emitted.action.value).toEqual(fakePayload.action.value);
    // Default toast fallback when no listener returns a value
    expect(result.toast).toBeDefined();
  });
});

describe('FeishuAPI', () => {
  const baseConfig = {
    appId: 'cli_test',
    domain: 'feishu' as const,
    opencodeUrl: 'http://localhost:19876',
    streaming: true,
    requireMention: true,
    groupPolicy: 'allowlist' as const,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.FEISHU_APP_SECRET;
  });

  afterEach(() => {
    delete process.env.FEISHU_APP_SECRET;
  });

  it('sendCard calls client.im.v1.message.create with msg_type=interactive', async () => {
    mockMessageCreate.mockResolvedValue({ code: 0, data: { message_id: 'om_xxx' } });

    const api = new FeishuAPI({ ...baseConfig, appSecret: 'secret' });
    const card = {
      config: { wide_screen_mode: true },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: 'hi' } }],
    };

    const result = await api.sendCard('oc_chat', card as any);

    expect(mockMessageCreate).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_chat',
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });
    expect(result.message_id).toBe('om_xxx');
  });

  it('sendCard throws if response has no message_id', async () => {
    mockMessageCreate.mockResolvedValue({ code: 0, data: {} });

    const api = new FeishuAPI({ ...baseConfig, appSecret: 'secret' });
    await expect(api.sendCard('oc_chat', { elements: [] } as any)).rejects.toThrow('missing message_id');
  });

  it('sendCard throws if code is non-zero', async () => {
    mockMessageCreate.mockResolvedValue({ code: 99999, msg: 'boom' });

    const api = new FeishuAPI({ ...baseConfig, appSecret: 'secret' });
    await expect(api.sendCard('oc_chat', { elements: [] } as any)).rejects.toThrow(/boom/);
  });

  it('updateCard calls client.im.v1.message.patch', async () => {
    mockMessagePatch.mockResolvedValue({ code: 0 });

    const api = new FeishuAPI({ ...baseConfig, appSecret: 'secret' });
    const card = { config: {}, elements: [] };

    await api.updateCard('om_xxx', card as any);

    expect(mockMessagePatch).toHaveBeenCalledWith({
      path: { message_id: 'om_xxx' },
      data: { content: JSON.stringify(card) },
    });
  });

  it('initialize fetches bot open_id via request', async () => {
    mockClientRequest.mockResolvedValue({ bot: { open_id: 'ou_test' } });

    const api = new FeishuAPI({ ...baseConfig, appSecret: 'secret' });
    await api.initialize();

    expect(mockClientRequest).toHaveBeenCalledWith({
      method: 'GET',
      url: '/open-apis/bot/v3/info',
    });
    expect(api.getBotOpenId()).toBe('ou_test');
  });

  it('constructor throws when no appSecret and no env var', () => {
    expect(() => new FeishuAPI(baseConfig)).toThrow(/app secret/i);
  });

  it('constructor uses FEISHU_APP_SECRET env as fallback', () => {
    process.env.FEISHU_APP_SECRET = 'from-env';
    expect(() => new FeishuAPI(baseConfig)).not.toThrow();
  });

  it('getUserName fetches and caches user name', async () => {
    mockClientRequest.mockResolvedValue({
      data: { user: { name: '张三' } },
    });

    const api = new FeishuAPI({ ...baseConfig, appSecret: 'secret' });
    const name1 = await api.getUserName('user_123');
    expect(name1).toBe('张三');
    expect(mockClientRequest).toHaveBeenCalledTimes(1);

    // Second call should use cache
    const name2 = await api.getUserName('user_123');
    expect(name2).toBe('张三');
    expect(mockClientRequest).toHaveBeenCalledTimes(1); // No additional call
  });
});

import { MessageDeduplicator } from '../src/core/dedup.js';
import { ProfileManager } from '../src/core/profile-manager.js';

describe('MessageDeduplicator', () => {
  it('should detect duplicate messages', () => {
    const dedup = new MessageDeduplicator(1000);
    expect(dedup.isDuplicate('msg_1')).toBe(false);
    expect(dedup.isDuplicate('msg_1')).toBe(true);
    expect(dedup.isDuplicate('msg_2')).toBe(false);
    expect(dedup.size()).toBe(2);
    dedup.stop();
  });

  it('should expire old entries after TTL', async () => {
    const dedup = new MessageDeduplicator(50);
    dedup.isDuplicate('msg_1');
    expect(dedup.isDuplicate('msg_1')).toBe(true);

    await new Promise(r => setTimeout(r, 100));
    // After cleanup, the entry should be expired
    expect(dedup.isDuplicate('msg_1')).toBe(false);
    dedup.stop();
  });
});

import { IMService } from '../src/services/im-service.js';
import { DocService } from '../src/services/doc-service.js';
import { ChatService } from '../src/services/chat-service.js';
import { ContactService } from '../src/services/contact-service.js';
import { CalendarService } from '../src/services/calendar-service.js';
import { TaskService } from '../src/services/task-service.js';
import { ApprovalService } from '../src/services/approval-service.js';

describe('Services', () => {
  let mockApi: any;
  let mockClient: any;

  beforeEach(() => {
    mockClient = {
      im: {
        v1: {
          message: {
            create: jest.fn(),
            search: jest.fn(),
            list: jest.fn(),
          },
          chat: {
            get: jest.fn(),
            create: jest.fn(),
          },
          chatMembers: {
            get: jest.fn(),
            create: jest.fn(),
            delete: jest.fn(),
          },
        },
      },
      contact: {
        v3: {
          user: {
            get: jest.fn(),
            findByDepartment: jest.fn(),
          },
        },
      },
      request: jest.fn(),
    };

    mockApi = {
      getClient: jest.fn().mockReturnValue(mockClient),
      sendText: jest.fn(),
      sendCard: jest.fn(),
      downloadMedia: jest.fn(),
    };
  });

  describe('IMService', () => {
    it('should send text message', async () => {
      const service = new IMService(mockApi);
      mockApi.sendText.mockResolvedValue({ message_id: 'msg-123' });

      const result = await service.sendTextMessage('chat-123', 'Hello');
      expect(mockApi.sendText).toHaveBeenCalledWith('chat-123', 'Hello');
      expect(result.message_id).toBe('msg-123');
    });

    it('should send post message', async () => {
      const service = new IMService(mockApi);
      mockClient.im.v1.message.create.mockResolvedValue({ code: 0, data: { message_id: 'msg-post' } });

      const result = await service.sendPostMessage('chat-123', 'Test Title', [
        { tag: 'text', text: 'Hello ' },
        { tag: 'a', text: 'Link', href: 'https://example.com' },
      ]);
      expect(mockClient.im.v1.message.create).toHaveBeenCalled();
      expect(result.message_id).toBe('msg-post');
    });

    it('should send document card', async () => {
      const service = new IMService(mockApi);
      mockApi.sendCard.mockResolvedValue({ message_id: 'msg-card' });

      const result = await service.sendDocumentCard('chat-123', {
        title: 'Test Doc',
        url: 'https://open.feishu.cn/document/doc-123',
        description: 'This is a test document',
        docType: 'docx',
      });
      expect(mockApi.sendCard).toHaveBeenCalled();
      expect(result.message_id).toBe('msg-card');
    });

    it('should throw error for empty chatId', async () => {
      const service = new IMService(mockApi);
      await expect(service.sendTextMessage('', 'Hello')).rejects.toThrow('chatId is required');
    });
  });

  describe('DocService', () => {
    it('should validate required parameters', async () => {
      const service = new DocService(mockApi);
      await expect(service.fetchDocument('')).rejects.toThrow('docToken is required');
    });

    it('should create document', async () => {
      const service = new DocService(mockApi);
      mockClient.docx = {
        v1: {
          document: {
            create: jest.fn().mockResolvedValue({
              code: 0,
              data: {
                document: {
                  document_id: 'doc-new',
                  revision_id: 1,
                  title: 'Test Doc',
                  url: 'https://www.feishu.cn/docx/doc-new',
                },
              },
            }),
          },
        },
      };

      const result = await service.createDocument({
        title: 'Test Doc',
      });
      expect(result.documentId).toBe('doc-new');
      expect(result.revisionId).toBe(1);
      expect(result.url).toContain('www.feishu.cn/docx/');
    });

    it('should fetch document with options', async () => {
      const service = new DocService(mockApi);
      mockClient.request.mockResolvedValue({
        code: 0,
        data: {
          title: 'Test Doc',
          content: '<h1>Title</h1><p>Content</p>',
          revision_id: 2,
        },
      });

      const result = await service.fetchDocument('doc-123', {
        detail: 'simple',
        docFormat: 'xml',
        scope: 'outline',
      });
      expect(result.documentId).toBe('doc-123');
      expect(result.content).toContain('Title');
      expect(result.revisionId).toBe(2);
    });

    it('should search documents', async () => {
      const service = new DocService(mockApi);
      mockClient.request.mockResolvedValue({
        code: 0,
        data: {
          items: [
            { docs_token: 'doc-1', title: 'Doc 1', doc_type: 'DOCX' },
          ],
          has_more: false,
        },
      });

      const result = await service.searchDocuments('test');
      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].title).toBe('Doc 1');
    });

    it('should share document to chat', async () => {
      const service = new DocService(mockApi);
      mockClient.request.mockResolvedValue({
        code: 0,
        data: {
          title: 'Shared Doc',
          content: '<p>Content</p>',
        },
      });
      mockApi.sendCard.mockResolvedValue({ message_id: 'msg-share' });

      const result = await service.shareDocument('chat-123', 'doc-456', {
        description: 'Check this out',
        docType: 'docx',
      });
      expect(mockApi.sendCard).toHaveBeenCalled();
      expect(result.message_id).toBe('msg-share');
    });
  });

  describe('ChatService', () => {
    it('should validate required parameters', async () => {
      const service = new ChatService(mockApi);
      await expect(service.searchChats('')).rejects.toThrow('query is required');
    });

    it('should search chats', async () => {
      const service = new ChatService(mockApi);
      mockClient.request.mockResolvedValue({
        code: 0,
        data: {
          items: [{ chat_id: 'chat-1', name: 'Test Chat' }],
          has_more: false,
        },
      });

      const result = await service.searchChats('test');
      expect(result.chats).toHaveLength(1);
      expect(result.chats[0].chatId).toBe('chat-1');
    });
  });

  describe('ContactService', () => {
    it('should validate required parameters', async () => {
      const service = new ContactService(mockApi);
      await expect(service.searchUsers('')).rejects.toThrow('query is required');
    });

    it('should parse user info', async () => {
      const service = new ContactService(mockApi);
      mockClient.request.mockResolvedValue({
        code: 0,
        data: {
          user_list: [{
            open_id: 'ou-123',
            name: '张三',
            email: 'zhangsan@example.com',
          }],
        },
      });

      const result = await service.searchUsers('张三');
      expect(result.users).toHaveLength(1);
      expect(result.users[0].name).toBe('张三');
      expect(result.users[0].email).toBe('zhangsan@example.com');
    });
  });

  describe('CalendarService', () => {
    it('should list calendars', async () => {
      const service = new CalendarService(mockApi);
      mockClient.request.mockResolvedValue({
        code: 0,
        data: {
          calendars: [{ calendar: { calendar_id: 'cal-1', name: 'Test Calendar' } }],
          has_more: false,
        },
      });

      const result = await service.listCalendars();
      expect(result.calendars).toHaveLength(1);
      expect(result.calendars[0].calendarId).toBe('cal-1');
    });

    it('should get primary calendar', async () => {
      const service = new CalendarService(mockApi);
      mockClient.request.mockResolvedValue({
        code: 0,
        data: { calendar_id: 'primary', name: 'My Calendar' },
      });

      const result = await service.getPrimaryCalendar();
      expect(result.calendarId).toBe('primary');
    });

    it('should list events', async () => {
      const service = new CalendarService(mockApi);
      mockClient.request.mockResolvedValue({
        code: 0,
        data: {
          items: [{
            event_id: 'evt-1',
            summary: 'Meeting',
            start_time: { timestamp: '2024-01-01T10:00:00Z' },
            end_time: { timestamp: '2024-01-01T11:00:00Z' },
          }],
          has_more: false,
        },
      });

      const result = await service.listEvents('cal-1');
      expect(result.events).toHaveLength(1);
      expect(result.events[0].summary).toBe('Meeting');
    });

    it('should create event', async () => {
      const service = new CalendarService(mockApi);
      mockClient.request.mockResolvedValue({
        code: 0,
        data: {
          event_id: 'evt-new',
          summary: 'New Meeting',
          start_time: { timestamp: '2024-01-01T10:00:00Z' },
          end_time: { timestamp: '2024-01-01T11:00:00Z' },
        },
      });

      const result = await service.createEvent('cal-1', {
        summary: 'New Meeting',
        startTime: '2024-01-01T10:00:00Z',
        endTime: '2024-01-01T11:00:00Z',
      });
      expect(result.eventId).toBe('evt-new');
    });
  });

  describe('TaskService', () => {
    it('should list tasks', async () => {
      const service = new TaskService(mockApi);
      mockClient.request.mockResolvedValue({
        code: 0,
        data: {
          items: [{ task_id: 'task-1', summary: 'Do something' }],
          has_more: false,
        },
      });

      const result = await service.listTasks();
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].summary).toBe('Do something');
    });

    it('should create task', async () => {
      const service = new TaskService(mockApi);
      mockClient.request.mockResolvedValue({
        code: 0,
        data: { task_id: 'task-new', summary: 'New Task' },
      });

      const result = await service.createTask({ summary: 'New Task' });
      expect(result.taskId).toBe('task-new');
    });
  });

  describe('ApprovalService', () => {
    it('should list instances', async () => {
      const service = new ApprovalService(mockApi);
      mockClient.request.mockResolvedValue({
        code: 0,
        data: {
          items: [{ instance_id: 'inst-1', approval_code: 'code-1', status: 'pending' }],
          has_more: false,
        },
      });

      const result = await service.listInstances();
      expect(result.instances).toHaveLength(1);
      expect(result.instances[0].instanceId).toBe('inst-1');
    });

    it('should approve instance', async () => {
      const service = new ApprovalService(mockApi);
      mockClient.request.mockResolvedValue({ code: 0, data: {} });

      await service.approveInstance('inst-1', 'Approved');
      expect(mockClient.request).toHaveBeenCalledWith(expect.objectContaining({
        method: 'POST',
        url: '/open-apis/approval/v4/instances/inst-1/approve',
      }));
    });
  });
});

describe('ProfileManager', () => {
  const testProfilesDir = '/tmp/test-feishu-profiles';

  beforeEach(() => {
    try {
      require('fs').rmSync(testProfilesDir, { recursive: true });
    } catch {}
  });

  afterEach(() => {
    try {
      require('fs').rmSync(testProfilesDir, { recursive: true });
    } catch {}
  });

  it('should create and list profiles', () => {
    const mgr = new ProfileManager(testProfilesDir);
    const config = {
      appId: 'cli_test123',
      domain: 'feishu' as const,
      opencodeUrl: 'http://localhost:19876',
      streaming: true,
      requireMention: true,
      groupPolicy: 'allowlist' as const,
    };

    mgr.save('test', config);
    const profiles = mgr.list();

    expect(profiles).toHaveLength(1);
    expect(profiles[0].name).toBe('test');
    expect(profiles[0].isActive).toBe(false);
  });

  it('should activate a profile', () => {
    const mgr = new ProfileManager(testProfilesDir);
    const config = {
      appId: 'cli_test123',
      domain: 'feishu' as const,
      opencodeUrl: 'http://localhost:19876',
      streaming: true,
      requireMention: true,
      groupPolicy: 'allowlist' as const,
    };

    mgr.save('test', config);
    mgr.use('test');

    const active = mgr.getActive();
    expect(active?.name).toBe('test');
    expect(active?.config.appId).toBe('cli_test123');
  });

  it('should delete a profile', () => {
    const mgr = new ProfileManager(testProfilesDir);
    const config = {
      appId: 'cli_test123',
      domain: 'feishu' as const,
      opencodeUrl: 'http://localhost:19876',
      streaming: true,
      requireMention: true,
      groupPolicy: 'allowlist' as const,
    };

    mgr.save('test', config);
    expect(mgr.list()).toHaveLength(1);

    mgr.delete('test');
    expect(mgr.list()).toHaveLength(0);
  });

  it('should rename a profile', () => {
    const mgr = new ProfileManager(testProfilesDir);
    const config = {
      appId: 'cli_test123',
      domain: 'feishu' as const,
      opencodeUrl: 'http://localhost:19876',
      streaming: true,
      requireMention: true,
      groupPolicy: 'allowlist' as const,
    };

    mgr.save('old', config);
    mgr.use('old');

    mgr.rename('old', 'new');
    expect(mgr.list()[0].name).toBe('new');
    expect(mgr.getActive()?.name).toBe('new');
  });

  it('should clone a profile', () => {
    const mgr = new ProfileManager(testProfilesDir);
    const config = {
      appId: 'cli_test123',
      domain: 'feishu' as const,
      opencodeUrl: 'http://localhost:19876',
      streaming: true,
      requireMention: true,
      groupPolicy: 'allowlist' as const,
    };

    mgr.save('source', config);
    mgr.clone('source', 'target');

    const profiles = mgr.list();
    expect(profiles).toHaveLength(2);
    expect(profiles.find(p => p.name === 'target')).toBeDefined();
  });
});
