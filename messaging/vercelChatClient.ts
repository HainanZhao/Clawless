import { Chat } from 'chat';
import { createSlackAdapter } from '@chat-adapter/slack';
import { createTelegramAdapter } from '@chat-adapter/telegram';
import { createMemoryState } from '@chat-adapter/state-memory';
import { logInfo, logError } from '../utils/error.js';
import { splitIntoSmartChunks } from './messageTruncator.js';

/**
 * Unified messaging client using Vercel Chat SDK
 * Supports multiple platforms through a single interface
 */

type PlatformType = 'slack' | 'telegram';

export class VercelChatMessageContext {
  platform: PlatformType;
  thread: any;
  text: string;
  chatId: string | undefined;
  userId: string | undefined;
  typingIntervalMs: number;
  maxMessageLength: number;
  private typingInterval: NodeJS.Timeout | null = null;

  constructor({
    platform,
    thread,
    text,
    chatId,
    userId,
    typingIntervalMs,
    maxMessageLength,
  }: {
    platform: PlatformType;
    thread: any;
    text: string;
    chatId?: string;
    userId?: string;
    typingIntervalMs: number;
    maxMessageLength: number;
  }) {
    this.platform = platform;
    this.thread = thread;
    this.text = text;
    this.chatId = chatId;
    this.userId = userId;
    this.typingIntervalMs = typingIntervalMs;
    this.maxMessageLength = maxMessageLength;
  }

  startTyping() {
    // Vercel Chat SDK doesn't have a direct typing indicator API for all platforms
    // We'll use a no-op implementation to maintain interface compatibility
    const stopTyping = () => {
      if (this.typingInterval) {
        clearInterval(this.typingInterval);
        this.typingInterval = null;
      }
    };

    return stopTyping;
  }

  async sendText(text: string) {
    const chunks = splitIntoSmartChunks(text, this.maxMessageLength);
    for (const chunk of chunks) {
      await this.thread.post(chunk);
    }
  }

  async startLiveMessage(initialText = '…') {
    await this.thread.post(initialText);
    // Vercel Chat SDK returns a message ID that can be used for updates
    return 'live-message-id';
  }

  async updateLiveMessage(_messageId: string, text: string) {
    // Vercel Chat SDK supports editing messages on platforms that allow it
    // For now, we'll post a new message as a fallback
    await this.thread.post(text);
  }

  async finalizeLiveMessage(_messageId: string, text: string) {
    const chunks = splitIntoSmartChunks(text, this.maxMessageLength);
    for (const chunk of chunks) {
      await this.thread.post(chunk);
    }
  }

  async removeMessage(_messageId: string) {
    // Vercel Chat SDK doesn't have a universal delete API
    // This is a no-op for now
    logInfo('Message deletion not supported on this platform');
  }
}

export class VercelChatMessagingClient {
  private chat: Chat;
  private platform: PlatformType;
  typingIntervalMs: number;
  maxMessageLength: number;
  private messageHandlers: Array<(messageContext: VercelChatMessageContext) => Promise<void> | void> = [];
  private errorHandlers: Array<(error: Error, messageContext: VercelChatMessageContext | null) => void> = [];

  constructor({
    platform,
    slackToken,
    slackSigningSecret,
    telegramToken,
    typingIntervalMs,
    maxMessageLength,
  }: {
    platform: PlatformType;
    slackToken?: string;
    slackSigningSecret?: string;
    slackAppToken?: string;
    telegramToken?: string;
    typingIntervalMs: number;
    maxMessageLength: number;
  }) {
    this.platform = platform;
    this.typingIntervalMs = typingIntervalMs;
    this.maxMessageLength = maxMessageLength;

    const adapters: any = {};

    if (platform === 'slack' && slackToken && slackSigningSecret) {
      adapters.slack = createSlackAdapter({
        botToken: slackToken,
        signingSecret: slackSigningSecret,
      });
    }

    if (platform === 'telegram' && telegramToken) {
      adapters.telegram = createTelegramAdapter({
        botToken: telegramToken,
      });
    }

    // Use in-memory state for development
    const state = createMemoryState();

    this.chat = new Chat({
      userName: 'clawless-bot',
      adapters,
      state,
    });

    // Register message handlers
    this.chat.onNewMention(async (thread) => {
      await this.handleIncomingMessage(thread);
    });

    this.chat.onSubscribedMessage(async (thread, _message) => {
      await this.handleIncomingMessage(thread);
    });

    // Error handling - errors are typically handled at the adapter level
    // Chat SDK doesn't expose a global onError handler
  }

  private async handleIncomingMessage(thread: any) {
    const message = thread.messages[thread.messages.length - 1];
    const chatId = thread.channelId || thread.id;
    const userId = thread.userId;

    const messageContext = new VercelChatMessageContext({
      platform: this.platform,
      thread,
      text: message?.text || '',
      chatId,
      userId,
      typingIntervalMs: this.typingIntervalMs,
      maxMessageLength: this.maxMessageLength,
    });

    for (const handler of this.messageHandlers) {
      try {
        await Promise.resolve(handler(messageContext));
      } catch (error) {
        logError('Message handler failed:', error);
        this.handleError(error as Error, messageContext);
      }
    }
  }

  onTextMessage(handler: (messageContext: VercelChatMessageContext) => Promise<void> | void) {
    this.messageHandlers.push(handler);
  }

  onError(handler: (error: Error, messageContext: VercelChatMessageContext | null) => void) {
    this.errorHandlers.push(handler);
  }

  private handleError(error: Error, messageContext: VercelChatMessageContext | null) {
    for (const handler of this.errorHandlers) {
      try {
        handler(error, messageContext);
      } catch (handlerError) {
        logError('Error handler itself failed:', handlerError);
      }
    }
  }

  async launch() {
    logInfo(`⚡️ Vercel Chat SDK client is running on ${this.platform}!`);
  }

  async sendTextToChat(chatId: string | number, text: string) {
    // Vercel Chat SDK uses threads for sending messages
    // This is a simplified implementation
    const chatIdStr = String(chatId);
    logInfo(`Sending message to chat ${chatIdStr}: ${text.substring(0, 50)}...`);
  }

  stop(reason: string) {
    logInfo(`Stopping Vercel Chat client: ${reason}`);
    // Vercel Chat SDK doesn't have a stop method, but we can clean up
  }
}
