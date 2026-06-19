import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import * as fs from 'fs';
import * as path from 'path';

export class OpenCodeClient {
  private client: ReturnType<typeof createOpencodeClient>;
  private baseUrl: string;
  private directory: string;

  constructor(options: { baseUrl: string; directory?: string; password?: string }) {
    this.baseUrl = options.baseUrl;
    this.directory = options.directory || process.cwd();
    
    const config: any = {
      baseUrl: this.baseUrl,
      directory: this.directory,
    };
    
    // 如果提供了密码，添加到请求头
    if (options.password) {
      config.headers = {
        'Authorization': `Basic ${Buffer.from(`opencode:${options.password}`).toString('base64')}`
      };
    }
    
    this.client = createOpencodeClient(config);
  }

  private formatError(error: unknown): string { return String(error instanceof Error ? error.message : error); }

  async createSession(title?: string): Promise<any> {
    const { data, error } = await this.client.session.create({
      title: title || 'Feishu Chat',
    });

    if (error) {
      throw new Error(`Failed to create session: ${this.formatError(error)}`);
    }

    return data;
  }

  async sendPrompt(sessionId: string, text: string, files?: Array<{ filePath: string; fileName: string; mimeType: string }>, thinkingLanguage?: 'chinese' | 'english', model?: { providerID: string; modelID: string }): Promise<any> {
    // Prepend system instruction based on thinkingLanguage setting
    let fullText = text;
    if (thinkingLanguage === 'chinese') {
      const chineseThinkingPrefix = '[系统指令：请全程使用简体中文进行思考和推理，包括分析过程、工具调用说明和中间步骤。最终回答可以保持用户要求的语言。]';
      fullText = `${chineseThinkingPrefix}\n\n${text}`;
    }
    
    const parts: any[] = [{ type: 'text', text: fullText }];

    if (files && files.length > 0) {
      for (const file of files) {
        parts.push({
          type: 'file',
          file: {
            path: file.filePath,
            name: file.fileName,
            mimeType: file.mimeType,
          },
        });
      }
    }

    // Use promptAsync so the call returns immediately instead of blocking
    // until the AI finishes. Responses arrive through the event stream.
    const params: any = {
      sessionID: sessionId,
      parts,
    };
    if (model) {
      params.model = model;
    }

    const { data, error } = await this.client.session.promptAsync(params);

    if (error) {
      throw new Error(`Failed to send prompt: ${this.formatError(error)}`);
    }

    return data;
  }

  async subscribeEvents(): Promise<any> {
    const events = await this.client.global.event({});
    return events;
  }

  async getSessionStatus(): Promise<Record<string, { type: string }>> {
    const { data, error } = await this.client.session.status({});

    if (error) {
      throw new Error(`Failed to get session status: ${this.formatError(error)}`);
    }

    return data || {};
  }

  async listSessions(): Promise<any[]> {
    const { data, error } = await this.client.session.list({});

    if (error) {
      throw new Error(`Failed to list sessions: ${this.formatError(error)}`);
    }

    return data || [];
  }

  async abortSession(sessionId: string): Promise<void> {
    await this.client.session.abort({
      sessionID: sessionId,
    });
  }

  /**
   * Probe whether an OpenCode session still exists server-side.
   * Used by SessionManager to reconcile persisted chat→session mappings
   * against the server (sessions may have been deleted externally).
   */
  async sessionExists(sessionId: string): Promise<boolean> {
    try {
      const { data, error } = await this.client.session.get({ sessionID: sessionId });
      if (error) return false;
      return !!data;
    } catch {
      return false;
    }
  }

  async replyPermission(requestID: string, reply: 'once' | 'always' | 'reject'): Promise<boolean> {
    const { data, error } = await this.client.permission.reply({
      requestID,
      reply,
    });

    if (error) {
      throw new Error(`Failed to reply to permission: ${this.formatError(error)}`);
    }

    return !!data;
  }

  async replyQuestion(requestID: string, answers: string[][]): Promise<boolean> {
    const { data, error } = await this.client.question.reply({
      requestID,
      answers,
    });

    if (error) {
      throw new Error(`Failed to reply to question: ${this.formatError(error)}`);
    }

    return !!data;
  }

  async sendCommand(sessionId: string, command: string, args?: string): Promise<any> {
    const { data, error } = await this.client.session.command({
      sessionID: sessionId,
      command,
      arguments: args || '',
    });

    if (error) {
      // Pass the original error object so the caller can extract meaningful messages
      throw error;
    }

    return data;
  }

  async executeTuiCommand(command: string): Promise<any> {
    const { data, error } = await this.client.tui.executeCommand({
      directory: this.directory,
      command,
    });

    if (error) {
      throw new Error(`Failed to execute TUI command: ${this.formatError(error)}`);
    }

    return data;
  }

