# Agent Context for Clawless

## Project Overview

Clawless is a lightweight TypeScript bridge that connects local AI agent CLIs (Gemini CLI, OpenCode, Claude Code) to Telegram or Slack messaging platforms. It uses the Agent Communication Protocol (ACP) to communicate with agents and provides persistent conversation context, async task execution, and scheduled jobs.

**Core Value Proposition**: Bring Your Own Agent (BYO-agent) — swap CLI runtimes without rebuilding your bot integration.

## Supported Agents

| Agent | CLI Command | Config Value |
|-------|-------------|--------------|
| Gemini CLI | `gemini` | `gemini` (default) |
| OpenCode | `opencode` | `opencode` |
| Claude Code | `claude` | `claude` |

## Architecture Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Telegram Bot  │     │   Clawless      │     │   Local Agent   │
│   or Slack App  │────▶│   Bridge Core   │────▶│   CLI (ACP)     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌─────────────────┐
                        │   Scheduler +   │
                        │   Callback API  │
                        └─────────────────┘
```

### Key Components

1. **Messaging Layer** (`messaging/`) — Telegram and Slack clients with message queuing
2. **ACP Runtime** (`acp/`) — Agent Communication Protocol session management
3. **Agent Abstraction** (`core/agents/`) — Pluggable CLI agent interface
4. **Scheduler** (`scheduler/`) — Cron-based job scheduling with REST API
5. **Memory System** (`utils/`) — Conversation history and semantic recall

## Asynchronous Hybrid Mode

Clawless intelligently balances responsiveness with deep task execution:

1. **Mode Detection**: Agent analyzes requests to decide `QUICK` vs `ASYNC`
   - `QUICK`: Simple questions answered from knowledge
   - `ASYNC`: Tasks requiring tools or expected >10 seconds

2. **Immediate Confirmation**: Async tasks return confirmation immediately

3. **Background Execution**: One-shot CLI process with `-p` flag

4. **Context Synchronization**: Results are:
   - Sent to user's chat
   - Appended to main ACP session context

## Development Guidelines

### Tech Stack

- **Language**: TypeScript (ESM modules)
- **Runtime**: Node.js 18+
- **Package Manager**: npm
- **Build**: `tsc` (TypeScript Compiler)
- **Linter/Formatter**: Biome (`biome.json`)
- **Testing**: Vitest

### Common Commands

```bash
# Development
npm run dev           # Watch mode with tsx
npm run cli           # Run CLI directly

# Build
npm run build         # lint + format + compile

# Linting
npm run lint          # Check issues
npm run lint:fix      # Auto-fix issues

