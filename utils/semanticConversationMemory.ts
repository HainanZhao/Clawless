import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { getErrorMessage } from './error.js';
import type { ConversationEntry } from './conversationHistory.js';

type LogFn = (message: string, details?: unknown) => void;

export interface SemanticConversationMemoryConfig {
  enabled: boolean;
  storePath: string;
  maxEntries: number;
  maxCharsPerEntry: number;
}

type SemanticRow = {
  timestamp: string;
  chat_id: string;
  user_message: string;
  bot_response: string;
  platform: string;
};

const ENTRIES_TABLE_NAME = 'semantic_memory_entries';

function toEntryId(entry: ConversationEntry): string {
  return `${entry.timestamp}|${entry.chatId}|${entry.platform}`;
}

function truncateForRecall(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return text.slice(0, maxChars);
}

function buildSearchTerms(input: string): string[] {
  return Array.from(
    new Set(
      input
        .toLowerCase()
        .split(/[^\p{L}\p{N}_]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2)
        .slice(0, 12),
    ),
  );
}

function toConversationEntry(row: SemanticRow): ConversationEntry {
  return {
    timestamp: row.timestamp,
    chatId: row.chat_id,
    userMessage: row.user_message,
    botResponse: row.bot_response,
    platform: row.platform,
  };
}

export class SemanticConversationMemory {
  private readonly config: SemanticConversationMemoryConfig;
  private readonly logInfo: LogFn;
  private readonly logError: LogFn;
  private runtimeDisabled = false;
  private runtimeDisableLogged = false;
  private sqlModulePromise: Promise<any> | null = null;
  private dbPromise: Promise<any> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(config: SemanticConversationMemoryConfig, logInfo: LogFn, logError: LogFn) {
    this.config = config;
    this.logInfo = logInfo;
    this.logError = logError;
  }

  get isEnabled() {
    return this.config.enabled && !this.runtimeDisabled;
  }

  private disableRuntime(reason: string, error?: unknown, action?: string) {
    this.runtimeDisabled = true;

    if (this.runtimeDisableLogged) {
      return;
    }

    this.runtimeDisableLogged = true;
    this.logError('Semantic memory disabled at runtime', {
      reason,
      error: error ? getErrorMessage(error) : undefined,
      action: action || 'Verify sql.js support and restart, or set CONVERSATION_SEMANTIC_RECALL_ENABLED=false.',
    });
  }

  private async getSqlModule() {
    if (this.sqlModulePromise) {
      return this.sqlModulePromise;
    }

    this.sqlModulePromise = (async () => {
      const sqlJsModule: any = await import('sql.js');
      const initSqlJs = sqlJsModule.default ?? sqlJsModule;
      if (typeof initSqlJs !== 'function') {
        throw new Error('sql.js does not expose an initializer function');
      }

      const require = createRequire(import.meta.url);
      const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
      return initSqlJs({
        locateFile: (file: string) => {
          if (file === 'sql-wasm.wasm') {
            return wasmPath;
          }
          return file;
        },
      });
    })();

    return this.sqlModulePromise;
  }

  private async getDatabase() {
    if (this.dbPromise) {
      return this.dbPromise;
    }

    this.dbPromise = (async () => {
      try {
        fs.mkdirSync(path.dirname(this.config.storePath), { recursive: true });

        const SQL = await this.getSqlModule();
        const db = fs.existsSync(this.config.storePath)
          ? new SQL.Database(fs.readFileSync(this.config.storePath))
          : new SQL.Database();

        db.run(`
          CREATE TABLE IF NOT EXISTS ${ENTRIES_TABLE_NAME} (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            entry_id TEXT NOT NULL UNIQUE,
            timestamp TEXT NOT NULL,
            chat_id TEXT NOT NULL,
            user_message TEXT NOT NULL,
            bot_response TEXT NOT NULL,
            platform TEXT NOT NULL
          );

          CREATE INDEX IF NOT EXISTS idx_semantic_memory_chat_seq
            ON ${ENTRIES_TABLE_NAME}(chat_id, seq);
        `);

        this.persistDatabase(db);
        return db;
      } catch (error: any) {
        this.disableRuntime('failed to initialize semantic memory database', error);
        this.dbPromise = null;
        throw error;
      }
    })();

    return this.dbPromise;
  }

  private persistDatabase(db: any) {
    const data = db.export() as Uint8Array;
    fs.writeFileSync(this.config.storePath, Buffer.from(data));
  }