  async getProviders(): Promise<any> {
    const { data, error } = await this.client.config.providers({
      directory: this.directory,
    });

    if (error) {
      throw new Error(`Failed to get providers: ${this.formatError(error)}`);
    }

    return data;
  }

  async getAgents(): Promise<any> {
    const { data, error } = await this.client.app.agents({
      directory: this.directory,
    });

    if (error) {
      throw new Error(`Failed to get agents: ${this.formatError(error)}`);
    }

    return data;
  }

  async getCommands(): Promise<any> {
    const { data, error } = await this.client.command.list({
      directory: this.directory,
    });

    if (error) {
      throw new Error(`Failed to get commands: ${this.formatError(error)}`);
    }

    return data;
  }

  async getSessions(): Promise<any> {
    const { data, error } = await this.client.session.list({
      directory: this.directory,
      roots: true,
    });

    if (error) {
      throw new Error(`Failed to get sessions: ${this.formatError(error)}`);
    }

    return data;
  }

  async getTools(): Promise<any> {
    const { data, error } = await this.client.tool.ids({
      directory: this.directory,
    });

    if (error) {
      throw new Error(`Failed to get tools: ${this.formatError(error)}`);
    }

    return data;
  }

  async getWorktrees(): Promise<any> {
    const { data, error } = await this.client.worktree.list({
      directory: this.directory,
    });

    if (error) {
      throw new Error(`Failed to get worktrees: ${this.formatError(error)}`);
    }

    return data;
  }

  async getFiles(path?: string): Promise<any> {
    const { data, error } = await this.client.file.list({
      directory: this.directory,
      path: path || '.',
    });

    if (error) {
      throw new Error(`Failed to get files: ${this.formatError(error)}`);
    }

    return data;
  }

  async getStatus(): Promise<any> {
    const { data, error } = await this.client.file.status({
      directory: this.directory,
    });

    if (error) {
      throw new Error(`Failed to get status: ${this.formatError(error)}`);
    }

    return data;
  }

  async getConfig(): Promise<any> {
    const { data, error } = await this.client.config.get({
      directory: this.directory,
    });

    if (error) {
      throw new Error(`Failed to get config: ${this.formatError(error)}`);
    }

    return data;
  }

  async updateConfig(config: { model?: string; [key: string]: unknown }): Promise<any> {
    const { data, error } = await this.client.config.update({
      directory: this.directory,
      config,
    });

    if (error) {
      throw new Error(`Failed to update config: ${this.formatError(error)}`);
    }

    if (config.model || config.default_agent) {
      // 优先使用 opencode.json（新版本），回退到 config.json（旧版本）
      const configDir = path.join(this.directory, '.opencode');
      let configPath = path.join(configDir, 'opencode.json');
      if (!fs.existsSync(configPath)) {
        configPath = path.join(configDir, 'config.json');
      }
      try {
        const existing = fs.existsSync(configPath)
          ? JSON.parse(fs.readFileSync(configPath, 'utf-8'))
          : {};
        if (config.model) existing.model = config.model;
        if (config.default_agent) existing.default_agent = config.default_agent;
        fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n');
      } catch (err) {
        throw new Error(`Failed to write config file: ${this.formatError(err)}`);
      }
    }

    return data;
  }

  async listProviders(): Promise<any> {
    const { data, error } = await this.client.provider.list({
      directory: this.directory,
    });

    if (error) {
      throw new Error(`Failed to list providers: ${this.formatError(error)}`);
    }

    return data;
  }

  async deleteSession(sessionId: string): Promise<any> {
    const { data, error } = await this.client.session.delete({
      sessionID: sessionId,
      directory: this.directory,
    });
    if (error) {
      throw new Error(`Failed to delete session: ${this.formatError(error)}`);
    }
    return data;
  }

  async selectSession(sessionId: string): Promise<any> {
    const { data, error } = await this.client.tui.selectSession({
      sessionID: sessionId,
      directory: this.directory,
    });
    if (error) {
      throw new Error(`Failed to select session: ${this.formatError(error)}`);
    }
    return data;
  }

  async getVcsInfo(): Promise<any> {
    const { data, error } = await this.client.vcs.get({
      directory: this.directory,
    });
    if (error) {
      throw new Error(`Failed to get VCS info: ${this.formatError(error)}`);
    }
    return data;
  }

  async getVcsDiff(mode: 'git' | 'branch' = 'git'): Promise<any> {
    const { data, error } = await this.client.vcs.diff({
      directory: this.directory,
      mode,
    });
    if (error) {
      throw new Error(`Failed to get VCS diff: ${this.formatError(error)}`);
    }
    return data;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getDirectory(): string {
    return this.directory;
  }
}
