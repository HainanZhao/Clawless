import { debounce } from 'lodash-es';
import { generateShortId } from '../utils/commandText.js';
import { ConversationMode, detectConversationMode, wrapHybridPrompt } from './ModeDetector.js';
import { smartTruncate } from './messageTruncator.js';

type LogInfoFn = (message: string, details?: unknown) => void;

type MessageContext = {
  chatId: string;
  text: string;
  startTyping: () => () => void;
  sendText: (text: string) => Promise<unknown>;
};

type ProcessSingleMessageParams = {
  messageContext: MessageContext;
  messageRequestId: number;
  maxResponseLength: number;
  streamUpdateIntervalMs: number;
  acpDebugStream: boolean;
  approvalMode?: string;
  maxRetries?: number;
  retryDelayMs?: number;
  runAcpPrompt: (promptText: string, onChunk?: (chunk: string) => void) => Promise<string>;
  scheduleAsyncJob: (message: string, chatId: string, jobRef: string) => Promise<string>;
  logInfo: LogInfoFn;
  getErrorMessage: (error: unknown) => string;
  onConversationComplete?: (userMessage: string, botResponse: string, chatId: string) => void;
};

/**
 * Manages streaming message output by sending chunks periodically.
 * Tracks what has been sent to avoid duplicate content.
 */
class StreamingMessageSender {
  private sentLength = 0;
  private buffer = '';
  private finalized = false;
  private debouncedFlush: ReturnType<typeof debounce>;

  constructor(
    private readonly messageContext: MessageContext,
    private readonly requestId: number,
    private readonly maxResponseLength: number,
    streamUpdateIntervalMs: number,
    private readonly logInfo: LogInfoFn,
    private readonly getErrorMessage: (error: unknown) => string,
    private readonly acpDebugStream: boolean,
  ) {
    this.debouncedFlush = debounce(
      async () => {
        await this.sendNewContent();
      },
      streamUpdateIntervalMs,
      { leading: false, trailing: true },
    );
  }

  append(chunk: string) {
    this.buffer += chunk;
    void this.debouncedFlush();
  }

  getBuffer() {
    return this.buffer;
  }

  setBuffer(text: string) {
    this.buffer = text;
  }

  reset() {
    this.buffer = '';
    this.sentLength = 0;
    this.finalized = false;
    this.debouncedFlush.cancel();
  }

  private getTruncatedBuffer() {
    return smartTruncate(this.buffer, { maxLength: this.maxResponseLength });
  }

  private async sendNewContent() {
    if (this.finalized) return;

    const text = this.getTruncatedBuffer();
    const newContent = text.slice(this.sentLength).trim();
    if (!newContent) return;

    try {
      await this.messageContext.sendText(newContent);
      this.sentLength = text.length;
      if (this.acpDebugStream) {
        this.logInfo('Stream chunk sent', {
          requestId: this.requestId,
          chunkLength: newContent.length,
        });
      }
    } catch (error: any) {
      this.logInfo('Failed to send stream chunk', {
        requestId: this.requestId,
        error: this.getErrorMessage(error),
      });
    }
  }

  async finalize(textOverride?: string) {
    if (this.finalized) return;

    this.debouncedFlush.cancel();
    if (textOverride) {
      this.buffer = textOverride;
    }

    await this.sendNewContent();
    this.finalized = true;
  }

  cancel() {
    this.debouncedFlush.cancel();
  }