  private async queryRows(db: any, sql: string, params: unknown[]): Promise<SemanticRow[]> {
    const statement = db.prepare(sql);
    try {
      statement.bind(params);
      const rows: SemanticRow[] = [];
      while (statement.step()) {
        rows.push(statement.getAsObject() as SemanticRow);
      }
      return rows;
    } finally {
      statement.free();
    }
  }

  private enqueueWrite<T>(action: () => Promise<T> | T): Promise<T> {
    const next = this.writeQueue.then(() => action());
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  ensureStoreFile() {
    if (!this.isEnabled) {
      return;
    }

    void this.getDatabase().catch(() => {
      // Runtime disable and logging handled in getDatabase/disableRuntime
    });
  }

  async indexEntry(entry: ConversationEntry): Promise<void> {
    if (!this.isEnabled) {
      return;
    }

    try {
      await this.enqueueWrite(async () => {
        const db = await this.getDatabase();
        const entryId = toEntryId(entry);

        db.run('BEGIN');
        try {
          db.run(
            `
              INSERT OR IGNORE INTO ${ENTRIES_TABLE_NAME}
              (entry_id, timestamp, chat_id, user_message, bot_response, platform)
              VALUES (?, ?, ?, ?, ?, ?)
            `,
            [entryId, entry.timestamp, entry.chatId, entry.userMessage, entry.botResponse, entry.platform],
          );

          if (this.config.maxEntries > 0) {
            db.run(
              `
                DELETE FROM ${ENTRIES_TABLE_NAME}
                WHERE seq NOT IN (
                  SELECT seq FROM ${ENTRIES_TABLE_NAME} ORDER BY seq DESC LIMIT ?
                )
              `,
              [this.config.maxEntries],
            );
          }

          db.run('COMMIT');
          this.persistDatabase(db);
        } catch (error) {
          try {
            db.run('ROLLBACK');
          } catch {
            // ignore rollback errors
          }
          throw error;
        }
      });
    } catch (error: any) {
      this.logError('Failed to index semantic conversation entry', {
        chatId: entry.chatId,
        entryId: toEntryId(entry),
        error: getErrorMessage(error),
      });
    }
  }

  async getRelevantEntries(chatId: string, input: string, topK: number): Promise<ConversationEntry[]> {
    if (!this.isEnabled || topK <= 0) {
      return [];
    }

    try {
      await this.writeQueue;
      const db = await this.getDatabase();
      const keywords = buildSearchTerms(input);

      let rows: SemanticRow[] = [];

      if (keywords.length > 0) {
        const scoreSql = keywords
          .map(() => '(CASE WHEN user_message LIKE ? THEN 1 ELSE 0 END + CASE WHEN bot_response LIKE ? THEN 1 ELSE 0 END)')
          .join(' + ');

        const conditions = keywords.map(() => '(user_message LIKE ? OR bot_response LIKE ?)').join(' OR ');

        const params: unknown[] = [];
        for (const kw of keywords) {
          const pattern = `%${kw}%`;
          params.push(pattern, pattern);
        }
        params.push(chatId);
        for (const kw of keywords) {
          const pattern = `%${kw}%`;
          params.push(pattern, pattern);
        }
        params.push(topK);

        rows = await this.queryRows(
          db,
          `
            SELECT timestamp, chat_id, user_message, bot_response, platform,
                   (${scoreSql}) as score
            FROM ${ENTRIES_TABLE_NAME}
            WHERE chat_id = ?
              AND (${conditions})
            ORDER BY score DESC, seq DESC
            LIMIT ?
          `,
          params,
        );
      }

      if (rows.length === 0) {
        rows = await this.queryRows(
          db,
          `
            SELECT timestamp, chat_id, user_message, bot_response, platform
            FROM ${ENTRIES_TABLE_NAME}
            WHERE chat_id = ?
            ORDER BY seq DESC
            LIMIT ?
          `,
          [chatId, topK],
        );
      }

      if (rows.length === 0) {
        return [];
      }

      return rows.map(toConversationEntry).sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    } catch (error: any) {
      this.logError('Failed semantic conversation recall', {
        chatId,
        query: input,
        error: getErrorMessage(error),
      });
      return [];
    }
  }

  async warmFromHistory(entries: ConversationEntry[]): Promise<void> {
    if (!this.isEnabled || entries.length === 0) {
      return;
    }

    const recentEntries = entries.slice(-this.config.maxEntries);
    for (const entry of recentEntries) {
      await this.indexEntry(entry);
    }
  }
}
