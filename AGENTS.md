# AGENTS.md

## Project

`@neomei/opencode-feishu` — bridges an OpenCode AI server to Feishu/Lark messaging. Runs standalone (`opencode-feishu start`) or as an OpenCode plugin (`plugins: ["@neomei/opencode-feishu"]`). TypeScript, ESM-only (`"type": "module"`).

## Commands

```bash
npm run build        # tsc → dist/
npm run dev          # tsc --watch
npm test             # Jest (ts-jest, ESM preset) — single file at test/integration.test.ts
npm run typecheck    # tsc --noEmit
npm run clean        # rm -rf dist
npx jest test/integration.test.ts   # single test
```

`npm run lint` is defined but **will fail** — ESLint is not installed as a devDependency. Do not rely on it.

Runtime entry is `bin/opencode-feishu` → `dist/cli.js`; must build first.

## Architecture

Two entrypoints share the same core wiring. A **single** `FeishuAPI` and `OpenCodeClient` instance is threaded through `SessionManager`, `MessageHandler`, `FeishuEventSource`, and `OpenCodeEventHandler`.

- **Standalone** — `src/cli.ts` → `src/standalone.ts::startStandalone()`. Writes PID to `~/.config/opencode/feishu.pid`. Supports `--daemon`. Reads `OPENCODE_SERVER_PASSWORD` for Basic auth.
- **Plugin** — `src/plugin.ts`. `server()` hook receives host OpenCode `client` + `project` + `directory`.

### Message flow

```
Feishu event (Lark.WSClient + EventDispatcher, autoReconnect)
  → FeishuEventSource (src/feishu/event-source.ts)
  → MessageHandler (dedup / mention / allowlist / group-policy)
  → SessionManager (1 session per chat_id; persisted)
  → OpenCodeClient.sendPrompt / sendCommand

OpenCode event stream
  → OpenCodeEventHandler (src/opencode/event-handler.ts)
  → flushCard() → FeishuAPI sendCard / updateCard (one card per turn, ~0.5 Hz throttle)
```

### Streaming card model

One Feishu interactive card per turn. First `flushCard` creates via `sendCard` (stores `message_id`); subsequent calls PATCH via `updateCard`. `session.idle` flips header to "✅ 完成".

### Card display modes (`showProcess` config)

`'none' | 'tools' | 'thinking' | 'full'`, default `'none'` (quiet mode):

- **`'none'`**: Only final text shown. Thinking animation card sent first, replaced on content arrival. `appendContent` tracks `partID` and resets on new part so only last text part is visible.
- **`'tools'`**: Text + live tool execution list with status icons.
- **`'thinking'`**: Text + reasoning process (inline while streaming, grey/collapsed when done).
- **`'full'`**: Everything — thinking, tools, text.

### OpenCode interactive events

`OpenCodeEventHandler` handles: `message.part.delta`, `message.part.updated`, `session.status`, `session.error`, `session.idle`, `permission.asked/updated/replied`, `question.asked/replied/rejected`, `command.executed`. Pending interactions route next user message through `handleInteractionReply()` before normal processing.

### Slash commands

`MessageHandler.parseSlashCommand()` routes `/`-prefixed messages to `sendCommand()` instead of `sendPrompt()`. Only a whitelist of commands is allowed; unknown commands fall through to `sendPrompt`. Whitelist defined at `src/core/message-handler.ts` ~line 279.

### Session persistence

`SessionManager` persists `chat_id → session_id` mappings to `~/.config/opencode/feishu-sessions.json` (debounced 500 ms, atomic write via tmp+rename). On startup, reconciles against OpenCode (`sessionExists`); stale mappings are dropped.

## Configuration

- **Path**: `~/.config/opencode/feishu.json` (override with `-c`).
- **Multi-profile**: `~/.config/opencode/feishu-profiles/`. Active profile at `~/.config/opencode/feishu-active-profile`.
- **Schema**: Zod in `src/core/config.ts`. `appId` must start with `cli_`. `appSecret` required (config or `FEISHU_APP_SECRET` env var). Resolution: `resolveAppSecret()`.
- **Key fields**: `domain` (`feishu|lark`), `opencodeUrl`, `streaming`, `requireMention`, `groupPolicy` (`allowlist`), `showProcess`, `allowlist`, `workdir`, `hooks`.

## CLI Commands