# Testing
npm run test          # Run vitest
```

### Code Conventions

- Use ES modules (`import`/`export`)
- Async/await for asynchronous operations
- Pino for logging (`utils/logger.ts`)
- Zod for validation where needed
- Biome for formatting (2-space indent, trailing commas)

### Configuration

- Config file: `~/.clawless/config.json`
- Environment variables override config (uppercase, underscore-separated)
- Memory file: `~/.clawless/MEMORY.md`
- History: `~/.clawless/conversation-history.jsonl`
- Semantic store: `~/.clawless/conversation-semantic-memory.db`

## Key Files and Modules

### Entry Points

| File | Purpose |
|------|---------|
| `index.ts` | Main application entry (ClawlessApp launch) |
| `bin/cli.ts` | CLI entry point with config TUI |
| `bin/configTui.ts` | Interactive configuration editor |

### Core Application

| File | Purpose |
|------|---------|
| `app/ClawlessApp.ts` | Main application orchestrator |
| `app/AgentManager.ts` | Agent lifecycle management |
| `app/MessagingInitializer.ts` | Telegram/Slack client setup |
| `app/SchedulerManager.ts` | Cron scheduler coordination |
| `app/CallbackServerManager.ts` | HTTP callback server |

### Agent Layer

| File | Purpose |
|------|---------|
| `core/agents/BaseCliAgent.ts` | Abstract base for CLI agents |
| `core/agents/GeminiAgent.ts` | Gemini CLI implementation |
| `core/agents/OpencodeAgent.ts` | OpenCode CLI implementation |
| `core/agents/ClaudeCodeAgent.ts` | Claude Code CLI implementation |
| `core/agents/agentFactory.ts` | Agent instantiation factory |

### ACP Layer

| File | Purpose |
|------|---------|
| `acp/runtimeManager.ts` | ACP session lifecycle management |
| `acp/tempAcpRunner.ts` | One-shot ACP execution for async tasks |
| `acp/clientHelpers.ts` | ACP client utilities |
| `acp/mcpServerHelpers.ts` | MCP server configuration helpers |

### Messaging Layer

| File | Purpose |
|------|---------|
| `messaging/telegramClient.ts` | Telegram bot client |
| `messaging/slackClient.ts` | Slack bot client |
| `messaging/registerTelegramHandlers.ts` | Telegram message handlers |
| `messaging/messageQueue.ts` | Message queue for async processing |
| `messaging/liveMessageProcessor.ts` | Streaming message handling |
| `messaging/ModeDetector.ts` | QUICK/ASYNC mode detection |

### Scheduler Layer

| File | Purpose |
|------|---------|
| `scheduler/cronScheduler.ts` | Cron job management |
| `scheduler/scheduledJobHandler.ts` | Job execution logic |
| `scheduler/schedulerApiHandler.ts` | REST API for scheduler |

### Utilities

| File | Purpose |
|------|---------|
| `utils/config.ts` | Configuration loading and defaults |
| `utils/memory.ts` | MEMORY.md file operations |
| `utils/conversationHistory.ts` | JSONL conversation persistence |
| `utils/semanticConversationMemory.ts` | SQLite-based semantic recall |
| `utils/contextQueue.ts` | Context synchronization queue |
| `utils/logger.ts` | Pino logging setup |
| `utils/error.ts` | Error handling utilities |

## API Endpoints

### Callback Server (default port 8788)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Health check |
| `/callback` | POST | Generic callback receiver |
| `/api/message` | POST | Send message to bound chat |
| `/api/schedule` | GET/POST/DELETE | Manage scheduled jobs |
| `/api/memory/semantic-recall` | POST | Semantic memory retrieval |

## Troubleshooting

### Common Issues

1. **ACP session fails to initialize**
   - Check agent CLI is installed and on PATH
   - Verify MCP servers are configured correctly
   - Check logs for stderr output

2. **Telegram/Slack not responding**
   - Verify whitelist configuration
   - Check bot token validity
   - Review message queue status

3. **Memory not persisting**
   - Ensure `~/.clawless/` directory exists
   - Check file permissions
   - Verify `MEMORY_FILE_PATH` config

### Debug Flags

- `ACP_DEBUG_STREAM=true` — Enable ACP stream debug logs
- `ACP_STREAM_STDOUT=true` — Emit raw ACP chunks to stdout
- `LOG_LEVEL=debug` — Enable debug logging

## Persistence Locations

All runtime data stored in `~/.clawless/` by default:

```
~/.clawless/
├── config.json                    # Main configuration
├── MEMORY.md                      # Operator memory notes
├── conversation-history.jsonl     # Conversation transcript
├── conversation-semantic-memory.db # SQLite semantic index
├── schedules.json                 # Scheduled jobs
└── callback-chat-state.json       # Bound chat ID for callbacks
```

---

## Project Index Tree

```
clawless/
├── index.ts                      # Main entry point
├── package.json                  # Package manifest and scripts
├── tsconfig.json                 # TypeScript configuration
├── biome.json                    # Biome linter/formatter config
├── vitest.config.ts              # Vitest test configuration
├── ecosystem.config.json         # PM2 process manager config
├── clawless.config.example.json  # Example configuration file
├── .env.example                  # Example environment variables
│
├── bin/                          # CLI entry points
│   ├── cli.ts                    # Main CLI with config TUI
│   └── configTui.ts              # Interactive config editor (blessed)
│
├── app/                          # Application layer
│   ├── ClawlessApp.ts            # Main app orchestrator
│   ├── AgentManager.ts           # Agent lifecycle management
│   ├── MessagingInitializer.ts   # Messaging platform setup
│   ├── SchedulerManager.ts       # Scheduler coordination
│   ├── CallbackServerManager.ts  # HTTP callback server
│   └── messagingPlatforms.ts     # Platform enum/registry
│
├── core/                         # Core business logic
│   ├── callbackServer.ts         # Express callback server
│   └── agents/                   # Agent implementations
│       ├── index.ts              # Agent exports
│       ├── BaseCliAgent.ts       # Abstract agent interface
│       ├── GeminiAgent.ts        # Gemini CLI agent
│       ├── OpencodeAgent.ts      # OpenCode CLI agent
│       ├── ClaudeCodeAgent.ts    # Claude Code CLI agent
│       └── agentFactory.ts       # Agent factory function
│
├── acp/                          # Agent Communication Protocol
│   ├── runtimeManager.ts         # ACP session management
│   ├── tempAcpRunner.ts          # One-shot ACP execution
│   ├── clientHelpers.ts          # ACP client utilities
│   └── mcpServerHelpers.ts       # MCP server configuration
│
├── messaging/                    # Messaging platform clients
│   ├── telegramClient.ts         # Telegram bot client
│   ├── slackClient.ts            # Slack bot client
│   ├── registerTelegramHandlers.ts # Telegram message handlers
│   ├── messageQueue.ts           # Async message queue
│   ├── liveMessageProcessor.ts   # Streaming message handling
│   ├── ModeDetector.ts           # QUICK/ASYNC mode detection
│   └── messageTruncator.ts       # Message length truncation
│
├── scheduler/                    # Job scheduling
│   ├── cronScheduler.ts          # Cron job management
│   ├── scheduledJobHandler.ts    # Job execution logic
│   └── schedulerApiHandler.ts    # REST API for scheduler
│
├── utils/                        # Shared utilities
│   ├── config.ts                 # Configuration loader
│   ├── memory.ts                 # MEMORY.md operations
│   ├── conversationHistory.ts    # JSONL conversation store
│   ├── semanticConversationMemory.ts # SQLite semantic recall
│   ├── contextQueue.ts           # Context sync queue
│   ├── callbackState.ts          # Callback chat binding
│   ├── logger.ts                 # Pino logging setup
│   ├── error.ts                  # Error handling utilities
│   ├── httpHelpers.ts            # HTTP utility functions
│   ├── telegramWhitelist.ts      # Telegram user whitelist
│   ├── commandText.ts            # Command parsing utilities
│   ├── geminiMcpHelpers.ts       # Gemini MCP configuration
│   ├── opencodeMcpHelpers.ts     # OpenCode MCP configuration
│   └── claudeMcpHelpers.ts       # Claude Code MCP configuration
│
├── scripts/                      # Shell scripts
│   ├── callback-health.sh        # Health check script
│   ├── callback-post.sh          # POST callback test
│   └── callback-post-chat.sh     # Chat callback test
│
├── doc/                          # Documentation
│   ├── CONFIG.md                 # Full configuration reference
│   ├── MEMORY_SYSTEM.md          # Memory architecture docs
│   └── architecture.svg          # Architecture diagram
│
└── .github/                      # GitHub workflows
    └── workflows/
        └── npm-publish.yml       # NPM publish workflow
```