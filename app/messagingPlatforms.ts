/**
 * Shared Messaging Platform Types and Errors
 * Used by MessagingInitializer and platform implementations
 */

import type { TelegramMessagingClient } from '../messaging/telegramClient.js';
import type { TelegramMessageContext } from '../messaging/telegramClient.js';
import type { SlackMessagingClient } from '../messaging/slackClient.js';
import type { SlackMessageContext } from '../messaging/slackClient.js';
import { ClawlessError } from '../utils/errors.js';

export type MessagingClient = TelegramMessagingClient | SlackMessagingClient;
export type MessageContext = TelegramMessageContext | SlackMessageContext;

// Re-export errors for convenience
export { ClawlessError } from '../utils/errors.js';

export class PlatformNotSupportedError extends ClawlessError {
  constructor(platform: string) {
    super(`Messaging platform '${platform}' is not supported`, 'UNSUPPORTED_PLATFORM', 400, { platform });
    this.name = 'PlatformNotSupportedError';
  }
}

export class WhitelistError extends ClawlessError {
  constructor(platform: string) {
    super(`${platform} whitelist is required but not configured`, 'MISSING_WHITELIST', 500, { platform });
    this.name = 'WhitelistError';
  }
}

// Platform capability interface for future extensibility
export interface MessagingPlatformCapabilities {
  supportsMarkdown?: boolean;
  supportsInlineButtons?: boolean;
  supportsPolls?: boolean;
  supportsVoiceMessages?: boolean;
  maxMessageLength?: number;
  supportsThreading?: boolean;
}

export const platformCapabilities: Record<string, MessagingPlatformCapabilities> = {
  telegram: {
    supportsMarkdown: true,
    supportsInlineButtons: true,
    supportsPolls: true,
    supportsVoiceMessages: true,
    maxMessageLength: 4096,
    supportsThreading: true,
  },
  slack: {
    supportsMarkdown: true,
    supportsInlineButtons: true,
    supportsPolls: true,
    supportsVoiceMessages: false,
    maxMessageLength: 30000,
    supportsThreading: true,
  },
};

export function getPlatformCapabilities(platform: string): MessagingPlatformCapabilities | undefined {
  return platformCapabilities[platform];
}
