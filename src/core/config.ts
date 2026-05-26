import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type { FeishuConfig } from './types.js';

const HookConfigSchema = z.object({
  onSessionCreated: z.string().optional(),
  onSessionIdle: z.string().optional(),
}).optional();

const FeishuConfigSchema = z.object({
  appId: z.string().startsWith('cli_'),
  appSecret: z.string().min(1).optional(),
  domain: z.enum(['feishu', 'lark']).default('feishu'),
  opencodeUrl: z.string().url().default('http://localhost:19876'),
  opencodePassword: z.string().optional(),
  streaming: z.boolean().default(true),
  requireMention: z.boolean().default(true),
  groupPolicy: z.enum(['open', 'allowlist', 'disabled']).default('allowlist'),
  allowlist: z.array(z.string()).optional(),
  dedupTtl: z.number().min(0).optional(),
  hooks: HookConfigSchema,
  showProcess: z.enum(['none', 'tools', 'thinking', 'full']).default('none'),
  /** Auto-approve all permission requests without user interaction. */
  autoApprove: z.boolean().default(true),
  workdir: z.string().optional(),
  thinkingLanguage: z.enum(['chinese', 'english']).default('chinese'),
  /** Display name for the bot in card headers. Overrides auto-detection from soul/IDENTITY.md. */
  botName: z.string().optional(),
});

/**
 * Resolve the app secret in priority order: FEISHU_APP_SECRET env > config file.
 * Throws a clear error if neither is set — the SDK can't auth without it.
 */
export function resolveAppSecret(config: FeishuConfig): string {
  const fromEnv = process.env.FEISHU_APP_SECRET?.trim();
  if (fromEnv) return fromEnv;
  if (config.appSecret) return config.appSecret;
  throw new Error(
    'Feishu app secret is missing. Set it in ~/.config/opencode/feishu.json ' +
    '(`appSecret` field) or via the FEISHU_APP_SECRET environment variable.',
  );
}

export class ConfigManager {
  private configPath: string;
  private config?: FeishuConfig;

  constructor(configPath?: string) {
    this.configPath = configPath || this.resolveConfigPath();
  }

  private getDefaultConfigPath(): string {
    return join(homedir(), '.config', 'opencode', 'feishu.json');
  }

  private resolveConfigPath(): string {
    // Check if there's an active profile
    try {
      const activeProfilePath = join(homedir(), '.config', 'opencode', 'feishu-active-profile');
      if (existsSync(activeProfilePath)) {
        const activeName = readFileSync(activeProfilePath, 'utf-8').trim();
        if (activeName) {
          const profilePath = join(homedir(), '.config', 'opencode', 'feishu-profiles', `${activeName}.json`);
          if (existsSync(profilePath)) {
            return profilePath;
          }
        }
      }
    } catch {
      // No active profile or error reading it
    }
    return this.getDefaultConfigPath();
  }

  load(): FeishuConfig {
    if (this.config) {
      return this.config;
    }

    if (!existsSync(this.configPath)) {
      throw new Error(
        `Configuration file not found: ${this.configPath}\n` +
        'Please run: opencode-feishu setup'
      );
    }

    try {
      const content = readFileSync(this.configPath, 'utf-8');
      const parsed = JSON.parse(content);
      this.config = FeishuConfigSchema.parse(parsed);
      return this.config;
    } catch (error) {
      if (error instanceof z.ZodError) {
        const issues = error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('\n');
        throw new Error(`Invalid configuration:\n${issues}`);
      }
      throw error;
    }
  }

  save(config: FeishuConfig): void {
    const validated = FeishuConfigSchema.parse(config);
    const dir = dirname(this.configPath);
    
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(this.configPath, JSON.stringify(validated, null, 2));
    this.config = validated;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  exists(): boolean {
    return existsSync(this.configPath);
  }
}

/**
 * Parse display name from project's soul/IDENTITY.md.
 * Priority: config.botName > projectDir/soul/IDENTITY.md > "opencode"
 */
export function parseBotName(projectDir: string, configBotName?: string): string {
  // 0. Explicit config override
  if (configBotName) return configBotName;

  // 1. Project-local soul config
  const nameRegex = /\*\*Name:?\*{0,2}:?\s*(.+)/;
  try {
    const content = readFileSync(join(projectDir, 'soul', 'IDENTITY.md'), 'utf-8');
    const match = content.match(nameRegex);
    if (match?.[1]) return match[1].trim();
  } catch {}

  // 2. Default
  return 'opencode';
}

export { FeishuConfigSchema };
export type { FeishuConfig };
