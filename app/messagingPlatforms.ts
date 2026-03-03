/**
 * Shared Messaging Platform Types and Errors
 * Used by MessagingInitializer and platform implementations
 */

import type { VercelChatMessageContext, VercelChatMessagingClient } from '../messaging/vercelChatClient.js';

export type MessagingClient = VercelChatMessagingClient;
export type MessageContext = VercelChatMessageContext;

// Re-export errors from centralized error module
export { ClawlessError, PlatformNotSupportedError, WhitelistError } from '../utils/errors.js';

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
