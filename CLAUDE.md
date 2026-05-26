# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> A companion `AGENTS.md` exists with overlapping content; keep the two in sync when making substantive changes.

## Project

`@opencode-ai/feishu` — bridges an OpenCode AI server to Feishu/Lark messaging. Runs either standalone (`opencode-feishu start`) or loaded as an OpenCode plugin (`plugins: ["@opencode-ai/feishu"]`). Source is TypeScript, ESM-only (`"type": "module"`).

## Commands

```bash
npm run build        # tsc → dist/
npm run dev          # tsc --watch
npm test             # Jest (ts-jest, ESM preset)
npm run test:watch   # Jest --watch
npm run typecheck    # tsc --noEmit
npm run clean        # rm -rf dist
npx jest test/integration.test.ts   # single test file
```

`npm run lint` is defined but **will fail** — ESLint is not a devDependency. Don't rely on it.

Runtime entry is `bin/opencode-feishu` → `dist/cli.js`; `src/` must be built first before the CLI works.

## Architecture

Two entry points sharing the same core wiring. In both, a **single** `FeishuAPI` and `OpenCodeClient` instance is threaded through `SessionManager`, `MessageHandler`, `FeishuEventSource`, and `OpenCodeEventHandler`.

- **Standalone** — `src/cli.ts` → `src/standalone.ts::startStandalone()` constructs its own `OpenCodeClient`, writes a PID file to `~/.config/opencode/feishu.pid`, handles SIGINT/SIGTERM, supports `--daemon`.
- **Plugin** — `src/plugin.ts` exports a `Plugin` whose `server()` hook receives an OpenCode `client` + `project` + `directory` and uses the host's client for event subscription.

### Core message flow

```
Feishu event (Lark.WSClient + EventDispatcher)
  → FeishuEventSource (src/feishu/event-source.ts)     [autoReconnect: true, SDK-managed]
  → MessageHandler (src/core/message-handler.ts)       [dedup / mention / allowlist / group-policy checks]
  → SessionManager (src/core/session-manager.ts)       [1 OpenCode session per chat_id; persisted]
  → OpenCodeClient.sendPrompt or sendCommand (src/opencode/client.ts)

OpenCode event stream
  → OpenCodeEventHandler (src/opencode/event-handler.ts)
  → flushCard() → FeishuAPI sendCard / updateCard      [one card per turn, ~0.5 Hz throttle]
```

`SessionManager` maps `chat_id → { sessionId, status, currentMessageId, currentContent, currentPartId, tools, retryMessage, pendingInteraction }`. A bot turn shows as **one** Feishu interactive card that gets PATCHed in place as text deltas, tool transitions, and retry notices arrive. `session.idle` flips the header to "✅ 完成" and clears session state.

### Card display modes (`showProcess` config)

`showProcess` is a `'none' | 'tools' | 'thinking' | 'full'` enum, default `'none'`:

- **`'none'`** (default, "quiet mode"): Only the final `text` field is shown. Reasoning/thinking parts are skipped. A thinking animation card with cycling dots is sent immediately, then replaced once content arrives.
- **`'tools'`**: Shows text + live tool execution list with status icons.
- **`'thinking'`**: Shows text + thinking/reasoning process (inline while streaming, grey/collapsed when done).
- **`'full'`**: Shows everything — thinking, tools, and final text.

In quiet mode, `appendContent` tracks `partID` and resets content when a new part starts, so only the last text part is visible. The thinking content is tracked separately via `thinkingContent`/`thinkingPartId` fields on `SessionInfo`.

### OpenCode interactive events

The event handler (`src/opencode/event-handler.ts`) processes these event types in addition to streaming text:

