import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processSingleTelegramMessage } from './liveMessageProcessor.js';

describe('processSingleTelegramMessage', () => {
  const mockMessageContext = {
    chatId: 'test-chat-id',
    text: 'test message',
    startTyping: vi.fn().mockReturnValue(() => {}),
    sendText: vi.fn().mockResolvedValue({}),
    startLiveMessage: vi.fn().mockResolvedValue('live-msg-id'),
    updateLiveMessage: vi.fn().mockResolvedValue({}),
    finalizeLiveMessage: vi.fn().mockResolvedValue({}),
    removeMessage: vi.fn().mockResolvedValue({}),
  };

  const mockParams = {
    messageContext: mockMessageContext,
    messageRequestId: 1,
    maxResponseLength: 100,
    streamUpdateIntervalMs: 100,
    acpDebugStream: false,
    approvalMode: 'yolo',
    runAcpPrompt: vi.fn(),
    scheduleAsyncJob: vi.fn().mockResolvedValue('job-id'),
    logInfo: vi.fn(),
    getErrorMessage: vi.fn((e) => (e as Error).message),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends the actual task message content in ASYNC mode when yolo mode is enabled', async () => {
    const fullResponse = '[MODE: ASYNC] Do some work';
    mockParams.runAcpPrompt.mockResolvedValue(fullResponse);

    await processSingleTelegramMessage(mockParams as any);

    expect(mockParams.scheduleAsyncJob).toHaveBeenCalled();
    expect(mockMessageContext.sendText).toHaveBeenCalledWith(expect.stringContaining('Do some work (Reference: job_'));
  });

  it('does not wrap prompt with hybrid mode when not in yolo mode', async () => {
    const fullResponse = 'Some response';
    mockParams.runAcpPrompt.mockResolvedValue(fullResponse);
    mockParams.approvalMode = 'default';

    await processSingleTelegramMessage(mockParams as any);

    // Should not schedule async job since no hybrid mode prompt was used
    expect(mockParams.scheduleAsyncJob).not.toHaveBeenCalled();
    // The prompt should be the raw message text (not wrapped with hybrid mode instructions)
    expect(mockParams.runAcpPrompt).toHaveBeenCalledWith('test message', expect.any(Function));

    mockParams.approvalMode = 'yolo'; // reset for other tests
  });
});
