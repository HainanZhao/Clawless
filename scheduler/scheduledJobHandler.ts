import type { ScheduleConfig } from './cronScheduler.js';
import { getErrorMessage } from '../utils/error.js';

export interface ScheduledJobHandlerDeps {
  logInfo: (message: string, details?: unknown) => void;
  buildPromptWithMemory: (userPrompt: string) => Promise<string>;
  runScheduledPromptWithTempAcp: (promptForAgent: string, scheduleId: string) => Promise<string>;
  resolveTargetChatId: () => string | null;
  sendTextToChat: (chatId: string | number, text: string) => Promise<void>;
  normalizeOutgoingText: (text: unknown) => string;
  enqueueMessage: (messageContext: any) => Promise<void>;
}

export function createScheduledJobHandler(deps: ScheduledJobHandlerDeps) {
  const {
    logInfo,
    buildPromptWithMemory,
    runScheduledPromptWithTempAcp,
    resolveTargetChatId,
    sendTextToChat,
    normalizeOutgoingText,
    enqueueMessage,
  } = deps;

  return async function handleScheduledJob(schedule: ScheduleConfig): Promise<void> {
    logInfo('Executing scheduled job', { scheduleId: schedule.id, message: schedule.message, type: schedule.type });

    try {
      const promptForAgent = await buildPromptWithMemory(schedule.message);
      logInfo('Scheduler prompt payload sent to agent', {
        scheduleId: schedule.id,
        prompt: promptForAgent,
      });

      const response = await runScheduledPromptWithTempAcp(promptForAgent, schedule.id);

      if (schedule.type === 'async_conversation') {
        // For async conversation, queue the result back to the main agent loop
        const chatId = schedule.metadata?.chatId;

        if (!chatId) {
          logInfo('Missing chatId for async conversation job', { scheduleId: schedule.id });
          return;
        }

        const systemMessage = `[System Notification]\nBackground task completed.\n\nOriginal Request: "${schedule.message}"\n\nResult:\n${response}\n\nPlease determine the next step or inform the user.`;

        // Mock message context to allow the agent to reply to the user
        const mockContext = {
          chatId,
          text: systemMessage,
          startTyping: () => () => {}, // No-op
          startLiveMessage: async () => 'system-msg-id', // No-op
          updateLiveMessage: async () => {}, // No-op
          finalizeLiveMessage: async () => {}, // No-op
          sendText: async (text: string) => sendTextToChat(chatId, normalizeOutgoingText(text)),
          removeMessage: async () => {}, // No-op
        };

        await enqueueMessage(mockContext);
        logInfo('Async conversation result enqueued to main agent', { scheduleId: schedule.id, chatId });
      } else {
        // Standard cron job behavior: send result directly to chat
        const targetChatId = resolveTargetChatId();
        if (targetChatId) {
          await sendTextToChat(targetChatId, normalizeOutgoingText(response));
          logInfo('Scheduled job result sent to Telegram', { scheduleId: schedule.id, chatId: targetChatId });
        } else {
          logInfo('No target chat available for scheduled job result', { scheduleId: schedule.id });
        }
      }
    } catch (error: any) {
      logInfo('Scheduled job execution failed', {
        scheduleId: schedule.id,
        error: getErrorMessage(error),
      });

      // Handle error reporting
      if (schedule.type === 'async_conversation') {
        const chatId = schedule.metadata?.chatId;
        if (chatId) {
           const errorMessage = `❌ Background task failed: ${schedule.description || schedule.message}\n\nError: ${getErrorMessage(error)}`;
           await sendTextToChat(chatId, normalizeOutgoingText(errorMessage));
        }
      } else {
        const targetChatId = resolveTargetChatId();
        if (targetChatId) {
          const errorMessage = `❌ Scheduled task failed: ${schedule.description || schedule.message}\n\nError: ${getErrorMessage(error)}`;
          await sendTextToChat(targetChatId, normalizeOutgoingText(errorMessage));
        }
      }
    }
  };
}
