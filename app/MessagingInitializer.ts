import path from 'node:path';
import type { AcpRuntime } from '../acp/runtimeManager.js';
import { processSingleTelegramMessage } from '../messaging/liveMessageProcessor.js';
import { createMessageQueueProcessor } from '../messaging/messageQueue.js';
import { registerMessagingHandlers } from '../messaging/registerTelegramHandlers.js';
import { SlackMessagingClient } from '../messaging/slackClient.js';
import { TelegramMessagingClient } from '../messaging/telegramClient.js';
import type { CronScheduler } from '../scheduler/cronScheduler.js';
import { ensureClawlessHomeDirectory, persistCallbackChatId } from '../utils/callbackState.js';
import type { Config } from '../utils/config.js';
import { appendConversationEntry, type ConversationHistoryConfig } from '../utils/conversationHistory.js';
import { getErrorMessage, logError, logInfo, logWarn } from '../utils/error.js';
import type { SemanticConversationMemory } from '../utils/semanticConversationMemory.js';
import { parseAllowlistFromEnv, parseWhitelistFromEnv } from '../utils/telegramWhitelist.js';
import {
  type MessageContext,
  type MessagingClient,
  PlatformNotSupportedError,
  WhitelistError,
} from './messagingPlatforms.js';

export type { MessageContext, MessagingClient } from './messagingPlatforms.js';

export interface MessagingInitializerOptions {
  config: Config;
  acpRuntime: AcpRuntime;
  cronScheduler: CronScheduler;
  agentManager: any;
  semanticConversationMemory: SemanticConversationMemory;
  conversationHistoryConfig: ConversationHistoryConfig;
  onChatBound: (chatId: string) => void;
}

/**
 * Messaging Platform Registry
 * Add new platforms here to make them available
 */
const messagingPlatforms = {
  telegram: {
    createClient: (config: Config) => {
      const TELEGRAM_WHITELIST = parseWhitelistFromEnv(config.TELEGRAM_WHITELIST);
      if (TELEGRAM_WHITELIST.length === 0) {
        throw new WhitelistError('Telegram');
      }
      return new TelegramMessagingClient({
        token: config.TELEGRAM_TOKEN || '',
        typingIntervalMs: config.TYPING_INTERVAL_MS,
        maxMessageLength: config.MAX_RESPONSE_LENGTH,
      });
    },
    getWhitelist: (config: Config) => parseWhitelistFromEnv(config.TELEGRAM_WHITELIST),
    getHandler: registerMessagingHandlers,
  },
  slack: {
    createClient: (config: Config) => {
      const SLACK_WHITELIST = parseAllowlistFromEnv(config.SLACK_WHITELIST, 'SLACK_WHITELIST');
      if (SLACK_WHITELIST.length === 0) {
        throw new WhitelistError('Slack');
      }
      return new SlackMessagingClient({
        token: config.SLACK_BOT_TOKEN || '',
        signingSecret: config.SLACK_SIGNING_SECRET || '',
        appToken: config.SLACK_APP_TOKEN,
        typingIntervalMs: config.TYPING_INTERVAL_MS,
        maxMessageLength: config.MAX_RESPONSE_LENGTH,
      });
    },
    getWhitelist: (config: Config) => parseAllowlistFromEnv(config.SLACK_WHITELIST, 'SLACK_WHITELIST'),
    getHandler: registerMessagingHandlers,
  },
} as const;

export type MessagingPlatform = keyof typeof messagingPlatforms;

export class MessagingInitializer {
  private config: Config;
  private messagingClient: MessagingClient;
  private enqueueMessage: (messageContext: MessageContext) => Promise<void>;
  private getQueueLength: () => number;
  private platform: MessagingPlatform;

