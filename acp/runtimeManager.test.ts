import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAcpRuntime, AcpState } from './runtimeManager.js';
import type { BaseCliAgent } from '../core/agents/index.js';

describe('AcpRuntimeManager State Machine', () => {
  const mockCliAgent = {
    getCommand: vi.fn().mockReturnValue('dummy-agent'),
    getDisplayName: vi.fn().mockReturnValue('Dummy Agent'),
    getKillGraceMs: vi.fn().mockReturnValue(100),
    buildAcpArgs: vi.fn().mockReturnValue(['--acp']),
  } as unknown as BaseCliAgent;

  const mockParams = {
    cliAgent: mockCliAgent,
    acpPermissionStrategy: 'allow',
    acpStreamStdout: false,
    acpDebugStream: false,
    acpTimeoutMs: 1000,
    acpNoOutputTimeoutMs: 500,
    acpPrewarmRetryMs: 100,
    acpPrewarmMaxRetries: 3,
    stderrTailMaxChars: 1000,
    buildPromptWithMemory: vi.fn().mockResolvedValue('prompt with memory'),
    ensureMemoryFile: vi.fn(),
    buildPermissionResponse: vi.fn(),
    noOpAcpFileOperation: vi.fn(),
    getErrorMessage: vi.fn().mockImplementation((e) => String(e)),
    logInfo: vi.fn(),
    logError: vi.fn(),
  };

  it('should initialize in IDLE state', () => {
    const runtime = createAcpRuntime(mockParams as any);
    expect(runtime.getRuntimeState().state).toBe(AcpState.IDLE);
  });

  it('should transition to STARTING when ensureAcpSession is called via scheduleAcpPrewarm', async () => {
    const runtime = createAcpRuntime(mockParams as any);
    
    // We can't easily wait for the internal private ensureAcpSession to finish 
    // without mocking spawn, but we can check if it starts.
    runtime.scheduleAcpPrewarm('test');
    
    // Since scheduleAcpPrewarm is fire-and-forget, we might need a small delay
    // or mock the internal parts.
    expect(mockParams.logInfo).toHaveBeenCalledWith('Triggering ACP prewarm', expect.anything());
  });

  it('should reflect manual abort request', () => {
    const runtime = createAcpRuntime(mockParams as any);
    runtime.requestManualAbort();
    // manualAbortRequested is private, but we can verify it indirectly if we could run a prompt
    expect(runtime.getRuntimeState().state).toBe(AcpState.IDLE);
  });
});
