import type { CardContent, ToolState, PendingInteraction } from '../core/types.js';

const TOOL_ICON: Record<ToolState['status'], string> = {
  running: '🔧',
  completed: '✅',
  error: '❌',
};

export class FeishuCard {
  static createThinkingCard(botName: string): CardContent {
    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: `💭 ${botName}思考中...` },
      },
      elements: [],
    };
  }

  static createErrorCard(error: unknown): CardContent {
    let errorText: string;
    
    if (typeof error === 'string') {
      errorText = error;
    } else if (error instanceof Error) {
      errorText = error.message;
    } else if (typeof error === 'object' && error !== null) {
      // Handle object errors (e.g. API response objects)
      try {
        // Try to extract common error fields
        const err = error as any;
        if (err.message) {
          errorText = err.message;
        } else if (err.data?.message) {
          errorText = err.data.message;
        } else if (err.error) {
          errorText = typeof err.error === 'string' ? err.error : JSON.stringify(err.error);
        } else {
          errorText = JSON.stringify(error);
        }
      } catch {
        errorText = String(error);
      }
    } else {
      errorText = String(error);
    }
    
    const safeError = errorText
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\*/g, '\\*')
      .replace(/_/g, '\\_')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .replace(/`/g, '\\`');
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '❌ 错误' } },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: safeError } },
      ],
    };
  }

  static createStreamingCard(opts: {
    content: string;
    thinkingContent?: string;
    tools?: ToolState[];
    done?: boolean;
    retry?: string;
    showProcess?: 'none' | 'tools' | 'thinking' | 'full';
    botName: string;
    interaction?: PendingInteraction;
    currentModel?: string;
    currentAgent?: string;
    modelSelection?: {
      providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>;
      currentModel?: string;
    };
    agentSelection?: {
      agents: Array<{ name: string; description?: string; mode?: string }>;
      currentAgent?: string;
    };
    /** Elapsed processing time in milliseconds (for timer display) */
    elapsedMs?: number;
  }): CardContent {
    const { content, thinkingContent = '', tools = [], done = false, retry, showProcess = 'none', botName, interaction, currentModel, currentAgent, modelSelection, agentSelection, elapsedMs = 0 } = opts;

    const showTools = showProcess === 'tools' || showProcess === 'full';
    const showThinking = showProcess === 'thinking' || showProcess === 'full';
    const anyRunning = tools.some(t => t.status === 'running');

    let headerTitle: string;
    if (interaction) {
      headerTitle = interaction.kind === 'permission' ? '🔒 等待授权' : '❓ 等待选择';
    } else if (modelSelection && !done) {
      headerTitle = '🤖 选择模型';
    } else if (agentSelection && !done) {
      headerTitle = '🎯 选择代理';
    } else if (done) {
      headerTitle = '✅ 完成';
    } else if (retry) {
      headerTitle = '🔄 重试中...';
    } else if (anyRunning) {
      headerTitle = '🔧 执行工具...';
    } else {
      headerTitle = `💭 ${botName}思考中...`;
    }

    const elements: Array<{ tag: string; [key: string]: any }> = [];

    // Normalize: collapse 2+ consecutive newlines into single newline to prevent blank lines in lark_md
    const normalize = (s: string) => s.replace(/\n{2,}/g, '\n');

    // Retry notice
    if (retry) {
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `🔄 **重试中**：${retry}` },
      });
    }

    // Tools section
    if (showTools && tools.length > 0) {
      const toolLines = tools
        .map(t => {
          const head = `${TOOL_ICON[t.status]} ${t.name}`;
          return t.status === 'error' && t.error
            ? `${head}\n\`\`\`\n${t.error}\n\`\`\``
            : head;
        })
        .join('\n');
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: normalize(toolLines) } });
    }

    // Thinking + content: merge into single div to avoid extra spacing
    const hasThinking = showThinking && thinkingContent;
    const hasContent = !!content;
    const isProcessing = !done && !interaction && !modelSelection && !agentSelection;

    if (hasThinking || hasContent) {
      const parts: string[] = [];

      if (hasThinking) {
        const trimmed = thinkingContent.trim();
        if (done) {
          parts.push(`<font color='grey'>💡 *思考过程：*</font>\n<font color='grey'>${normalize(trimmed)}</font>`);
        } else {
          parts.push(`<font color='grey'>💭 ${normalize(trimmed)}</font>`);
        }
      }

      if (hasContent) {
        parts.push(normalize(content.trim()));
      }

      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: parts.join('\n') },
      });
    }

    // Current model/agent display when done
    if (done && !content) {
      if (currentModel) {
        elements.push({
          tag: 'div',
          text: { tag: 'lark_md', content: `**当前模型：** ${currentModel}` },
        });
      }
      if (currentAgent) {
        elements.push({
          tag: 'div',
          text: { tag: 'lark_md', content: `**当前代理：** ${currentAgent}` },
        });
      }
    }

    // Agent selection section (rendered inside streaming card)
    if (agentSelection) {
      const { agents, currentAgent: selAgent } = agentSelection;
      if (selAgent) {
        elements.push({
          tag: 'div',
          text: { tag: 'lark_md', content: `**当前代理：** ${selAgent}` },
        });
        elements.push({ tag: 'hr' });
      }
      const buttons = agents.map(a => ({
        tag: 'button',
        text: { tag: 'plain_text', content: a.name === selAgent ? `✅ ${a.name}` : a.name },
        type: a.name === selAgent ? 'primary' : 'default',
        value: { action: 'agent', name: a.name },
      }));
      elements.push({
        tag: 'action',
        layout: 'default',
        actions: buttons,
      });
      for (const a of agents) {
        if (a.description) {
          elements.push({
            tag: 'div',
            text: { tag: 'lark_md', content: `<font color='grey'>${a.name}: ${a.description}</font>` },
          });
        }
      }
    }

    // Model selection section (rendered inside streaming card)
    if (modelSelection) {
      const { providers, currentModel: selModel } = modelSelection;
      if (selModel) {
        elements.push({
          tag: 'div',
          text: { tag: 'lark_md', content: `**当前模型：** ${selModel}` },
        });
        elements.push({ tag: 'hr' });
      }
      for (const provider of providers) {
        const options = provider.models.map(model => {
          const modelKey = `${provider.id}/${model.id}`;
          const isCurrent = modelKey === selModel;
          return {
            text: { tag: 'plain_text' as const, content: isCurrent ? `✅ ${model.name || model.id}` : model.name || model.id },
            value: modelKey,
          };
        });
        elements.push({
          tag: 'action',
          actions: [
            {
              tag: 'select_static',
              placeholder: { tag: 'plain_text', content: `${provider.name || provider.id} — 选择模型` },
              options,
              value: { action: 'model' },
            },
          ],
        });
      }
    }

    // Interaction section (permissions/questions)
    if (interaction) {
      if (elements.length > 0) elements.push({ tag: 'hr' });
      if (interaction.kind === 'permission') {
        const perm = interaction.data;
        const patterns = perm.patterns.map((p: string) => `- \`${p}\``).join('\n');
        elements.push({
          tag: 'div',
          text: {
            tag: 'lark_md',
            content:
              `**🔒 权限请求：${perm.permission}**\n` +
              `${perm.title}\n\n` +
              `**匹配范围：**\n${patterns || '（未指定）'}`,
          },
        });
        elements.push({
          tag: 'action',
          layout: 'default',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '✅ 确认' },
              type: 'primary',
              value: { action: 'perm', id: perm.id, reply: 'once' },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '🔓 始终允许' },
              type: 'default',
              value: { action: 'perm', id: perm.id, reply: 'always' },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '❌ 拒绝' },
              type: 'default',
              value: { action: 'perm', id: perm.id, reply: 'reject' },
            },
          ],
        });
      } else {
        const q = interaction.data;
        for (const [idx, question] of q.questions.entries()) {
          const header = question.header || question.question.substring(0, 30);
          elements.push({
            tag: 'div',
            text: { tag: 'lark_md', content: `**${idx + 1}. ${header}**` },
          });
          if (question.question !== header) {
            elements.push({
              tag: 'div',
              text: { tag: 'lark_md', content: question.question },
            });
          }
          // Render each option as a clickable button
          for (const [optIdx, opt] of question.options.entries()) {
            elements.push({
              tag: 'action',
              actions: [
                {
                  tag: 'button',
                  text: { tag: 'plain_text', content: `${optIdx + 1}. ${opt.label}` },
                  type: 'default',
                  value: { action: 'q', id: q.id, ans: [[opt.label]] },
                },
              ],
            });
          }
          if (question.multiple) {
            elements.push({
              tag: 'div',
              text: {
                tag: 'lark_md',
                content: '*（支持多选，回复如 `1,3`）*',
              },
            });
          }
          if (idx < q.questions.length - 1) elements.push({ tag: 'hr' });
        }
      }
    }

    // Bottom action bar: stop button + elapsed timer for processing state
    if (isProcessing && !interaction && !modelSelection && !agentSelection) {
      elements.push({ tag: 'hr' });
      // Format elapsed time as mm:ss or h:mm:ss
      const totalSec = Math.floor(elapsedMs / 1000);
      const sec = totalSec % 60;
      const min = Math.floor(totalSec / 60) % 60;
      const hr = Math.floor(totalSec / 3600);
      const timeStr = hr > 0
        ? `${hr}:${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`
        : `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '⏹' },
            type: 'text',
            size: 'tiny',
            value: { action: 'ctrl', op: 'abort' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: `🕐 ${timeStr}` },
            type: 'text',
            size: 'tiny',
            disabled: true,
          },
        ],
      });
    }

    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: headerTitle } },
      elements,
    };
  }

  static createInteractionRepliedCard(kind: 'permission' | 'question', label: string): CardContent {
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '✅ 已处理' } },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content:
              kind === 'permission'
                ? `已${label === 'reject' ? '拒绝' : label === 'always' ? '永久授权' : '授权一次'}该权限请求。`
                : `已提交选择：${label}`,
          },
        },
      ],
    };
  }

  static createExpiredCard(): CardContent {
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '⏱️ 操作已过期' } },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: '该操作已过期，请重新发起请求。',
          },
        },
      ],
    };
  }

  static createModelSelectionCard(opts: {
    providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>;
    currentModel?: string;
  }): CardContent {
    const { providers, currentModel } = opts;
    const elements: Array<{ tag: string; [key: string]: any }> = [];

    if (currentModel) {
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `**当前模型：** ${currentModel}` },
      });
      elements.push({ tag: 'hr' });
    }

    for (const provider of providers) {
      const options = provider.models.map(model => {
        const modelKey = `${provider.id}/${model.id}`;
        const isCurrent = modelKey === currentModel;
        return {
          text: { tag: 'plain_text' as const, content: isCurrent ? `✅ ${model.name || model.id}` : model.name || model.id },
          value: modelKey,
        };
      });

      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'select_static',
            placeholder: { tag: 'plain_text', content: `${provider.name || provider.id} — 选择模型` },
            options,
            value: { action: 'model' },
          },
        ],
      });
    }

    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '🤖 选择模型' } },
      elements,
    };
  }

  static createModelSwitchedCard(providerID: string, modelID: string): CardContent {
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '✅ 模型已切换' } },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: `已切换到 **${providerID}/${modelID}**\n\n下一条消息将使用新模型。` },
        },
      ],
    };
  }

  static createSessionsCard(opts: {
    sessions: Array<{ id: string; title?: string; created: number; updated: number }>;
    currentSessionId: string;
  }): CardContent {
    const { sessions, currentSessionId } = opts;
    const elements: Array<{ tag: string; [key: string]: any }> = [];

    for (const sess of sessions) {
      const isCurrent = sess.id === currentSessionId;
      const title = sess.title || sess.id.substring(0, 16);
      const timeStr = sess.updated
        ? new Date(sess.updated * 1000).toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          })
        : '';

      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `${isCurrent ? '✅' : '💬'} **${title}**\n<font color='grey'>${timeStr}</font>` },
      });
      elements.push({
        tag: 'action',
        layout: 'default',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: isCurrent ? '✅ 当前' : '🔄 切换' },
            type: isCurrent ? 'primary' : 'default',
            value: { action: 'sess', op: 'switch', id: sess.id, title },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🗑 删除' },
            type: 'danger',
            value: { action: 'sess', op: 'delete', id: sess.id, title },
          },
        ],
      });
      elements.push({ tag: 'hr' });
    }

    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: `💬 会话列表 (${sessions.length})` } },
      elements,
    };
  }

  static createSessionSwitchedCard(sessionTitle: string): CardContent {
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '✅ 完成' } },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: `**当前会话：** ${sessionTitle}` },
        },
      ],
    };
  }

  static createStatusCard(status: {
    branch?: string;
    commit?: string;
    files?: Array<{ path: string; status: string; added: number; removed: number }>;
  }): CardContent {
    const elements: Array<{ tag: string; [key: string]: any }> = [];

    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**分支：** \`${status.branch || 'unknown'}\`\n**提交：** \`${(status.commit || '').substring(0, 8)}\`` },
    });

    if (status.files && status.files.length > 0) {
      elements.push({ tag: 'hr' });
      const statusIcon: Record<string, string> = { 
        'added': '➕', 
        'deleted': '🗑', 
        'modified': '✏️',
        'M': '✏️', 
        'A': '➕', 
        'D': '🗑', 
        'R': '📋', 
        'C': '📄', 
        'U': '⚠️', 
        '?': '❓' 
      };
      const fileLines = status.files
        .slice(0, 20)
        .map(f => `${statusIcon[f.status] || statusIcon[f.status.charAt(0)] || '❓'} ${f.status} ${f.path}`)
        .join('\n');
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `**变更文件 (${status.files.length})：**\n${fileLines}` },
      });
      if (status.files.length > 20) {
        elements.push({
          tag: 'div',
          text: { tag: 'lark_md', content: `<font color='grey'>... 还有 ${status.files.length - 20} 个文件</font>` },
        });
      }
    } else {
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: '\n✅ 工作区干净，无变更文件' },
      });
    }

    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'action',
      layout: 'default',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '🔄 刷新' },
          type: 'default',
          value: { action: 'status', op: 'refresh' },
        },
      ],
    });

    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '📊 项目状态' } },
      elements,
    };
  }

  static createCommandsCard(commands: Array<{ name: string; description?: string }>): CardContent {
    const buttons = commands.map(cmd => ({
      tag: 'button',
      text: { tag: 'plain_text', content: `/${cmd.name} - ${cmd.description || ''}` },
      type: 'default' as const,
      value: { action: 'cmd', name: cmd.name },
    }));

    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: `⌨️ 可用命令 (${commands.length})` } },
      elements: [
        {
          tag: 'action',
          layout: 'default',
          actions: buttons,
        },
      ],
    };
  }

  static createNavigationCard(content: string, sessionId: string): CardContent {
    return {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '📄 内容浏览' } },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content },
        },
        { tag: 'hr' },
        {
          tag: 'action',
          layout: 'default',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '⬆️ 上一页' },
              type: 'default',
              value: { action: 'nav', cmd: 'session.page.up', sessionId },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '⬇️ 下一页' },
              type: 'default',
              value: { action: 'nav', cmd: 'session.page.down', sessionId },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '⏫ 首页' },
              type: 'default',
              value: { action: 'nav', cmd: 'session.first', sessionId },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '⏬ 尾页' },
              type: 'default',
              value: { action: 'nav', cmd: 'session.last', sessionId },
            },
          ],
        },
      ],
    };
  }
}
