import { existsSync, accessSync, constants } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import * as Lark from '@larksuiteoapi/node-sdk';
import type { FeishuConfig } from '../core/types.js';
import { silentLogger } from '../feishu/silent-logger.js';

/**
 * Preflight checks — pure functions, no console output.
 * Each returns a structured result so the caller (doctor CLI, wizard,
 * or status probe) can render/act on it consistently.
 */

export interface CheckResult {
  ok: boolean;
  /** Short human-readable name. */
  label: string;
  /** Optional extra context when `ok` is false — or noteworthy info when true. */
  detail?: string;
  /** Optional remediation hint shown to the user on failure. */
  fix?: string;
}

const DEFAULT_CONFIG_PATH = join(homedir(), '.config', 'opencode', 'feishu.json');

export async function checkConfigFile(configPath = DEFAULT_CONFIG_PATH): Promise<CheckResult> {
  if (!existsSync(configPath)) {
    return {
      ok: false,
      label: 'Config file present',
      detail: `Not found at ${configPath}`,
      fix: 'Run: opencode-feishu setup',
    };
  }
  return { ok: true, label: 'Config file present', detail: configPath };
}

export async function checkConfigWritable(configPath = DEFAULT_CONFIG_PATH): Promise<CheckResult> {
  const dir = dirname(configPath);
  try {
    // Directory must exist & be writable. File may not exist yet.
    accessSync(dir, constants.W_OK);
    return { ok: true, label: 'Config directory writable', detail: dir };
  } catch {
    return {
      ok: false,
      label: 'Config directory writable',
      detail: `Cannot write to ${dir}`,
      fix: `Check permissions or run: mkdir -p ${dir} && chmod u+w ${dir}`,
    };
  }
}

export async function checkFeishuCredentials(
  appId: string | undefined,
  appSecret: string | undefined,
  domain: 'feishu' | 'lark' = 'feishu',
): Promise<CheckResult> {
  if (!appId || !appId.startsWith('cli_')) {
    return {
      ok: false,
      label: 'Feishu credentials',
      detail: 'App ID missing or not in cli_xxx format',
      fix: 'Set `appId` in config (should start with cli_)',
    };
  }
  if (!appSecret) {
    return {
      ok: false,
      label: 'Feishu credentials',
      detail: 'App secret missing',
      fix: 'Set `appSecret` in config or export FEISHU_APP_SECRET',
    };
  }

  try {
    const client = new Lark.Client({
      appId,
      appSecret,
      domain: domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
      logger: silentLogger,
    });
    const res: any = await client.request({
      method: 'GET',
      url: '/open-apis/bot/v3/info',
    });
    const openId: string | undefined = res?.bot?.open_id || res?.data?.bot?.open_id;
    if (!openId) {
      return {
        ok: false,
        label: 'Feishu credentials',
        detail: 'Credentials accepted but /bot/v3/info returned no open_id — bot ability may be disabled on the app',
        fix: 'Enable "机器人" ability in Feishu console and republish the app',
      };
    }
    return { ok: true, label: 'Feishu credentials', detail: `bot open_id=${openId}` };
  } catch (err: any) {
    const msg = err?.message || String(err);
    return {
      ok: false,
      label: 'Feishu credentials',
      detail: `SDK call failed: ${msg.substring(0, 120)}`,
      fix: 'Verify appId/appSecret match the Feishu console; confirm the app is published',
    };
  }
}

export async function checkOpenCodeServer(url: string, password?: string): Promise<CheckResult> {
  try {
    const u = new URL(url);
    
    // Compatible timeout for Node.js < 16.14.0
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    
    try {
      const headers: Record<string, string> = {};
      if (password) {
        headers['Authorization'] = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
      }
      const res = await fetch(`${u.origin}/session`, {
        signal: controller.signal,
        headers,
      });
      if (!res.ok && res.status !== 401 && res.status !== 404) {
        return {
          ok: false,
          label: 'OpenCode server reachable',
          detail: `HTTP ${res.status} at ${url}`,
          fix: `Start it with: opencode serve --port ${u.port || '19876'}`,
        };
      }
      return { ok: true, label: 'OpenCode server reachable', detail: url };
    } finally {
      clearTimeout(timeout);
    }
  } catch (err: any) {
    const msg = err?.message || String(err);
    return {
      ok: false,
      label: 'OpenCode server reachable',
      detail: `${msg.substring(0, 120)} at ${url}`,
      fix: `Start it with: opencode serve --port ${new URL(url).port || '19876'}`,
    };
  }
}

