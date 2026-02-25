import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processSingleTelegramMessage } from './StreamingMessageSender.js';

describe('processSingleTelegramMessage', () => {
  const createMockMessageContext = () => ({
    chatId: 'test-chat-id',
    text: 'test message',
    startTyping: vi.fn().mockReturnValue(() => {}),
    sendText: vi.fn().mockResolvedValue({}),
    startLiveMessage: vi.fn().mockResolvedValue('live-msg-id'),
    updateLiveMessage: vi.fn().mockResolvedValue({}),
    finalizeLiveMessage: vi.fn().mockResolvedValue({}),
    removeMessage: vi.fn().mockResolvedValue({}),
  });

  const createMockParams = (
    messageContext: ReturnType<typeof createMockMessageContext>,
    overrides?: {
      maxResponseLength?: number;
      streamUpdateIntervalMs?: number;
      acpDebugStream?: boolean;
      approvalMode?: string;
      maxRetries?: number;
      retryDelayMs?: number;
      runAcpPrompt?: ReturnType<typeof vi.fn>;
      scheduleAsyncJob?: ReturnType<typeof vi.fn>;
      logInfo?: ReturnType<typeof vi.fn>;
      getErrorMessage?: ReturnType<typeof vi.fn>;
    },
  ) => {
    return {
      messageContext,
      messageRequestId: 1,
      maxResponseLength: 100,
      streamUpdateIntervalMs: 100,
      acpDebugStream: false,
      approvalMode: 'yolo',
      maxRetries: 3,
      retryDelayMs: 1000,
      runAcpPrompt: vi.fn(),
      scheduleAsyncJob: vi.fn().mockResolvedValue('job-id'),
      logInfo: vi.fn(),
      getErrorMessage: vi.fn((e) => (e as Error).message),
      ...overrides,
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends the actual task message content in ASYNC mode when yolo mode is enabled', async () => {
    const mockMessageContext = createMockMessageContext();
    const mockParams = createMockParams(mockMessageContext);
    const fullResponse = '[MODE: ASYNC] Do some work';
    mockParams.runAcpPrompt.mockResolvedValue(fullResponse);

    await processSingleTelegramMessage(mockParams as any);

    expect(mockParams.scheduleAsyncJob).toHaveBeenCalled();
    expect(mockMessageContext.sendText).toHaveBeenCalledWith(expect.stringContaining('Do some work (Reference: job_'));
  });

  it('does not wrap prompt with hybrid mode when not in yolo mode', async () => {
    const mockMessageContext = createMockMessageContext();
    const mockParams = createMockParams(mockMessageContext, { approvalMode: 'default' });
    const fullResponse = 'Some response';
    mockParams.runAcpPrompt.mockResolvedValue(fullResponse);

    await processSingleTelegramMessage(mockParams as any);

    // Should not schedule async job since no hybrid mode prompt was used
    expect(mockParams.scheduleAsyncJob).not.toHaveBeenCalled();
    // The prompt should be the raw message text (not wrapped with hybrid mode instructions)
    expect(mockParams.runAcpPrompt).toHaveBeenCalledWith('test message', expect.any(Function));
  });
});