```
opencode-feishu setup [-c <path>]
opencode-feishu start [-c <path>] [-u <url>] [--daemon|--serve]
opencode-feishu status [--json]
opencode-feishu stop
opencode-feishu doctor [-c <path>] [--json]
opencode-feishu logs [-n <n>] [-f] [--json]
opencode-feishu profile list|add|use|delete|rename|clone|show
```

## Service Layer

Domain services under `src/services/` all extend `BaseService` (`call()` + `validateRequired()`). Untyped SDK calls go through `this.api.getClient().request()`:

| Service | Purpose |
|---------|---------|
| `IMService` | Send/reply/search messages, download resources |
| `DocService` | Fetch/search/convert docs, upload/create documents |
| `ChatService` | Search/create/query chats, manage members |
| `ContactService` | Search users, get department info |
| `CalendarService` | List calendars/events, create/update/delete, free-busy |
| `TaskService` | List/get/create/update/complete/delete tasks |
| `ApprovalService` | List/get/approve/reject/transfer instances |

## Critical Quirks

These are easy to get wrong and cause subtle bugs:

- **`CardContent` is inner body only** — the `msg_type: "interactive"` wrapper is NOT part of `CardContent`. Earlier double-wrapped versions were silently rejected by Feishu.
- **Card-action response shape** — the `card.action.trigger` callback MUST return `{ type: "raw" | "template", data: {...} }`, NOT a raw `CardContent`. Malformed shape causes Feishu client to show its own error popup even when the handler succeeded. Update the card via `updateCard` and return only `{ toast }`.
- **Card-action ~3 s timeout** — Feishu enforces a timeout on `card.action.trigger`. `handlePermissionCardAction`/`handleQuestionCardAction` fire `replyPermission` + `updateCard` as `void (async ...)` background tasks, returning the toast immediately.
- **Card-action duplicate events** — Feishu re-delivers on quick re-clicks. After first click clears `pendingInteraction`, subsequent clicks: real OpenCode IDs (`per_*`) silently succeed; AI-generated IDs (`perm-*`) show "已过期".
- **AI-generated vs real permission IDs** — `per_*` (OpenCode) are relayed via `replyPermission()`. `perm-*` (AI MCP tools) simulate a text reply back to OpenCode so the AI continues.
- **`interactionReplied` flag** — set `true` when user clicks a card button, preventing `flushCard` from overwriting confirmation state with streaming output. Cleared on `session.idle`.
- **`currentMessageId` lifecycle** — cleared when a NEW user message arrives, NOT on `session.idle`. Prevents MCP-sent cards from being accidentally PATCHed by `flushCard`.
- **Duplicate error card prevention** — when `sendPrompt` fails, set `session.status = 'idle'` and `session.errorHandled = true` BEFORE sending the error card, so the subsequent `session.error` event is skipped.
- **Mention matching uses `open_id`** — `mention.id.open_id` vs bot's `open_id` from `/open-apis/bot/v3/info`, NOT `appId` (`cli_*`).
- **Bot-loop guard** — drop messages where `sender.sender_type === 'app'`. Regression here causes infinite loops.
- **Session busy guard** — messages while session is `busy` get "请稍候" reply, not queued.
- **5 QPS + code 230020 recovery** — `updateCard` throttled at ~0.5 Hz (2 s). If 230020 still hit, swallowed as warning (not thrown), so next update proceeds.
- **14-day PATCH limit** — Feishu only allows PATCH on messages ≤14 days old. Not a concern for single-turn streaming.
- **Streaming is optional** — if OpenCode event subscription fails, warn and continue without streaming. Never make this fatal.
- **ESM `.js` imports** — intra-repo imports use `.js` suffix despite `.ts` source (required for `moduleResolution: "bundler"`). Jest's `moduleNameMapper` strips these.
- **File upload uses native fetch** — Feishu SDK `client.request()` doesn't support `multipart/form-data` (serializes as `{}`), so file upload goes through native `fetch()`.
- **`tsconfig.json` excludes `test/`** from compilation — tests are handled exclusively by Jest/ts-jest.
- **Context prefix injection** — every prompt is prepended with system context (chat_id, available Feishu MCP tools, doc URL domain forced to `www.feishu.cn/docx/`).

## TypeScript

Target ES2022, `strict: true`, `noUnusedLocals` / `noUnusedParameters` / `noImplicitReturns` all on. Underscore-prefix unused parameters (`_config`) as existing code does.
