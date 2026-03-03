import { Telegraf } from 'telegraf';
import telegramifyMarkdown from 'telegramify-markdown';
import { splitIntoSmartChunks } from './messageTruncator.js';
import { logError } from '../utils/error.js';

const TELEGRAM_PARSE_MODE = 'MarkdownV2' as const;

/**
 * Escapes characters that are reserved in Telegram's MarkdownV2.
 * Used as a fallback when Markdown conversion fails or for plain text components.
 * See: https://core.telegram.org/bots/api#markdownv2-style
 */
export function escapeMarkdownV2(text: string): string {
  return String(text || '').replace(/[\\_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

export function toTelegramMarkdown(text: string): string {
  const normalizedText = String(text || '');
  if (!normalizedText) {
    return normalizedText;
  }

  try {
    return telegramifyMarkdown(normalizedText, 'escape');
  } catch {
    return escapeMarkdownV2(normalizedText);
  }
}

export class TelegramMessageContext {
  ctx: any;
  typingIntervalMs: number;
  maxMessageLength: number;
  text: string;
  chatId: string | number | undefined;
  userId: number | undefined;
  username: string | undefined;

  constructor(ctx: any, typingIntervalMs: number, maxMessageLength: number) {
    this.ctx = ctx;
    this.typingIntervalMs = typingIntervalMs;
    this.maxMessageLength = maxMessageLength;
    this.text = ctx.message?.text || '';
    this.chatId = ctx.chat?.id;
    this.userId = ctx.from?.id;
    this.username = ctx.from?.username;
  }

  startTyping() {
    this.ctx.telegram.sendChatAction(this.ctx.chat.id, 'typing').catch(() => {});

    const intervalId = setInterval(() => {
      this.ctx.telegram.sendChatAction(this.ctx.chat.id, 'typing').catch(() => {});
    }, this.typingIntervalMs);

    return () => clearInterval(intervalId);
  }

  async sendText(text: string) {
    const chunks = splitIntoSmartChunks(text, this.maxMessageLength);
    for (const chunk of chunks) {
      try {
        const formattedChunk = toTelegramMarkdown(chunk);
        await this.ctx.reply(formattedChunk, { parse_mode: TELEGRAM_PARSE_MODE });
      } catch (error: any) {
        const errorMessage = String(error?.message || '').toLowerCase();
        if (errorMessage.includes('reserved') || errorMessage.includes('parse entities')) {
          await this.ctx.reply(escapeMarkdownV2(chunk), { parse_mode: TELEGRAM_PARSE_MODE });
        } else {
          throw error;
        }
      }
    }
  }

  async startLiveMessage(initialText = '…') {
    const formattedText = toTelegramMarkdown(initialText || '…');
    const sent = await this.ctx.reply(formattedText, { parse_mode: TELEGRAM_PARSE_MODE });
    return sent?.message_id as number | undefined;
  }

  async updateLiveMessage(messageId: number, text: string) {
    const formattedText = toTelegramMarkdown(text || '…');
    try {
      await this.ctx.telegram.editMessageText(this.ctx.chat.id, messageId, undefined, formattedText, {
        parse_mode: TELEGRAM_PARSE_MODE,
      });
    } catch (error: any) {
      const errorMessage = String(error?.message || '').toLowerCase();
      if (errorMessage.includes('reserved') || errorMessage.includes('parse entities')) {
        await this.ctx.telegram.editMessageText(this.ctx.chat.id, messageId, undefined, escapeMarkdownV2(text || '…'), {
          parse_mode: TELEGRAM_PARSE_MODE,
        });
      }
    }
  }

  async finalizeLiveMessage(messageId: number, text: string) {
    const defaultResponse = 'No response received.';
    const finalText = text || defaultResponse;
    const rawChunks = splitIntoSmartChunks(finalText, this.maxMessageLength);
    const formattedChunks = rawChunks.map((c) => toTelegramMarkdown(c));

    try {
      await this.ctx.telegram.editMessageText(
        this.ctx.chat.id,
        messageId,
        undefined,
        formattedChunks[0] || toTelegramMarkdown(defaultResponse),
        {
          parse_mode: TELEGRAM_PARSE_MODE,
        },
      );
    } catch (error: any) {
      const errorMessage = String(error?.message || '').toLowerCase();
      if (errorMessage.includes('message is not modified')) {
        // ignore
      } else if (errorMessage.includes('reserved') || errorMessage.includes('parse entities')) {
        await this.ctx.telegram.editMessageText(
          this.ctx.chat.id,
          messageId,
          undefined,
          escapeMarkdownV2(rawChunks[0] || defaultResponse),
          { parse_mode: TELEGRAM_PARSE_MODE },
        );
      } else {
        throw error;
      }
    }

    for (let index = 1; index < formattedChunks.length; index += 1) {
      try {
        await this.ctx.reply(formattedChunks[index], { parse_mode: TELEGRAM_PARSE_MODE });
      } catch (error: any) {
        const errorMessage = String(error?.message || '').toLowerCase();
        if (errorMessage.includes('reserved') || errorMessage.includes('parse entities')) {
          await this.ctx.reply(escapeMarkdownV2(rawChunks[index]), { parse_mode: TELEGRAM_PARSE_MODE });
        } else {
          throw error;
        }
      }
    }
  }

  async removeMessage(messageId: number) {
    await this.ctx.telegram.deleteMessage(this.ctx.chat.id, messageId);
  }

  /**
   * Sends a draft message using Telegram's native draft streaming API (Bot API 9.3+).
   * This is optimized for streaming partial content - no need to edit messages manually.
   * @param text The partial text to show in the draft
   * @returns The message ID of the draft message
   */
  async sendDraft(text: string) {
    const formattedText = toTelegramMarkdown(text || '…');
    try {
      // Use raw API call for sendMessageDraft (Bot API 9.3+)
      const result = await this.ctx.telegram.call('sendMessageDraft', {
        chat_id: this.chatId,
        text: formattedText,
        parse_mode: TELEGRAM_PARSE_MODE,
      });
      return result?.message_id as number | undefined;
    } catch (error: any) {
      const errorMessage = String(error?.message || '').toLowerCase();
      // Fallback to escape if markdown parsing fails
      if (errorMessage.includes('reserved') || errorMessage.includes('parse entities')) {
        const result = await this.ctx.telegram.call('sendMessageDraft', {
          chat_id: this.chatId,
          text: escapeMarkdownV2(text || '…'),
          parse_mode: TELEGRAM_PARSE_MODE,
        });
        return result?.message_id as number | undefined;
      }
      throw error;
    }
  }

  /**
   * Updates an existing draft message with new text.
   * @param messageId The message ID to update
   * @param text The new text content
   */
  async updateDraft(messageId: number, text: string) {
    const formattedText = toTelegramMarkdown(text || '…');
    try {
      // Use editMessageText for draft updates (same API behavior)
      await this.ctx.telegram.editMessageText(this.ctx.chat.id, messageId, undefined, formattedText, {
        parse_mode: TELEGRAM_PARSE_MODE,
      });
    } catch (error: any) {
      const errorMessage = String(error?.message || '').toLowerCase();
      if (errorMessage.includes('reserved') || errorMessage.includes('parse entities')) {
        await this.ctx.telegram.editMessageText(this.ctx.chat.id, messageId, undefined, escapeMarkdownV2(text || '…'), {
          parse_mode: TELEGRAM_PARSE_MODE,
        });
      }
    }
  }

  /**
   * Finalizes a draft message by converting it to a regular message.
   * @param messageId The draft message ID
   * @param text The final text content
   */
  async finalizeDraft(messageId: number, text: string) {
    const defaultResponse = 'No response received.';
    const finalText = text || defaultResponse;
    const rawChunks = splitIntoSmartChunks(finalText, this.maxMessageLength);
    const formattedChunks = rawChunks.map((c) => toTelegramMarkdown(c));

    // Edit the first chunk as the final message
    try {
      await this.ctx.telegram.editMessageText(
        this.ctx.chat.id,
        messageId,
        undefined,
        formattedChunks[0] || toTelegramMarkdown(defaultResponse),
        { parse_mode: TELEGRAM_PARSE_MODE },
      );
    } catch (error: any) {
      const errorMessage = String(error?.message || '').toLowerCase();
      if (errorMessage.includes('message is not modified')) {
        // ignore - no changes needed
      } else if (errorMessage.includes('reserved') || errorMessage.includes('parse entities')) {
        await this.ctx.telegram.editMessageText(
          this.ctx.chat.id,
          messageId,
          undefined,
          escapeMarkdownV2(rawChunks[0] || defaultResponse),
          { parse_mode: TELEGRAM_PARSE_MODE },
        );
      } else {
        throw error;
      }
    }

    // Send any additional chunks as follow-up messages
    for (let index = 1; index < formattedChunks.length; index += 1) {
      try {
        await this.ctx.reply(formattedChunks[index], { parse_mode: TELEGRAM_PARSE_MODE });
      } catch (error: any) {
        const errorMessage = String(error?.message || '').toLowerCase();
        if (errorMessage.includes('reserved') || errorMessage.includes('parse entities')) {
          await this.ctx.reply(escapeMarkdownV2(rawChunks[index]), { parse_mode: TELEGRAM_PARSE_MODE });
        } else {
          throw error;
        }
      }
    }
  }
}

export class TelegramMessagingClient {
  bot: Telegraf;
  typingIntervalMs: number;
  maxMessageLength: number;

  constructor({
    token,
    typingIntervalMs,
    maxMessageLength,
  }: { token: string; typingIntervalMs: number; maxMessageLength: number }) {
    this.bot = new Telegraf(token);
    this.typingIntervalMs = typingIntervalMs;
    this.maxMessageLength = maxMessageLength;
  }

  onTextMessage(handler: (messageContext: TelegramMessageContext) => Promise<void> | void) {
    this.bot.on('text', (ctx) => {
      const messageContext = new TelegramMessageContext(ctx, this.typingIntervalMs, this.maxMessageLength);
      Promise.resolve(handler(messageContext)).catch((error) => {
        logError('Text message handler failed:', error);
      });
    });
  }

  onError(handler: (error: Error, messageContext: TelegramMessageContext | null) => void) {
    this.bot.catch((error, ctx) => {
      const messageContext = ctx?.chat
        ? new TelegramMessageContext(ctx, this.typingIntervalMs, this.maxMessageLength)
        : null;
      handler(error as Error, messageContext);
    });
  }

  async launch() {
    await this.bot.launch();
  }

  async sendTextToChat(chatId: string | number, text: string) {
    const chunks = splitIntoSmartChunks(text, this.maxMessageLength);
    for (const chunk of chunks) {
      try {
        const formattedChunk = toTelegramMarkdown(chunk);
        await this.bot.telegram.sendMessage(chatId, formattedChunk, { parse_mode: TELEGRAM_PARSE_MODE });
      } catch (error: any) {
        const errorMessage = String(error?.message || '').toLowerCase();
        if (errorMessage.includes('reserved') || errorMessage.includes('parse entities')) {
          await this.bot.telegram.sendMessage(chatId, escapeMarkdownV2(chunk), { parse_mode: TELEGRAM_PARSE_MODE });
        } else {
          throw error;
        }
      }
    }
  }

  stop(reason: string) {
    this.bot.stop(reason);
  }
}