export async function checkAllowlist(config: FeishuConfig | null): Promise<CheckResult> {
  if (!config) {
    return {
      ok: true,
      label: 'Allowlist check',
      detail: 'No config loaded, skipping allowlist check',
    };
  }

  if (config.groupPolicy === 'allowlist') {
    const hasAllowlist = config.allowlist && config.allowlist.length > 0;
    if (!hasAllowlist) {
      return {
        ok: false,
        label: 'Allowlist configuration',
        detail: 'groupPolicy is set to "allowlist" but allowlist is empty',
        fix: 'Add user open_ids to allowlist in config, or change groupPolicy to "open" or "disabled"',
      };
    }
    return {
      ok: true,
      label: 'Allowlist configuration',
      detail: `Allowlist contains ${config.allowlist?.length || 0} user(s)`,
    };
  }

  return {
    ok: true,
    label: 'Allowlist configuration',
    detail: `groupPolicy is "${config.groupPolicy}"`,
  };
}

/**
 * Determine whether an SDK error truly indicates "permission denied".
 * Feishu usually returns HTTP 200 with a business error code for missing
 * scopes, so HTTP 400/404 exceptions are typically request-format issues,
 * not auth issues.
 */
function isPermissionDenied(err: any): boolean {
  const code = err?.code;
  const msg = err?.message || '';

  // Known Feishu permission-denied codes
  const deniedCodes = [99991663, 99991664, 99991671, 11200];
  if (deniedCodes.includes(code)) return true;

  // HTTP-level errors (400, 404) are usually not permission problems
  if (msg.includes('status code 400') || msg.includes('status code 404')) return false;

  // Conservative fallback for unknown errors
  return true;
}

