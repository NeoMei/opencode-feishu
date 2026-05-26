# OpenCode TUI 支持的 / 命令列表

## 说明

OpenCode 的命令系统分为三类：

1. **TUI 控制命令** - 控制 TUI 界面行为（通过 `/tui/execute-command` 执行）
2. **Session 命令** - 在会话中执行命令（通过 `/session/{id}/command` 执行）
3. **自定义命令** - 用户定义的命令（通过 `/command` API 获取）

## 一、TUI 控制命令

### 会话管理
- `/session.list` - 列出所有会话
- `/session.new` - 创建新会话
- `/session.share` - 分享当前会话
- `/session.interrupt` - 中断当前会话
- `/session.compact` - 压缩会话

### 消息导航
- `/session.page.up` - 向上翻页
- `/session.page.down` - 向下翻页
- `/session.line.up` - 向上移动一行
- `/session.line.down` - 向下移动一行
- `/session.half.page.up` - 向上半页
- `/session.half.page.down` - 向下半页
- `/session.first` - 跳转到第一条消息
- `/session.last` - 跳转到最后一条消息

### 提示控制
- `/prompt.clear` - 清空提示
- `/prompt.submit` - 提交提示

### 代理切换
- `/agent.cycle` - 切换到下一个代理

## 二、Session 命令

### 系统命令
- `/help` - 显示帮助信息
- `/quit` 或 `/exit` - 退出应用

### 会话管理
- `/session.new` - 创建新会话
- `/session.list` - 列出所有会话
- `/session.share` - 分享当前会话
- `/session.unshare` - 取消分享会话
- `/session.interrupt` - 中断会话
- `/session.compact` - 压缩会话
- `/session.export` - 导出会话
- `/session.timeline` - 显示时间线
- `/session.child_cycle` - 下一个子会话
- `/session.child_cycle_reverse` - 上一个子会话

### 消息导航
- `/messages.page_up` / `/messages.page_down` - 翻页
- `/messages.line_up` / `/messages.line_down` - 逐行移动
- `/messages.half_page_up` / `/messages.half_page_down` - 半页移动
- `/messages.first` / `/messages.last` - 首尾消息
- `/messages.next` / `/messages.previous` - 上/下一条
- `/messages.last_user` - 最后一条用户消息
- `/messages.copy` - 复制消息
- `/messages.undo` - 撤销消息
- `/messages.redo` - 重做消息
- `/messages.toggle_conceal` - 切换代码块隐藏

### 模型管理
- `/model.list` - 列出模型
- `/model.cycle_recent` - 下一个最近使用的模型
- `/model.cycle_recent_reverse` - 上一个最近使用的模型

### 代理管理
- `/agent.list` - 列出代理
- `/agent.cycle` - 下一个代理
- `/agent.cycle_reverse` - 上一个代理

### UI 控制
- `/theme.list` - 列出主题
- `/sidebar.toggle` - 切换侧边栏
- `/scrollbar.toggle` - 切换滚动条
- `/username.toggle` - 切换用户名显示
- `/tool_details` - 切换工具详情
- `/terminal.suspend` - 挂起终端
- `/terminal.title_toggle` - 切换终端标题

### 输入控制
- `/input.clear` - 清空输入
- `/input.forward_delete` - 向前删除
- `/input.paste` - 粘贴
- `/input.submit` - 提交
- `/input.newline` - 换行

### 历史记录
- `/history.previous` - 上一条历史
- `/history.next` - 下一条历史

### 其他
- `/command.list` - 列出所有命令
- `/status` - 查看状态

## 三、自定义命令

自定义命令通过 OpenCode 的 `/command` API 获取，包括：

### 来源类型
- `command` - 内置命令
- `mcp` - MCP (Model Context Protocol) 命令
- `skill` - 技能命令

### 命令属性
- `name` - 命令名称
- `description` - 命令描述
- `agent` - 关联的代理
- `model` - 关联的模型
- `template` - 命令模板
- `subtask` - 是否为子任务
- `hints` - 提示信息

## 四、MCP 命令

MCP (Model Context Protocol) 命令包括：

- `/mcp.status` - 获取 MCP 状态
- `/mcp.add` - 添加 MCP 服务器
- `/mcp.connect` - 连接 MCP 服务器
- `/mcp.disconnect` - 断开 MCP 服务器

## 五、Feishu 插件支持

在 Feishu 插件中，以下命令有特殊处理：

### 列表查询命令（直接调用 API）
- `/models` - 获取模型列表
- `/agents` - 获取代理列表
- `/commands` - 获取命令列表
- `/sessions` - 获取会话列表
- `/tools` - 获取工具列表
- `/worktrees` - 获取工作树列表
- `/files [path]` - 获取文件列表
- `/status` - 获取项目状态
- `/config` - 获取配置信息

### 其他命令
所有其他 `/` 命令都会直接发送给 OpenCode 服务端执行。

## 六、注意事项

1. **命令格式**：所有命令以 `/` 开头
2. **参数传递**：部分命令支持参数，如 `/files path/to/file`
3. **错误处理**：不支持的命令会返回错误信息
4. **权限控制**：部分命令需要特定权限

## 参考

- OpenCode SDK 版本：`@opencode-ai/sdk@1.14.18`
- TUI 命令 API：`/tui/execute-command`
- Session 命令 API：`/session/{sessionID}/command`
- 命令列表 API：`/command`