| Event type | Handler | User-facing behavior |
|---|---|---|
| `message.part.delta` | `handleTextDelta` | Appends text to `currentContent` or `thinkingContent` based on `field` and `showProcess` |
| `message.part.updated` | `handlePartUpdate` | Tracks tool state transitions (running → completed/error) |
| `session.status` | `handleStatusChange` | Busy/idle/retry status changes; retry shows a notice in the card |
| `session.error` | `handleError` | Sends an error card; guarded against duplicates via `errorHandled` flag |
| `session.idle` | `handleSessionIdle` | Final flush with `done: true`, fires `onSessionIdle` hook |
| `permission.asked` / `permission.updated` | `handlePermissionAsked` | Renders a permission card; stores interaction in `SessionManager` |
| `permission.replied` | `handlePermissionReplied` | Clears pending interaction, flushes card |
| `question.asked` | `handleQuestionAsked` | Renders a question card with numbered options; stores interaction |
| `question.replied` | `handleQuestionReplied` | Clears pending interaction |
| `question.rejected` | `handleQuestionRejected` | Clears pending interaction |
| `command.executed` | `handleCommandExecuted` | Appends a command notice to the card content |

When a pending interaction exists, `MessageHandler.handleMessage()` routes the next user message through `handleInteractionReply()` before normal processing. Permission replies accepted: `确认`/`同意`/`允许`/`yes`/`y` (once), `始终`/`总是`/`always` (always), `拒绝`/`否`/`不同意`/`no`/`n` (reject). Question replies accepted: option numbers or labels, comma-separated for multi-select.

### Slash commands

`MessageHandler.parseSlashCommand()` detects text starting with `/` (e.g. `/help`, `/compact all`). If matched, it calls `OpenCodeClient.sendCommand()` instead of `sendPrompt()`. Only a **whitelist** of commands is allowed (see `message-handler.ts` ~line 279); unknown commands fall through to `sendPrompt` as normal text. The whitelist covers session management, navigation, messages, models, agents, UI toggles, input, and system commands.

### Session persistence

`SessionManager` persists `chat_id → session_id` mappings to `~/.config/opencode/feishu-sessions.json` (debounced 500 ms, atomic write via tmp+rename). On startup it restores and reconciles against OpenCode (`sessionExists`); stale mappings are dropped and recreated.

### Hooks (standalone only)

`HookManager` (`src/core/hook-manager.ts`) runs external scripts on lifecycle events configured via `config.hooks`. Scripts are spawned with `HOOK_SESSION_ID` and `HOOK_OPENCODE_URL` env vars. Failures are logged but never fatal.

### Critical quirks

- **SDK-based Feishu API.** `FeishuAPI` wraps `@larksuiteoapi/node-sdk` `Lark.Client`. Token refresh is automatic.
  - Send card: `client.im.v1.message.create({ msg_type: 'interactive', ... })`
  - Update card: `client.im.v1.message.patch({ path: { message_id }, data: { content: cardJson } })`
  - Bot info: `client.request({ method: 'GET', url: '/open-apis/bot/v3/info' })` (no semantic method in SDK)
