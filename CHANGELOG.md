# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.4] — 2026-06-10

## [0.6.7] - 2026-06-20

### Fixed
- `opencode-serve-manager` stop(): 修复 `this.proc` 在 force-kill 超时前被置空的 bug
- `config.ts`: 错误信息中的配置路径改为动态平台路径（`join(homedir(), ...)）

### Changed
- `message-handler.ts`: `syncModelOverride()` 及 `handleRestartCommand()` 中的动态 `import('fs')` / `import('path')` 替换为顶层静态导入
- `.github/workflows/publish.yml`: 新增 Windows/macOS/Ubuntu 测试矩阵（Node 18/20/22）
- `package.json`: 移除已损坏的 `lint` 脚本

### Removed
- `scripts/morning-news.js`: 无关的个人早报脚本
- `connectors/feishu/restart-*.sh`: 已被跨平台 Node.js 重启逻辑取代的 Linux shell 脚本
- `CLAUDE.md`: 竞品工具指令文件，与 `AGENTS.md` 重叠


### Fixed

- **修复授权卡片不更新的问题**: 用户点击飞书卡片的授权按钮后，回调响应中未携带 `card` 字段，导致原始卡片始终停留在"等待授权"状态，会话卡死。现在在 `handlePermissionCardAction` 和 `handleQuestionCardAction` 的返回值中同步附带 `card: confirmCard`，确保飞书立即更新卡片状态。

- **移除自引用依赖**: `package.json` 的 `dependencies` 中错误地包含了 `"@neomei/opencode-feishu": "^0.3.3"`，导致 npm 在 `node_modules` 下创建嵌套包结构，造成混淆和重复安装。已删除该依赖。

## [0.4.0] — 2026-05-26

### Fixed

- **密码保护下心跳检测误报**: 当 `opencode serve` 设置了 `OPENCODE_SERVER_PASSWORD` 后，健康检查函数 `isOpencodeServerRunning()` 和 `checkOpenCodeServer()` 未携带 Authorization header，导致 401 被误判为 server 未运行，触发持续告警和错误的自动重启。现在所有 HTTP 检测点（启动检测、心跳轮询、preflight doctor）均正确传递密码，401 被视为 server 正常运行。

## [0.3.9] — 2026-05-26

### Fixed

- 文件上传限制从 50MB 提高到 200MB

## [0.3.7] — 2026-05-24

### Fixed

- **二进制文件下载损坏**: Feather SDK 的 `client.request()` 对 `type=file` 的响应存在编码问题导致 zip/pdf 等二进制文件损坏。改为使用原生 `fetch` + tenant access token 直接下载。
- **不支持的文件类型报 BadRequest**: opencode serve API 不支持 `application/zip` 等 mime type 的 file part。对 `image/text/audio/video` 以外的类型自动降级为文本路径，让 opencode 从磁盘读取。

## [0.1.0] — 2026-04-23

Initial public release. Node.js-native bridge between Feishu/Lark and OpenCode
with a production-grade runtime (daemon mode, structured logging, persistent
sessions, preflight diagnostics).

### Added

- **Dual operation modes**
  - Standalone: `opencode-feishu start [--daemon]` runs as an independent
    process with PID file and heartbeat status file.
  - OpenCode plugin: loadable via `plugins: ["@neomei/opencode-feishu"]` in
    OpenCode config.
- **SDK-based Feishu client** using `@larksuiteoapi/node-sdk` — all API calls
  (send card, patch card, bot info, event stream) go through the SDK; no
  `lark-cli` subprocess or direct HTTP hand-rolling.
- **Long-connection event ingress** via `Lark.WSClient` with SDK-managed
  auto-reconnect.
- **Streaming interactive card** — one card per bot turn, updated in place
  as text deltas, tool state transitions, and retry notices arrive. Header
  flips to "✅ 完成" on `session.idle`. Text is streamed live (character
  by character) rather than dumped at the end.
- **Session persistence** — `~/.config/opencode/feishu-sessions.json` stores
  `chat_id → session_id` mappings across restarts. Lazy reconciliation
  probes OpenCode on startup; stale mappings are dropped and recreated.
- **Preflight + doctor** — `opencode-feishu doctor` runs structured checks
  against config, credentials, OpenCode connectivity, and filesystem state.
  `--json` flag for machine-readable output.
- **Daemon mode** — `start --daemon` detaches from the terminal, redirects
  stdout/stderr to `~/.config/opencode/feishu.log`, writes PID and status
  files for the `status` command to observe.
- **Logs subcommand** — `opencode-feishu logs -n <N> [-f] [--json]` tails
  the structured NDJSON log with human-friendly formatting and ANSI
  color when output is a TTY.
- **Status subcommand** — reports uptime, OpenCode URL, Feishu WS state,
  session count, heartbeat freshness; detects zombie / stale daemon states.
- **Setup wizard** — `opencode-feishu setup` prompts for credentials,
  runs preflight inline, supports skipping when existing config passes all
  checks.
- **Structured logging** — `pino` with NDJSON file sink
  (`~/.config/opencode/feishu.log`) plus pretty TTY mirror. Per-module
  child loggers. Configurable via `FEISHU_LOG_LEVEL` and `FEISHU_LOG_FILE`.
- **Group governance** — `requireMention`, `groupPolicy` (`open` /
  `allowlist` / `disabled`), and `allowlist` (union_id list). Mention
  detection compares against the bot's `open_id` fetched from
  `/open-apis/bot/v3/info`.
- **Config via Zod** — schema validation with clear errors. `appSecret`
  can live in the config file or be provided via the `FEISHU_APP_SECRET`
  environment variable.

## [0.2.0] — 2026-04-24

### Added

- **Service Layer** — Full Feishu API service abstraction:
  - `IMService`: Send text/post/document-card messages, reply, search history
  - `DocService`: Create (XML/Markdown), read (with detail/scope), update (8 commands), search, share
  - `ChatService`: Group search and member management
  - `ContactService`: User search and department queries
  - `CalendarService`: Calendar/events CRUD and freebusy queries
  - `TaskService`: Task create/update/complete/delete
  - `ApprovalService`: Approval query/approve/reject/transfer
- **Multi-profile config management** — `opencode-feishu profile` subcommands:
  `list`, `add`, `use`, `delete`, `rename`, `clone`, `show`
- **Scan-to-setup** — `opencode-feishu setup` now defaults to QR code scan
  for automatic app creation; falls back to manual input on failure
- **Enhanced doctor** — Permission checks for IM, contact, calendar, task,
  approval, and doc scopes
- **Document sharing** — Share documents to chats as interactive cards
- **File download** — Download images, files, audio, video from messages
- **Message deduplication** — TTL-based dedup with automatic cleanup
- **User name caching** — 24h cache for user display names

### Resolved

- Image / file message input (download support added).
- Feishu document reading and editing (full DocService added).

## [0.2.6] — 2026-05-06

### Added

- **OpenCode interactive event support** — Bridges TUI permission/choice prompts to Feishu:
  - `permission.asked`: Displays a 🔒 permission request card with operation scope; user replies with `确认` (once), `始终` (always), or `拒绝` (reject)
  - `question.asked`: Displays a ❓ multiple-choice card; user replies with option numbers or labels (e.g. `1` or `1,3` for multi-select)
  - `permission.replied` / `question.replied` / `question.rejected`: Automatically clear the interaction prompt
- **Slash command support** — Messages starting with `/` are routed to OpenCode's `session.command` API instead of `sendPrompt`. Supports command arguments (e.g. `/compact all`)
- `replyPermission()` and `replyQuestion()` methods on `OpenCodeClient`
- `PendingInteraction` tracking in `SessionManager`
- Extended `FeishuCard` with inline interaction display and dedicated permission/question cards

### Resolved

- Slash commands (now supported via `session.command` API).
- Interactive permission/choice prompts from OpenCode tools (now bridged to Feishu cards).

### Known gaps (planned for subsequent releases)

- `feishu_notify` tool (agent pushing progress mid-task).
- Multi-agent / multi-channel abstraction.

## [0.3.3] — 2026-05-22

### Fixed

- **Process suicide on restart** — `handleRestartCommand` and health-check auto-restart now use `pgrep` with PID exclusion (`grep -v "${currentPid}"`) instead of `pkill -f`, preventing the bridge process from terminating itself when restarting the OpenCode server.

### Notes

Published on npm as `@neomei/opencode-feishu`. Requires Node.js ≥18.

