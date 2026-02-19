# Gemini Agent Context for Clawless (formerly AgentBridge)

## Project Overview
Clawless is a TypeScript-based agent bridge system designed to integrate various services (like Jira, GitLab, Slack, Telegram) with local CLI agents. It acts as a central hub for task automation, proactive notifications, and chat-based operations.

## Architecture
- **Core:** Node.js/TypeScript application.
- **Runtime:** Managed by PM2 (`ecosystem.config.json`).
- **Database:** SQLite (via `sql.js`) for semantic memory.
- **Messaging:** Supports Telegram (`messaging/telegramClient.ts`) and Slack (`messaging/slackClient.ts`).
- **Scheduler:** Built-in cron scheduler (`scheduler/cronScheduler.ts`) for periodic tasks.
- **Memory:** Semantic memory using vector embeddings (`utils/semanticConversationMemory.ts`) and local models (`gguf`).

## Key Directories
- `acp/`: Agent Control Protocol implementation.
- `bin/`: CLI entry points.
- `core/`: Core server logic.
- `messaging/`: Chat platform integrations.
- `scheduler/`: Job scheduling logic.
- `utils/`: Shared utilities (memory, error handling, http).
- `scripts/`: Shell scripts for maintenance and testing.

## Development Guidelines
- **Language:** TypeScript.
- **Package Manager:** npm.
- **Linter/Formatter:** Biome (`biome.json`).
- **Build:** `tsc` (TypeScript Compiler).
- **Testing:** (Add details if available).

## Operational Notes
- **Environment:** Requires `.env` configuration (see `.env.example`).
- **Logs:** Stored in `logs/` directory.
- **Persistence:** Data stored in `~/.clawless/` (databases, config, models).