- **Event transport is SDK-native.** `FeishuEventSource` (src/feishu/event-source.ts) wraps `Lark.WSClient` + `Lark.EventDispatcher`. It subscribes to `im.message.receive_v1` and emits `'message'` with a `FeishuMessage` shape (sender folded into the message object). Reconnection (`autoReconnect: true`, ping/pong, exponential backoff) is handled internally by the SDK.
- **`CardContent` is just the inner card body** (`{config?, header?, elements}`). The `msg_type: "interactive"` wrapper is NOT part of it — it's passed separately to the SDK method. Earlier versions double-wrapped; if you see that pattern re-emerge, Feishu will silently reject the send.
- **`sendCard` returns `message_id`** and the event handler stores it immediately so subsequent deltas go through `updateCard` rather than spawning more cards. If `message_id` is missing from the response, `sendCard` throws (don't quietly return invalid data).
- **14-day PATCH limit:** Feishu only allows PATCH on messages ≤14 days old; not a concern for streaming (single turn).
- **5 QPS per message — and frequency-limit (code 230020) is recoverable.** `event-handler.ts` throttles `updateCard` to one call per `UPDATE_THROTTLE_MS` (2 s) per chat, well below the limit. If a burst still trips 230020, `FeishuAPI.updateCard` swallows that specific error code (logs `warn`, returns) so the next legitimate update proceeds; throwing on it would surface alarming-looking failures for a transient rate-limit blip.
- **Mentions compare `mention.id.open_id` to the bot's open_id**, not to `appId`. `FeishuAPI.initialize()` fetches the bot's open_id from `/open-apis/bot/v3/info` and caches it. If that fetch fails, `requireMention: true` fails closed (group messages are ignored).
- **ESM + `.js` imports.** All intra-repo imports use `.js` suffixes despite being `.ts` files — required for `moduleResolution: "bundler"` + ESM output. Jest's `moduleNameMapper` strips these.
- **Streaming is optional.** If subscribing to OpenCode events fails, the plugin logs a warning and continues without streaming — do not make streaming failures fatal.
- **Bot-loop guard.** `MessageHandler` drops messages where `sender.sender_type === 'app'`. A regression here causes infinite loops.
- **Session busy guard.** Incoming messages while a session is `busy` get a Chinese "请稍候" reply rather than being queued.
- **Message deduplication.** `MessageDeduplicator` (`src/core/dedup.ts`) tracks seen `message_id`s with a TTL (default 10 min) to survive reconnect replays.
- **Media download.** `MessageHandler` downloads images/files/audio/video from Feishu via `FeishuAPI.downloadMedia()` and forwards them to OpenCode as file attachments.
- **OpenCode password auth.** Standalone mode reads `OPENCODE_SERVER_PASSWORD` and sends it as a Basic auth header (`Authorization: Basic base64(opencode:password)`).
- **Bot name resolution.** `parseBotName()` reads the display name from `~/.agentsoul/soul/IDENTITY.md` (or `projectDir/soul/IDENTITY.md`), falling back to "opencode". The `MessageHandler` constructor default is `'点点'` if not passed.
- **Context prefix injection.** `MessageHandler` prepends every prompt with a system context block containing the `chat_id` and a list of available Feishu MCP tools. This helps the AI know which tools are available and use the correct Feishu doc URL domain (`https://www.feishu.cn/docx/`).
- **Card-action callback response shape.** The handler for `card.action.trigger` MUST NOT return a raw `CardContent` in the `card` field — Feishu requires it wrapped as `{ type: "raw" \| "template", data: {...} }`, and a malformed shape causes the Feishu client to display its own "callback failed" error popup even when our handler succeeded. Update the visible card via `FeishuAPI.updateCard` and return only `{ toast }` from the callback.
- **Card-action callback must return fast.** Feishu enforces a ~3 s timeout on the `card.action.trigger` response; missing it shows the same client-side error popup. `handlePermissionCardAction` / `handleQuestionCardAction` mutate session state synchronously and fire `replyPermission` + `updateCard` as a `void (async ...)` background task, returning the toast immediately.
- **Card-action duplicates are common.** Feishu re-delivers the same `card.action.trigger` event on quick re-clicks or network blips. After the first click clears `pendingInteraction`, subsequent clicks fall into the `!pending` branch — for real OpenCode permission IDs (`per_*`), reply success silently rather than `'该操作已过期'` warning, since the action was already accepted.
- **AI-generated vs. real permission IDs.** Card actions distinguish between OpenCode permission IDs (`per_*`) and AI-generated ones (`perm-*`). The latter are simulated by the AI calling MCP tools; when clicked, the handler updates the card to a confirmation state and sends a simulated text prompt back to OpenCode so the AI can continue. Real OpenCode permissions are relayed via `replyPermission()`.
- **`interactionReplied` flag.** When a user clicks a permission/question card button, `session.interactionReplied` is set to `true` so `flushCard` won't overwrite the confirmation state with subsequent AI streaming output. It's cleared on `session.idle` so the next turn can update normally.
- **`currentMessageId` lifecycle.** `MessageHandler.clearCurrentMessage(chatId)` is called when a **new user message** arrives (not on `session.idle`). This ensures that if the AI sends cards via MCP during a turn, they don't get accidentally PATCHed by our `flushCard`. The event handler no longer clears `currentMessageId` on idle to avoid race conditions.
- **Duplicate error card prevention.** When `MessageHandler` catches a send-prompt error, it sets `session.status = 'idle'` and `session.errorHandled = true` **before** sending the error card. This prevents `OpenCodeEventHandler.handleError` from sending a duplicate card when the `session.error` event arrives afterward.

## Service Layer

Domain-specific services under `src/services/` all extend `BaseService` which provides `call()` for error handling/logging and `validateRequired()` for param validation. SDK calls not covered by typed methods go through `this.api.getClient().request()`.

| Service | File | Key Methods |
|---------|------|-------------|
| `IMService` | `src/services/im-service.ts` | `sendTextMessage`, `replyMessage`, `searchMessages`, `getMessageHistory`, `downloadResource` |
| `DocService` | `src/services/doc-service.ts` | `fetchDocument`, `searchDocuments`, `convertToMarkdown`, `uploadResource`, `createDocumentFromMarkdown` |
| `ChatService` | `src/services/chat-service.ts` | `searchChats`, `getChatInfo`, `createChat`, `listMembers`, `addMembers`, `removeMembers` |
| `ContactService` | `src/services/contact-service.ts` | `searchUsers`, `getUserInfo`, `getDepartmentUsers`, `getDepartmentTree` |
| `CalendarService` | `src/services/calendar-service.ts` | `listCalendars`, `getPrimaryCalendar`, `listEvents`, `createEvent`, `updateEvent`, `deleteEvent`, `queryFreeBusy` |
| `TaskService` | `src/services/task-service.ts` | `listTasks`, `getTask`, `createTask`, `updateTask`, `completeTask`, `deleteTask` |
| `ApprovalService` | `src/services/approval-service.ts` | `listInstances`, `getInstance`, `approveInstance`, `rejectInstance`, `transferInstance` |

## CLI Commands

```bash
opencode-feishu setup [-c <path>]                    # Interactive config wizard
opencode-feishu start [-c <path>] [-u <url>] [-d]    # Start standalone (--daemon for background)
opencode-feishu status [--json]                      # Check daemon status (PID + heartbeat)
opencode-feishu stop                                 # Kill via PID file, clean up
opencode-feishu doctor [-c <path>] [--json]          # Preflight checks (config, creds, reachability, permissions)
opencode-feishu logs [-n <n>] [-f] [--json]          # Tail NDJSON logs
opencode-feishu profile list [--json]                # List all profiles
opencode-feishu profile add <name>                   # Add profile from current config
opencode-feishu profile use <name>                   # Switch to profile
opencode-feishu profile delete <name>                # Delete profile
opencode-feishu profile rename <old> <new>           # Rename profile
opencode-feishu profile clone <src> <dst>            # Clone profile
opencode-feishu profile show [name] [--json]         # Show profile config
```

## Configuration

- Path: `~/.config/opencode/feishu.json` (override with `-c`).
- Multi-profile: `~/.config/opencode/feishu-profiles/`. Active profile stored at `~/.config/opencode/feishu-active-profile`.
- Schema: Zod in `src/core/config.ts`. `appId` must start with `cli_`. `appSecret` is required (either in config or via `FEISHU_APP_SECRET` env var). Resolution helper is `resolveAppSecret()` in `src/core/config.ts`.
- Setup wizard: `opencode-feishu setup` (`src/setup/wizard.ts`). It verifies bot identity via `client.request()` to `/open-apis/bot/v3/info`.

## TypeScript

Target ES2022, `strict: true`, `noUnusedLocals` / `noUnusedParameters` / `noImplicitReturns` all on. Expect tsc to reject dead parameters — underscore-prefix them (`_config`) as existing code does.