  constructor(options: MessagingInitializerOptions) {
    this.config = options.config;
    this.platform = this.config.MESSAGING_PLATFORM as MessagingPlatform;

    // Validate platform is supported
    if (!messagingPlatforms[this.platform]) {
      throw new PlatformNotSupportedError(this.platform);
    }

    const platformConfig = messagingPlatforms[this.platform];

    // Create the messaging client using the platform plugin
    this.messagingClient = platformConfig.createClient(this.config);

    const ACTIVE_USER_WHITELIST = platformConfig.getWhitelist(this.config);

    const { enqueueMessage, getQueueLength } = createMessageQueueProcessor({
      processSingleMessage: (messageContext, messageRequestId) => {
        return processSingleTelegramMessage({
          messageContext,
          messageRequestId,
          maxResponseLength: this.config.MAX_RESPONSE_LENGTH,
          streamUpdateIntervalMs: this.config.STREAM_UPDATE_INTERVAL_MS,
          messageGapThresholdMs: 15000,
          acpDebugStream: this.config.ACP_DEBUG_STREAM,
          runAcpPrompt: options.acpRuntime.runAcpPrompt,
          scheduleAsyncJob: async (message, chatId, jobRef) => {
            return await options.cronScheduler.executeOneTimeJobImmediately(
              message,
              'Async User Task',
              { chatId },
              jobRef,
            );
          },
          logInfo,
          getErrorMessage,
          onConversationComplete: this.config.CONVERSATION_HISTORY_ENABLED
            ? (userMessage, botResponse, chatId) => {
                const appendedEntry = appendConversationEntry(options.conversationHistoryConfig, {
                  chatId,
                  userMessage,
                  botResponse,
                  platform: this.config.MESSAGING_PLATFORM,
                });

                if (appendedEntry && options.semanticConversationMemory.isEnabled) {
                  void options.semanticConversationMemory.indexEntry(appendedEntry);
                }
              }
            : undefined,
        });
      },
      logInfo,
      logError,
      getErrorMessage,
    });

    this.enqueueMessage = enqueueMessage;
    this.getQueueLength = getQueueLength;

    // Register platform-specific handlers
    platformConfig.getHandler({
      messagingClient: this.messagingClient,
      telegramWhitelist: ACTIVE_USER_WHITELIST,
      enforceWhitelist: true,
      hasActiveAcpPrompt: options.acpRuntime.hasActiveAcpPrompt,
      cancelActiveAcpPrompt: options.acpRuntime.cancelActiveAcpPrompt,
      cancelAllJobs: options.cronScheduler.cancelAllJobs,
      shutdownAgent: async () => {
        await options.agentManager.shutdown('Shutdown requested via command');
      },
      shutdownRuntime: async () => {
        // This will exit the process
        process.exit(0);
      },
      enqueueMessage: this.enqueueMessage,
      onAbortRequested: options.acpRuntime.requestManualAbort,
      onChatBound: (chatId) => {
        const CALLBACK_CHAT_STATE_FILE_PATH = path.join(this.config.CLAWLESS_HOME, 'callback-chat-state.json');
        persistCallbackChatId(
          CALLBACK_CHAT_STATE_FILE_PATH,
          chatId,
          () => ensureClawlessHomeDirectory(this.config.CLAWLESS_HOME),
          logInfo,
        );
        options.onChatBound(chatId);
      },
      logError,
      logWarn,
    });
  }

  public getMessagingClient(): MessagingClient {
    return this.messagingClient;
  }

  public getEnqueueMessage(): (messageContext: MessageContext) => Promise<void> {
    return this.enqueueMessage;
  }

  public getQueueLengthValue(): number {
    return this.getQueueLength();
  }

  public getPlatform(): MessagingPlatform {
    return this.platform;
  }

  public async launch(): Promise<void> {
    await this.messagingClient.launch();
  }

  public stop(signal: string): void {
    this.messagingClient.stop(signal);
  }
}

/**
 * Register a new messaging platform
 * Use this to add Discord, WhatsApp, Signal, etc.
 */
export function registerMessagingPlatform(
  name: string,
  config: {
    createClient: (config: Config) => MessagingClient;
    getWhitelist: (config: Config) => string[];
    getHandler: typeof registerMessagingHandlers;
  },
): void {
  (messagingPlatforms as Record<string, typeof config>)[name] = config;
}
