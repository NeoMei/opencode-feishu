# OpenCode 飞书集成插件

将 OpenCode AI 助手接入飞书（Feishu/Lark），支持私聊和群聊，提供流式输出和工具状态通知。

## 安装

```bash
npm install -g @neomei/opencode-feishu
```

## 快速开始

### 1. 配置插件

```bash
opencode-feishu setup
```

**默认扫码配置（推荐）**：运行后会显示二维码，使用飞书 App 扫码即可自动创建应用并获取凭证，无需手动输入。

**手动配置**：如果扫码失败，会自动切换到手动输入模式。

### 2. 启动插件

```bash
# 前台启动（需要 OpenCode 服务器运行）
opencode-feishu start

# 后台守护进程启动
opencode-feishu start --daemon

# 指定配置文件
opencode-feishu start -c /path/to/config.json
```

### 3. 管理插件

```bash
# 查看状态
opencode-feishu status

# 停止插件
opencode-feishu stop
```

## 飞书应用配置

### 创建应用

1. 访问 [飞书开放平台](https://open.feishu.cn/app)
2. 创建"企业自建应用"
3. 开启"机器人"能力
4. 添加权限：
   - `im:message`
   - `im:message.p2p_msg:readonly`
   - `im:message.group_at_msg:readonly`
   - `im:message:send_as_bot`
   - `im:resource`
   - `contact:user.base:readonly`
5. 事件配置：使用长连接，添加 `im.message.receive_v1`
6. 发布应用

### 获取凭证

在"凭证与基础信息"页面获取 **App ID**（格式：`cli_xxxxxxxx`）和 **App Secret**。

## 配置项

配置文件位置：`~/.config/opencode/feishu.json`

```json
{
  "appId": "cli_xxxxxxxx",
  "appSecret": "xxxxxxxx",
  "domain": "feishu",
  "opencodeUrl": "http://localhost:19876",
  "streaming": true,
  "requireMention": true,
  "groupPolicy": "allowlist",
  "allowlist": []
}
```

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `appId` | 飞书 App ID | - |
| `appSecret` | 飞书 App Secret | - |
| `domain` | 域名：`feishu` 或 `lark` | `feishu` |
| `opencodeUrl` | OpenCode 服务器地址 | `http://localhost:19876` |
| `streaming` | 启用流式输出 | `true` |
| `requireMention` | 群聊需@机器人 | `true` |
| `groupPolicy` | 群策略：`open`/`allowlist`/`disabled` | `allowlist` |
| `allowlist` | 用户白名单 | `[]` |

> `appSecret` 也可通过环境变量 `FEISHU_APP_SECRET` 设置，优先级高于配置文件。

## 使用方式

### 私聊
直接发送消息给机器人即可开始对话。

### 群聊
在群中 @机器人 发送消息（需开启 `requireMention`）。

### 连续会话
每个聊天（私聊/群聊）对应一个独立的 OpenCode session，支持上下文连续对话。

## 特性

- **流式输出**：OpenCode 的回复实时显示在飞书中
- **状态通知**：显示思考中、工具执行等状态
- **自动重连**：WebSocket 断线后 SDK 自动重连
- **双模式运行**：
  - **独立模式**：`opencode-feishu start`
  - **插件模式**：在 OpenCode 中加载
- **多配置管理**：支持多个飞书应用配置快速切换（profile）
- **权限预检**：`doctor` 命令自动检查 API 权限
- **服务层 API**：提供完整的飞书 API 封装（IM、文档、日历、任务、审批等）

## CLI 命令

```bash
opencode-feishu setup              # 配置向导
opencode-feishu start              # 启动插件
opencode-feishu status             # 查看状态
opencode-feishu stop               # 停止插件
opencode-feishu doctor             # 运行预检（检查配置、凭证、权限）
opencode-feishu logs               # 查看日志
opencode-feishu --help             # 查看帮助

# 多配置管理（Profile）
opencode-feishu profile list       # 列出所有配置
opencode-feishu profile add prod   # 从当前配置创建 profile
opencode-feishu profile use prod   # 切换到指定 profile
opencode-feishu profile show       # 显示当前配置
```

## 服务层 API

除了 CLI 工具，本插件还提供了完整的飞书 API 服务层，可在代码中直接使用：

```typescript
import { FeishuAPI, DocService, CalendarService, TaskService, ApprovalService } from '@neomei/opencode-feishu';

const api = new FeishuAPI({ appId: 'cli_xxx', appSecret: 'xxx', domain: 'feishu' });
await api.initialize();

// 文档操作
const docService = new DocService(api);

// 创建文档
const doc = await docService.createDocumentFromMarkdown('项目计划', '# 目标\n\n- 完成API设计\n- 编写文档');

// 读取文档
const content = await docService.fetchDocument(doc.documentId, {
  detail: 'simple',
  docFormat: 'markdown'
});

// 更新文档
await docService.updateDocument(doc.documentId, 'append', {
  content: '<p>新增段落</p>'
});

// 搜索文档
const results = await docService.searchDocuments('项目计划');

// 分享文档到群聊
await docService.shareDocument('chat-123', doc.documentId, {
  description: '请查看项目计划'
});

// 日历操作
const calendarService = new CalendarService(api);
const calendars = await calendarService.listCalendars();
const events = await calendarService.listEvents('primary', {
  startTime: '2024-01-01T00:00:00Z',
  endTime: '2024-01-31T23:59:59Z',
});

// 任务管理
const taskService = new TaskService(api);
const task = await taskService.createTask({
  summary: '完成项目文档',
  dueTime: '2024-01-15T18:00:00Z',
});

// 审批查询
const approvalService = new ApprovalService(api);
const instances = await approvalService.listInstances({ status: 'pending' });
```

### 支持的服务

| 服务 | 功能 |
|------|------|
| `IMService` | 消息发送、富文本、文档卡片、回复、搜索、下载 |
| `DocService` | 文档创建(XML/Markdown)、读取(支持局部/大纲)、更新(8种指令)、搜索、分享 |
| `ChatService` | 群组搜索、成员管理 |
| `ContactService` | 用户搜索、部门查询 |
| `CalendarService` | 日历、日程 CRUD、忙闲查询 |
| `TaskService` | 任务创建、更新、完成、删除 |
| `ApprovalService` | 审批查询、批准、拒绝、转交 |

## 作为 OpenCode 插件使用

在 OpenCode 配置中添加：

```json
{
  "plugins": ["@neomei/opencode-feishu"]
}
```

## 与 AgentSoul 配合使用

搭配 [@neomei/agentsoul](https://github.com/NeoMei/agentsoul) 可为飞书机器人注入人格和长期记忆：

```bash
# 1. 安装两个插件
npm install -g @neomei/agentsoul @neomei/opencode-feishu

# 2. 配置 AgentSoul 人格
agentsoul setup

# 3. 配置飞书连接
opencode-feishu setup

# 4. 在 opencode.json 中同时注册两个插件
```

```json
{
  "plugin": [
    "@neomei/agentsoul",
    "@neomei/opencode-feishu"
  ]
}
```

启动 OpenCode serve 后，飞书用户的对话会自动触发 AgentSoul 的 soul 注入和记忆保存。

## 环境要求

- Node.js >= 18.0.0
- OpenCode 服务器运行中
- 飞书企业自建应用

## 许可证

MIT