export async function checkPermissions(
  appId: string | undefined,
  appSecret: string | undefined,
  domain: 'feishu' | 'lark' = 'feishu',
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  
  if (!appId || !appSecret) {
    return [{
      ok: false,
      label: 'Permission check',
      detail: 'Cannot check permissions without valid credentials',
      fix: 'Configure appId and appSecret first',
    }];
  }

  try {
    const client = new Lark.Client({
      appId,
      appSecret,
      domain: domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
      logger: silentLogger,
    });

    // Check IM permissions
    try {
      const imRes: any = await client.request({
        method: 'GET',
        url: '/open-apis/im/v1/messages',
        params: { container_id_type: 'chat', container_id: 'test', page_size: 1 },
      });
      results.push({
        ok: imRes.code === 0 || imRes.code === 10002, // 10002 = invalid chat_id, which means permission is OK
        label: 'IM permission (im:message)',
        detail: imRes.code === 0 || imRes.code === 10002 ? 'Granted' : `Denied: ${imRes.msg}`,
        fix: imRes.code !== 0 && imRes.code !== 10002 ? 'Enable "im:message" scope in Feishu console' : undefined,
      });
    } catch (err: any) {
      if (isPermissionDenied(err)) {
        results.push({
          ok: false,
          label: 'IM permission (im:message)',
          detail: `Denied: ${err.message}`,
          fix: 'Enable "im:message" scope in Feishu console',
        });
      } else {
        results.push({
          ok: true,
          label: 'IM permission (im:message)',
          detail: 'Granted (API reachable)',
        });
      }
    }

    // Check contact permissions
    try {
      const contactRes: any = await client.request({
        method: 'GET',
        url: '/open-apis/contact/v3/users',
        params: { user_id_type: 'open_id', page_size: 1 },
      });
      results.push({
        ok: contactRes.code === 0 || contactRes.code === 10002,
        label: 'Contact permission (contact:user)',
        detail: contactRes.code === 0 || contactRes.code === 10002 ? 'Granted' : `Denied: ${contactRes.msg}`,
        fix: contactRes.code !== 0 && contactRes.code !== 10002 ? 'Enable "contact:user" scope in Feishu console' : undefined,
      });
    } catch (err: any) {
      if (isPermissionDenied(err)) {
        results.push({
          ok: false,
          label: 'Contact permission (contact:user)',
          detail: `Denied: ${err.message}`,
          fix: 'Enable "contact:user" scope in Feishu console',
        });
      } else {
        results.push({
          ok: true,
          label: 'Contact permission (contact:user)',
          detail: 'Granted (API reachable)',
        });
      }
    }

    // Check calendar permissions
    try {
      const calRes: any = await client.request({
        method: 'GET',
        url: '/open-apis/calendar/v4/calendars',
        params: { page_size: 1 },
      });
      results.push({
        ok: calRes.code === 0 || calRes.code === 10002,
        label: 'Calendar permission (calendar:calendar)',
        detail: calRes.code === 0 || calRes.code === 10002 ? 'Granted' : `Denied: ${calRes.msg}`,
        fix: calRes.code !== 0 && calRes.code !== 10002 ? 'Enable "calendar:calendar" scope in Feishu console' : undefined,
      });
    } catch (err: any) {
      if (isPermissionDenied(err)) {
        results.push({
          ok: false,
          label: 'Calendar permission (calendar:calendar)',
          detail: `Denied: ${err.message}`,
          fix: 'Enable "calendar:calendar" scope in Feishu console',
        });
      } else {
        results.push({
          ok: true,
          label: 'Calendar permission (calendar:calendar)',
          detail: 'Granted (API reachable)',
        });
      }
    }

    // Check task permissions
    try {
      const taskRes: any = await client.request({
        method: 'GET',
        url: '/open-apis/task/v2/tasks',
        params: { page_size: 1 },
      });
      results.push({
        ok: taskRes.code === 0 || taskRes.code === 10002,
        label: 'Task permission (task:task)',
        detail: taskRes.code === 0 || taskRes.code === 10002 ? 'Granted' : `Denied: ${taskRes.msg}`,
        fix: taskRes.code !== 0 && taskRes.code !== 10002 ? 'Enable "task:task" scope in Feishu console' : undefined,
      });
    } catch (err: any) {
      if (isPermissionDenied(err)) {
        results.push({
          ok: false,
          label: 'Task permission (task:task)',
          detail: `Denied: ${err.message}`,
          fix: 'Enable "task:task" scope in Feishu console',
        });
      } else {
        results.push({
          ok: true,
          label: 'Task permission (task:task)',
          detail: 'Granted (API reachable)',
        });
      }
    }

    // Check approval permissions
    try {
      const approvalRes: any = await client.request({
        method: 'GET',
        url: '/open-apis/approval/v4/instances',
        params: { page_size: 1 },
      });
      results.push({
        ok: approvalRes.code === 0 || approvalRes.code === 10002,
        label: 'Approval permission (approval:instance)',
        detail: approvalRes.code === 0 || approvalRes.code === 10002 ? 'Granted' : `Denied: ${approvalRes.msg}`,
        fix: approvalRes.code !== 0 && approvalRes.code !== 10002 ? 'Enable "approval:instance" scope in Feishu console' : undefined,
      });
    } catch (err: any) {
      if (isPermissionDenied(err)) {
        results.push({
          ok: false,
          label: 'Approval permission (approval:instance)',
          detail: `Denied: ${err.message}`,
          fix: 'Enable "approval:instance" scope in Feishu console',
        });
      } else {
        results.push({
          ok: true,
          label: 'Approval permission (approval:instance)',
          detail: 'Granted (API reachable)',
        });
      }
    }

    // Check doc permissions
    try {
      const docRes: any = await client.request({
        method: 'GET',
        url: '/open-apis/doc/v2/meta',
        params: { doc_token: 'test' },
      });
      results.push({
        ok: docRes.code === 0 || docRes.code === 10002 || docRes.code === 10003,
        label: 'Doc permission (docx:document)',
        detail: docRes.code === 0 || docRes.code === 10002 || docRes.code === 10003 ? 'Granted' : `Denied: ${docRes.msg}`,
        fix: docRes.code !== 0 && docRes.code !== 10002 && docRes.code !== 10003 ? 'Enable "docx:document" scope in Feishu console' : undefined,
      });
    } catch (err: any) {
      if (isPermissionDenied(err)) {
        results.push({
          ok: false,
          label: 'Doc permission (docx:document)',
          detail: `Denied: ${err.message}`,
          fix: 'Enable "docx:document" scope in Feishu console',
        });
      } else {
        results.push({
          ok: true,
          label: 'Doc permission (docx:document)',
          detail: 'Granted (API reachable)',
        });
      }
    }

  } catch (err: any) {
    results.push({
      ok: false,
      label: 'Permission check',
      detail: `Failed to check permissions: ${err.message}`,
      fix: 'Verify credentials and try again',
    });
  }

  return results;
}

/**
 * Run all applicable checks given a (possibly partial) config.
 * Order: cheapest/most foundational first so short-circuit decisions
 * can stop reading once an early failure explains downstream ones.
 */
export async function runAll(
  config: FeishuConfig | null,
  opts: { configPath?: string; appSecret?: string } = {},
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  results.push(await checkConfigFile(opts.configPath));
  results.push(await checkConfigWritable(opts.configPath));

  if (config) {
    results.push(await checkOpenCodeServer(config.opencodeUrl, process.env.OPENCODE_SERVER_PASSWORD));
    const credResult = await checkFeishuCredentials(
      config.appId,
      opts.appSecret ?? config.appSecret ?? process.env.FEISHU_APP_SECRET,
      config.domain,
    );
    results.push(credResult);
    results.push(await checkAllowlist(config));
    
    // Check permissions if credentials are valid
    if (credResult.ok) {
      const permissionResults = await checkPermissions(
        config.appId,
        opts.appSecret ?? config.appSecret ?? process.env.FEISHU_APP_SECRET,
        config.domain,
      );
      results.push(...permissionResults);
    }
  }

  return results;
}