  hasSentContent() {
    return this.sentLength > 0;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function processSingleTelegramMessage(params: ProcessSingleMessageParams) {
  const {
    messageContext,
    messageRequestId,
    maxResponseLength,
    streamUpdateIntervalMs,
    acpDebugStream,
    approvalMode,
    maxRetries = 3,
    retryDelayMs = 5000,
    runAcpPrompt,
    scheduleAsyncJob,
    logInfo,
    getErrorMessage,
    onConversationComplete,
  } = params;

  const isHybridMode = approvalMode === 'yolo';

  logInfo('Starting message processing', {
    requestId: messageRequestId,
    chatId: messageContext.chatId,
  });

  const stopTypingIndicator = messageContext.startTyping();
  const streamSender = new StreamingMessageSender(
    messageContext,
    messageRequestId,
    maxResponseLength,
    streamUpdateIntervalMs,
    logInfo,
    getErrorMessage,
    acpDebugStream,
  );

  if (!isHybridMode) {
    logInfo('Mode detection skipped: not in yolo mode', { requestId: messageRequestId });
  }

  try {
    const prompt = isHybridMode ? wrapHybridPrompt(messageContext.text) : messageContext.text;

    // Mode detection state (only used when hybrid mode is enabled)
    let conversationMode = ConversationMode.UNKNOWN;
    let prefixBuffer = '';

    // Retry logic with exponential backoff
    let fullResponse = '';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Reset stream sender state for retry
        if (attempt > 0) {
          streamSender.reset();
          prefixBuffer = '';
          conversationMode = ConversationMode.UNKNOWN;
        }

        fullResponse = await runAcpPrompt(prompt, async (chunk) => {
          // Non-hybrid mode: stream all chunks directly
          if (!isHybridMode) {
            streamSender.append(chunk);
            return;
          }

          // Hybrid mode: detect mode prefix from streaming chunks
          if (conversationMode === ConversationMode.ASYNC) return; // Suppress output for async

          if (conversationMode === ConversationMode.UNKNOWN) {
            prefixBuffer += chunk;
            const result = detectConversationMode(prefixBuffer);

            if (result.isDetected) {
              conversationMode = result.mode;
              logInfo('Mode detected via streaming', { requestId: messageRequestId, mode: conversationMode });

              if (conversationMode === ConversationMode.QUICK) {
                streamSender.append(result.content);
              }
            }
            return;
          }

          streamSender.append(chunk);
        });

        // Success - break out of retry loop
        break;
      } catch (error: any) {
        const errorMessage = getErrorMessage(error);

        // Check if this is a retriable error (capacity, rate limit, timeout, etc.)
        const isRetriable =
          errorMessage.toLowerCase().includes('capacity') ||
          errorMessage.toLowerCase().includes('rate limit') ||
          errorMessage.toLowerCase().includes('timeout') ||
          errorMessage.toLowerCase().includes('unavailable') ||
          errorMessage.toLowerCase().includes('overload');

        const canRetry = attempt < maxRetries && isRetriable;

        if (canRetry) {
          const delay = retryDelayMs * 2 ** attempt; // Exponential backoff
          logInfo('Agent request failed, retrying...', {
            requestId: messageRequestId,
            attempt: attempt + 1,
            maxRetries,
            delayMs: delay,
            error: errorMessage,
          });

          await messageContext.sendText(`⚠️ LLM rate limit issue, retrying (${attempt + 1}/${maxRetries})...`);
          await sleep(delay);
        } else {
          // Non-retriable or exhausted retries
          throw error;
        }
      }
    }

    // fullResponse is guaranteed to be set at this point
    const response = fullResponse;

    // Hybrid mode: finalize mode detection if not detected during streaming
    let modeResult: ReturnType<typeof detectConversationMode> | null = null;
    if (isHybridMode && conversationMode === ConversationMode.UNKNOWN) {
      modeResult = detectConversationMode(response);
      conversationMode = modeResult.isDetected ? modeResult.mode : ConversationMode.QUICK;
      if (conversationMode === ConversationMode.QUICK) {
        streamSender.setBuffer(modeResult.content);
      }

      if (!modeResult.isDetected) {
        logInfo('No mode prefix detected, defaulting to QUICK', { requestId: messageRequestId });
      }
    }

    // Handle async job scheduling when ASYNC mode is detected
    if (conversationMode === ConversationMode.ASYNC) {
      const jobRef = `job_${generateShortId()}`;
      logInfo('Async mode confirmed, scheduling background job', { requestId: messageRequestId, jobRef });

      // Reuse modeResult if available, otherwise parse response
      const taskMessage = modeResult?.content || detectConversationMode(response).content;
      void scheduleAsyncJob(taskMessage, messageContext.chatId, jobRef).catch((error) => {
        logInfo('Fire-and-forget scheduleAsyncJob failed', {
          requestId: messageRequestId,
          jobRef,
          error: getErrorMessage(error),
        });
      });

      const finalMsg = `${taskMessage} (Reference: ${jobRef})`;
      await messageContext.sendText(finalMsg);
      return;
    }

    // Completion for QUICK mode
    await streamSender.finalize();

    // Send fallback message if nothing was sent
    if (!streamSender.hasSentContent()) {
      const fallbackResponse = streamSender.getBuffer() || 'No response received.';
      await messageContext.sendText(fallbackResponse);
    }

    if (onConversationComplete && streamSender.getBuffer()) {
      try {
        onConversationComplete(messageContext.text, streamSender.getBuffer(), messageContext.chatId);
      } catch (error: any) {
        logInfo('Failed to track conversation history', { requestId: messageRequestId, error: getErrorMessage(error) });
      }
    }
  } finally {
    streamSender.cancel();
    stopTypingIndicator();
    logInfo('Finished message processing', {
      requestId: messageRequestId,
      chatId: messageContext.chatId,
    });
  }
}
