import path from 'node:path';
import { type JobProgressEvent, runPromptWithCli } from '../acp/tempAcpRunner.js';
import { ensureClawlessHomeDirectory, loadPersistedCallbackChatId, resolveChatId } from '../utils/callbackState.js';
import { type Config, getConfig } from '../utils/config.js';
import { appendToContextQueue, formatContextQueueForPrompt, loadAndClearContextQueue } from '../utils/contextQueue.js';
import {
  type ConversationHistoryConfig,
  ensureConversationHistoryFile,
  formatConversationHistoryForPrompt,
  loadConversationHistory,
} from '../utils/conversationHistory.js';
import { getErrorMessage, logError, logInfo } from '../utils/error.js';
import {
  buildPromptWithMemory as buildPromptWithMemoryTemplate,
  ensureMemoryFile,
  readMemoryContext,
} from '../utils/memory.js';
import { SemanticConversationMemory } from '../utils/semanticConversationMemory.js';
import { AgentManager } from './AgentManager.js';
import { CallbackServerManager } from './CallbackServerManager.js';
import { MessagingInitializer } from './MessagingInitializer.js';
import { SchedulerManager } from './SchedulerManager.js';

export class ClawlessApp {
  private config: Config;
  private agentManager: AgentManager;
  private messagingInitializer: MessagingInitializer;
  private schedulerManager: SchedulerManager;
  private callbackServerManager: CallbackServerManager;
  private semanticConversationMemory: SemanticConversationMemory;
  private lastIncomingChatId: string | null = null;
  private callbackChatStateFilePath: string;

  constructor() {
    this.config = getConfig();
    this.callbackChatStateFilePath = path.join(this.config.CLAWLESS_HOME, 'callback-chat-state.json');

    const conversationHistoryConfig: ConversationHistoryConfig = {
      filePath: this.config.CONVERSATION_HISTORY_FILE_PATH,
      maxEntries: this.config.CONVERSATION_HISTORY_MAX_ENTRIES,
      maxCharsPerEntry: this.config.CONVERSATION_HISTORY_MAX_CHARS_PER_ENTRY,
      maxTotalChars: this.config.CONVERSATION_HISTORY_MAX_TOTAL_CHARS,
      logInfo,
    };

    this.semanticConversationMemory = new SemanticConversationMemory(
      {
        enabled: this.config.CONVERSATION_SEMANTIC_RECALL_ENABLED,
        storePath: this.config.CONVERSATION_SEMANTIC_STORE_PATH,
        maxEntries: this.config.CONVERSATION_SEMANTIC_MAX_ENTRIES,
        maxCharsPerEntry: this.config.CONVERSATION_SEMANTIC_MAX_CHARS_PER_ENTRY,
      },
      logInfo,
      logError,
    );

    this.agentManager = new AgentManager({
      config: this.config,
      buildPromptWithMemory: this.buildPromptWithMemory.bind(this),
    });

    this.schedulerManager = new SchedulerManager({
      config: this.config,
      getMessagingClient: () => this.messagingInitializer?.getMessagingClient(),
      cliAgent: this.agentManager.getCliAgent(),
      buildPromptWithMemory: this.buildPromptWithMemory.bind(this),
      runScheduledPromptWithTempAcp: this.runScheduledPromptWithCli.bind(this),
      resolveTargetChatId: () => resolveChatId(this.lastIncomingChatId),
      getEnqueueMessage: () => this.messagingInitializer?.getEnqueueMessage(),
      appendContextToAgent: async (text) => {
        if (this.agentManager.isAcpSessionReady()) {
          try {
            await this.agentManager.getAcpRuntime().appendContext(text);
            return;
          } catch (error) {
            logInfo('Failed to append context to live ACP session, falling back to queue', {
              error: getErrorMessage(error),
            });
          }
        }
        appendToContextQueue(
          this.config.CLAWLESS_HOME,
          {
            id: Date.now().toString(),
            timestamp: new Date().toISOString(),
            source: 'async_job',
            content: text,
          },
          logInfo,
        );
      },
    });

    this.messagingInitializer = new MessagingInitializer({
      config: this.config,
      acpRuntime: this.agentManager.getAcpRuntime(),
      cronScheduler: this.schedulerManager.getCronScheduler(),
      agentManager: this.agentManager,
      semanticConversationMemory: this.semanticConversationMemory,
      conversationHistoryConfig,
      onChatBound: (chatId) => {
        this.lastIncomingChatId = chatId;
      },
    });

    this.callbackServerManager = new CallbackServerManager({
      config: this.config,
      cronScheduler: this.schedulerManager.getCronScheduler(),
      messagingClient: this.messagingInitializer.getMessagingClient(),
      getLastIncomingChatId: () => this.lastIncomingChatId,
      semanticConversationMemory: this.semanticConversationMemory,
    });
  }

