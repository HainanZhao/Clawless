import { debounce } from 'lodash-es';
import { generateShortId } from '../utils/commandText.js';
import { ConversationMode, detectConversationMode, wrapHybridPrompt } from './ModeDetector.js';
import { smartTruncate } from './messageTruncator.js';

type LogInfoFn = (message: string, details?: unknown) => void;

type ProcessSingleMessageParams = {
  messageContext: any;
  messageRequestId: number;
  maxResponseLength: number;
  streamUpdateIntervalMs: number;
  acpDebugStream: boolean;
  approvalMode?: string;
  runAcpPrompt: (promptText: string, onChunk?: (chunk: string) => void) => Promise<string>;
  scheduleAsyncJob: (message: string, chatId: string, jobRef: string) => Promise<string>;
  logInfo: LogInfoFn;
  getErrorMessage: (error: unknown, fallbackMessage?: string) => string;
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
    private readonly messageContext: any,
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

export async function processSingleTelegramMessage(params: ProcessSingleMessageParams) {
  const {
    messageContext,
    messageRequestId,
    maxResponseLength,
    streamUpdateIntervalMs,
    acpDebugStream,
    approvalMode,
    runAcpPrompt,
    scheduleAsyncJob,
    logInfo,
    getErrorMessage,
    onConversationComplete,
  } = params;

  const isYoloMode = approvalMode === 'yolo';

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

  const skipHybridMode = !isYoloMode;

  if (skipHybridMode) {
    logInfo('Mode detection skipped: not in yolo mode', { requestId: messageRequestId });
  }

  try {
    const prompt = skipHybridMode ? messageContext.text : wrapHybridPrompt(messageContext.text);

    // Mode detection state (only used when hybrid mode is enabled)
    let conversationMode = ConversationMode.UNKNOWN;
    let prefixBuffer = '';

    const fullResponse = await runAcpPrompt(prompt, async (chunk) => {
      // Non-hybrid mode: stream all chunks directly
      if (skipHybridMode) {
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

    // Hybrid mode: finalize mode detection if not detected during streaming
    if (!skipHybridMode && conversationMode === ConversationMode.UNKNOWN) {
      const result = detectConversationMode(fullResponse);
      conversationMode = result.isDetected ? result.mode : ConversationMode.QUICK;
      if (conversationMode === ConversationMode.QUICK) {
        streamSender.setBuffer(result.content);
      }

      if (!result.isDetected) {
        logInfo('No mode prefix detected, defaulting to QUICK', { requestId: messageRequestId });
      }
    }

    // Hybrid mode: handle async job scheduling
    if (conversationMode === ConversationMode.ASYNC) {
      const jobRef = `job_${generateShortId()}`;
      logInfo('Async mode confirmed, scheduling background job', { requestId: messageRequestId, jobRef });

      const taskMessage = detectConversationMode(fullResponse).content || messageContext.text;
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
      const response = streamSender.getBuffer() || 'No response received.';
      await messageContext.sendText(response);
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
