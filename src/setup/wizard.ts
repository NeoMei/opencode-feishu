import inquirer from 'inquirer';
import { ConfigManager } from '../core/config.js';
import type { FeishuConfig } from '../core/types.js';
import { createLogger } from '../core/logger.js';
import * as preflight from './preflight.js';
import { requestAppRegistration, displayQRCode, pollAppRegistration } from './device-flow.js';

const log = createLogger('SetupWizard');

interface CommonOptions {
  opencodeUrl: string;
  streaming: boolean;
  requireMention: boolean;
  thinkingLanguage: 'chinese' | 'english';
  allowlist: string;
}

export class SetupWizard {
  private configManager: ConfigManager;
  private existingConfig?: FeishuConfig;

  constructor(configPath?: string) {
    this.configManager = new ConfigManager(configPath);
  }

  async run(): Promise<FeishuConfig> {
    console.log('🎯 OpenCode 飞书插件配置向导\n');
    console.log('💡 本插件功能：');
    console.log('   • 支持私聊和群聊（需@机器人）');
    console.log('   • 支持文本、图片、文件、语音、视频消息');
    console.log('   • AI 回复实时流式显示');
    console.log('   • 消息去重和用户名显示');
    console.log('   • 飞书文档：创建、读取、编辑、搜索、分享');
    console.log('   • 日历日程：查看、创建、管理日程');
    console.log('   • 任务管理：创建、分配、跟踪任务');
    console.log('   • 审批流程：查询、批准、拒绝审批');
    console.log('   • 多配置管理：支持多个飞书应用配置\n');

    // If a config already exists, run preflight and let the user skip reconfiguring
    if (this.configManager.exists()) {
      this.existingConfig = this.configManager.load();
      console.log('📋 检测到现有配置，正在运行 preflight 检查...\n');
      const results = await preflight.runAll(this.existingConfig, {
        configPath: this.configManager.getConfigPath(),
      });
      for (const r of results) {
        console.log(`   ${r.ok ? '✅' : '❌'} ${r.label}${r.detail ? '  —  ' + r.detail : ''}`);
        if (!r.ok && r.fix) console.log(`       🛠  ${r.fix}`);
      }
      console.log();

      if (results.every(r => r.ok)) {
        const { reconfigure } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'reconfigure',
            message: '所有检查通过。要重新配置吗？',
            default: false,
          },
        ]);
        if (!reconfigure) {
          console.log('保持现有配置。运行 `opencode-feishu start` 启动插件。\n');
          return this.existingConfig;
        }
      }
    }

    // Ask user which mode
    const mode = await this.promptSetupMode();

    let config: FeishuConfig;
    if (mode === 'scan') {
      try {
        config = await this.runScanSetup();
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log.warn({ err }, 'Scan setup failed');
        console.log(`\n⚠️ 扫码创建应用失败：${reason}`);
        console.log('   切换到手动配置模式...\n');
        config = await this.runManualSetup();
      }
    } else {
      config = await this.runManualSetup();
    }

    // Save configuration
    this.configManager.save(config);

    console.log('\n✅ 配置已保存！');
    console.log(`📁 配置文件: ${this.configManager.getConfigPath()}`);

    // Ask about advanced features
    await this.promptAdvancedHints();

    console.log('\n🚀 启动插件:');
    console.log('   opencode-feishu start\n');

    return config;
  }

  /** Ask whether to use scan or manual mode. */
  private async promptSetupMode(): Promise<'scan' | 'manual'> {
    const { mode } = await inquirer.prompt([
      {
        type: 'list',
        name: 'mode',
        message: '选择配置方式：',
        choices: [
          { name: '📱 扫码创建应用（推荐，自动获取凭证）', value: 'scan' },
          { name: '📝 手动输入 App ID / App Secret', value: 'manual' },
        ],
        default: 'scan',
      },
    ]);
    return mode;
  }

  /**
   * Shared prompt for common options used by both scan and manual setup.
   * Falls back to existing config values when reconfiguring.
   */
  private async promptCommonOptions(defaults?: Partial<CommonOptions>): Promise<CommonOptions> {
    return inquirer.prompt([
      {
        type: 'input',
        name: 'opencodeUrl',
        message: 'OpenCode 服务器地址 (默认本地，需先运行 opencode serve --port 19876):',
        default: defaults?.opencodeUrl || this.existingConfig?.opencodeUrl || 'http://localhost:19876',
        validate: (input: string) => {
          try { new URL(input); return true; }
          catch { return '请输入有效的 URL'; }
        },
      },
      {
        type: 'confirm',
        name: 'streaming',
        message: '启用流式输出？',
        default: defaults?.streaming !== undefined
          ? defaults.streaming
          : (this.existingConfig?.streaming !== undefined ? this.existingConfig.streaming : true),
      },
      {
        type: 'confirm',
        name: 'requireMention',
        message: '群聊中需要 @机器人才回复？',
        default: defaults?.requireMention !== undefined
          ? defaults.requireMention
          : (this.existingConfig?.requireMention !== undefined ? this.existingConfig.requireMention : true),
      },
      {
        type: 'list',
        name: 'thinkingLanguage',
        message: 'AI 思考过程显示语言：',
        choices: [
          { name: '简体中文（强制中文思考）', value: 'chinese' },
          { name: '英文（保持原始英文思考）', value: 'english' },
        ],
        default: defaults?.thinkingLanguage || this.existingConfig?.thinkingLanguage || 'chinese',
      },
      {
        type: 'input',
        name: 'allowlist',
        message: '用户白名单（union_id，逗号分隔，留空表示不限制）:',
        default: defaults?.allowlist
          || (this.existingConfig?.allowlist?.length ? this.existingConfig.allowlist.join(', ') : ''),
      },
    ]);
  }

  private async runScanSetup(): Promise<FeishuConfig> {
    console.log('\n📱 扫码创建应用模式\n');
    console.log('这将通过飞书扫码自动创建应用并获取凭证。\n');

    console.log('🔄 正在请求设备授权...');
    const authResp = await requestAppRegistration();

    await displayQRCode(authResp.verificationUriComplete);

    console.log('⏳ 等待扫码确认（有效期 ' + authResp.expiresIn + ' 秒）...');
    const result = await pollAppRegistration(
      authResp.deviceCode,
      authResp.interval,
      authResp.expiresIn,
    );

    console.log('\n✅ 应用创建成功！');
    console.log(`   App ID: ${result.clientID}`);
    console.log('   App Secret: **** (已保存)');

    if (result.userInfo) {
      console.log(`   租户: ${result.userInfo.tenantBrand}`);
    }

    // Verify the new credentials actually work before proceeding
    console.log('\n🧪 验证凭证...');
    const isValid = await this.verifyFeishuCredentials(
      result.clientID,
      result.clientSecret,
      'feishu',
    );

    if (!isValid) {
      console.log('\n⚠️ 应用已创建但凭证验证未通过。');
      console.log('   请前往飞书开放平台确认：');
      console.log('   1. 已开启「机器人」能力');
      console.log('   2. 应用已发布');
      console.log('   3. 稍后运行 `opencode-feishu doctor` 检查状态\n');
    } else {
      console.log('✅ 凭证验证通过\n');
    }

    const common = await this.promptCommonOptions();

    return {
      appId: result.clientID,
      appSecret: result.clientSecret,
      domain: 'feishu',
      opencodeUrl: common.opencodeUrl,
      streaming: common.streaming,
      requireMention: common.requireMention,
      thinkingLanguage: common.thinkingLanguage,
      groupPolicy: 'allowlist',
      allowlist: common.allowlist ? common.allowlist.split(/[,，\s]+/).filter(Boolean) : [],
    };
  }

  private async runManualSetup(): Promise<FeishuConfig> {
    console.log('\n📝 手动配置模式\n');

    // Loop until credentials are verified or user gives up
    while (true) {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'appId',
          message: '请输入飞书 App ID (格式: cli_xxx，在「凭证与基础信息」页面获取):',
          default: this.existingConfig?.appId,
          validate: (input: string) => {
            if (!input.startsWith('cli_')) return 'App ID 应以 cli_ 开头';
            return true;
          },
        },
        {
          type: 'password',
          name: 'appSecret',
          message: '请输入飞书 App Secret (在同一页面的「App Secret」字段，点击「查看」获取):',
          mask: '*',
          validate: (input: string) => input.length >= 10 || 'App Secret 格式不正确',
        },
        {
          type: 'list',
          name: 'domain',
          message: '选择域名：',
          choices: [
            { name: '飞书 (open.feishu.cn)', value: 'feishu' },
            { name: 'Lark (open.larksuite.com)', value: 'lark' },
          ],
          default: this.existingConfig?.domain || 'feishu',
        },
      ]);

      console.log('\n🧪 验证凭证...');
      const isValid = await this.verifyFeishuCredentials(
        answers.appId,
        answers.appSecret,
        answers.domain,
      );

      if (isValid) {
        console.log('✅ 验证通过！\n');

        const common = await this.promptCommonOptions();

        return {
          appId: answers.appId,
          appSecret: answers.appSecret,
          domain: answers.domain,
          opencodeUrl: common.opencodeUrl,
          streaming: common.streaming,
          requireMention: common.requireMention,
          thinkingLanguage: common.thinkingLanguage,
          groupPolicy: 'allowlist',
          allowlist: common.allowlist ? common.allowlist.split(/[,，\s]+/).filter(Boolean) : [],
        };
      }

      console.log('\n❌ 验证失败：请检查 App ID / App Secret 是否正确、应用是否已发布。');

      const { retry } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'retry',
          message: '是否重试？',
          default: true,
        },
      ]);

      if (!retry) {
        throw new Error('Feishu credentials check failed — user chose not to retry');
      }
      console.log();
    }
  }

  /** Ask whether to show advanced permission hints, and display if yes. */
  private async promptAdvancedHints(): Promise<void> {
    const { show } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'show',
        message: '是否需要文档/日历/任务/审批等高级功能权限配置指引？',
        default: false,
      },
    ]);
    if (show) this.printPermissionHints();
  }

  /** Print permission hints for document and other advanced features. */
  private printPermissionHints(): void {
    console.log('\n📋 如需使用完整功能，请在飞书开放平台添加以下权限：');
    console.log('   文档功能：');
    console.log('     • docx:document (创建和管理文档)');
    console.log('     • docx:document:readonly (读取文档)');
    console.log('     • drive:drive (云空间操作)');
    console.log('   日历功能：');
    console.log('     • calendar:calendar (管理日历和日程)');
    console.log('     • calendar:calendar:readonly (读取日历)');
    console.log('   任务功能：');
    console.log('     • task:task (管理任务)');
    console.log('   审批功能：');
    console.log('     • approval:instance (查询审批实例)');
    console.log('\n💡 添加路径：飞书开放平台 → 权限管理 → 搜索并添加\n');
  }

  private async verifyFeishuCredentials(
    appId: string,
    appSecret: string,
    domain: 'feishu' | 'lark',
  ): Promise<boolean> {
    const result = await preflight.checkFeishuCredentials(appId, appSecret, domain);
    if (!result.ok) {
      log.error({ detail: result.detail, fix: result.fix }, 'verifyFeishuCredentials failed');
    }
    return result.ok;
  }
}