  private async buildPromptWithMemory(userPrompt: string): Promise<string> {
    const memoryContext = readMemoryContext(this.config.MEMORY_FILE_PATH, this.config.MEMORY_MAX_CHARS, logInfo);

    // Load recent conversation history and context queue only when there's no existing ACP session
    // Agent keeps its own session memory, so we only need history on first prompt
    let conversationContext = '';
    let contextQueueContent = '';

    if (!this.agentManager.isAcpSessionReady()) {
      // Load context queue from async jobs (and clear it after loading)
      contextQueueContent = formatContextQueueForPrompt(loadAndClearContextQueue(this.config.CLAWLESS_HOME, logInfo));

      // Load recent conversation history
      if (this.config.CONVERSATION_HISTORY_ENABLED) {
        const conversationHistoryConfig: ConversationHistoryConfig = {
          filePath: this.config.CONVERSATION_HISTORY_FILE_PATH,
          maxEntries: this.config.CONVERSATION_HISTORY_MAX_ENTRIES,
          maxCharsPerEntry: this.config.CONVERSATION_HISTORY_MAX_CHARS_PER_ENTRY,
          maxTotalChars: this.config.CONVERSATION_HISTORY_MAX_TOTAL_CHARS,
          logInfo,
        };
        const recentHistory = loadConversationHistory(conversationHistoryConfig);
        conversationContext = formatConversationHistoryForPrompt(
          recentHistory.slice(-5), // Last 5 conversations
          this.config.CONVERSATION_HISTORY_MAX_TOTAL_CHARS,
        );
      }
    }

    return buildPromptWithMemoryTemplate({
      userPrompt,
      memoryFilePath: this.config.MEMORY_FILE_PATH,
      callbackHost: this.config.CALLBACK_HOST,
      callbackPort: this.config.CALLBACK_PORT,
      callbackChatStateFilePath: this.callbackChatStateFilePath,
      callbackAuthToken: this.config.CALLBACK_AUTH_TOKEN,
      memoryContext,
      conversationContext,
      contextQueueContent,
      messagingPlatform: this.config.MESSAGING_PLATFORM,
    });
  }

  private async runScheduledPromptWithCli(
    promptForAgent: string,
    scheduleId: string,
    onProgress?: (event: JobProgressEvent) => void,
  ): Promise<string> {
    return runPromptWithCli({
      scheduleId,
      promptForAgent,
      cliAgent: this.agentManager.getCliAgent(),
      cwd: process.cwd(),
      timeoutMs: this.config.CLI_AGENT_TIMEOUT_MS,
      noOutputTimeoutMs: this.config.CLI_AGENT_NO_OUTPUT_TIMEOUT_MS,
      permissionStrategy: this.config.ACP_PERMISSION_STRATEGY,
      stderrTailMaxChars: 4000,
      logInfo,
      logError,
      onProgress,
      acpMcpServersJson: this.config.ACP_MCP_SERVERS_JSON,
      acpDebugStream: this.config.ACP_DEBUG_STREAM,
    });
  }

  public async launch(): Promise<void> {
    logInfo('Starting Clawless server...', {
      messagingPlatform: this.config.MESSAGING_PLATFORM,
      cliAgent: this.agentManager.getCliAgent().getDisplayName(),
    });

    this.agentManager.validateCliAgentOrExit();
    ensureClawlessHomeDirectory(this.config.CLAWLESS_HOME);
    ensureMemoryFile(this.config.MEMORY_FILE_PATH, logInfo);

    if (this.config.CONVERSATION_HISTORY_ENABLED) {
      ensureConversationHistoryFile(this.config.CONVERSATION_HISTORY_FILE_PATH, logInfo);

      if (this.semanticConversationMemory.isEnabled) {
        this.semanticConversationMemory.ensureStoreFile();
        const historicalEntries = loadConversationHistory({
          filePath: this.config.CONVERSATION_HISTORY_FILE_PATH,
          maxEntries: this.config.CONVERSATION_HISTORY_MAX_ENTRIES,
          maxCharsPerEntry: this.config.CONVERSATION_HISTORY_MAX_CHARS_PER_ENTRY,
          maxTotalChars: this.config.CONVERSATION_HISTORY_MAX_TOTAL_CHARS,
          logInfo,
        });
        void this.semanticConversationMemory.warmFromHistory(historicalEntries);
      }
    }

    this.lastIncomingChatId = loadPersistedCallbackChatId(this.callbackChatStateFilePath, logInfo);
    if (this.lastIncomingChatId) {
      logInfo('Loaded callback chat binding', { chatId: this.lastIncomingChatId });
    }

    this.setupGracefulShutdown();
    this.callbackServerManager.start();
    this.agentManager.scheduleAcpPrewarm('startup');

    try {
      await this.messagingInitializer.launch();
      logInfo('Bot launched successfully', {
        messagingPlatform: this.config.MESSAGING_PLATFORM,
        cliAgent: this.agentManager.getCliAgent().getDisplayName(),
      });
      this.agentManager.scheduleAcpPrewarm('post-launch');

      if (this.config.HEARTBEAT_INTERVAL_MS > 0) {
        setInterval(() => {
          const runtimeState = this.agentManager.getAcpRuntime().getRuntimeState();
          logInfo('Heartbeat', {
            queueLength: this.messagingInitializer.getQueueLengthValue(),
            acpSessionReady: runtimeState.acpSessionReady,
            agentProcessRunning: runtimeState.agentProcessRunning,
          });
        }, this.config.HEARTBEAT_INTERVAL_MS);
      }
    } catch (error: any) {
      logError('Failed to launch bot:', error);
      process.exit(1);
    }
  }

  private setupGracefulShutdown(): void {
    const shutdownSignals = ['SIGINT', 'SIGTERM'];

    for (const signal of shutdownSignals) {
      process.once(signal, () => {
        logInfo(`Received ${signal}, stopping bot...`);
        this.schedulerManager.shutdown();
        this.callbackServerManager.stop();
        this.messagingInitializer.stop(signal);
        void this.agentManager.shutdown(`signal:${signal}`);
      });
    }
  }
}
