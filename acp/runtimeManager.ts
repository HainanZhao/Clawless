import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { getMcpServersForSession } from './mcpServerHelpers.js';
import type { BaseCliAgent } from '../core/agents/index.js';

// Extend BaseCliAgent interface to include optional getMcpServersForAcp method
interface CliAgentWithMcp extends BaseCliAgent {
  getMcpServersForAcp?(): unknown[];
}

type LogInfoFn = (message: string, details?: unknown) => void;
type GetErrorMessageFn = (error: unknown, fallbackMessage?: string) => string;

type CreateAcpRuntimeParams = {
  cliAgent: BaseCliAgent;
  acpPermissionStrategy: string;
  acpStreamStdout: boolean;
  acpDebugStream: boolean;
  acpTimeoutMs: number;
  acpNoOutputTimeoutMs: number;
  acpPrewarmRetryMs: number;
  acpPrewarmMaxRetries: number;
  acpMcpServersJson?: string;
  stderrTailMaxChars: number;
  buildPromptWithMemory: (userPrompt: string) => Promise<string>;
  ensureMemoryFile: () => void;
  buildPermissionResponse: (options: any, strategy: string) => any;
  noOpAcpFileOperation: (params: any) => any;
  getErrorMessage: GetErrorMessageFn;
  logInfo: LogInfoFn;
  logError: LogInfoFn;
};

export type AcpRuntime = {
  buildAgentAcpArgs: () => string[];
  runAcpPrompt: (promptText: string, onChunk?: (chunk: string) => void) => Promise<string>;
  scheduleAcpPrewarm: (reason: string) => void;
  shutdownAcpRuntime: (reason: string) => Promise<void>;
  cancelActiveAcpPrompt: () => Promise<void>;
  hasActiveAcpPrompt: () => boolean;
  requestManualAbort: () => void;
  getRuntimeState: () => {
    acpSessionReady: boolean;
    agentProcessRunning: boolean;
  };
  appendContext: (text: string) => Promise<void>;
};

export function createAcpRuntime({
  cliAgent,
  acpPermissionStrategy,
  acpStreamStdout,
  acpTimeoutMs,
  acpNoOutputTimeoutMs,
  acpPrewarmRetryMs,
  acpPrewarmMaxRetries,
  acpMcpServersJson,
  stderrTailMaxChars,
  buildPromptWithMemory,
  ensureMemoryFile,
  buildPermissionResponse,
  noOpAcpFileOperation,
  getErrorMessage,
  logInfo,
}: Omit<CreateAcpRuntimeParams, 'acpDebugStream' | 'logError'>): AcpRuntime {
  const agentCommand = cliAgent.getCommand();
  const agentDisplayName = cliAgent.getDisplayName();
  const killGraceMs = cliAgent.getKillGraceMs();

  let agentProcess: any = null;
  let acpConnection: any = null;
  let acpSessionId: any = null;
  let acpInitPromise: Promise<void> | null = null;
  let activePromptCollector: any = null;
  let manualAbortRequested = false;
  let acpPrewarmRetryTimer: NodeJS.Timeout | null = null;
  let acpPrewarmRetryAttempts = 0;
  let agentStderrTail = '';

  const appendAgentStderrTail = (text: string) => {
    agentStderrTail = `${agentStderrTail}${text}`;
    if (agentStderrTail.length > stderrTailMaxChars) {
      agentStderrTail = agentStderrTail.slice(-stderrTailMaxChars);
    }
  };

  const terminateProcessGracefully = (
    childProcess: ChildProcessWithoutNullStreams,
    _processLabel: string,
    _details?: Record<string, unknown>,
  ) => {
    return new Promise<void>((resolve) => {
      if (!childProcess || childProcess.killed || childProcess.exitCode !== null) {
        resolve();
        return;
      }

      let settled = false;

      const finalize = (_reason: string) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };

      childProcess.once('exit', () => finalize('exit'));

      childProcess.kill('SIGTERM');

      setTimeout(
        () => {
          if (settled || childProcess.killed || childProcess.exitCode !== null) {
            finalize('already-exited');
            return;
          }

          childProcess.kill('SIGKILL');
          finalize('sigkill');
        },
        Math.max(0, killGraceMs),
      );
    });
  };

  const hasHealthyAcpRuntime = () => {
    return Boolean(acpConnection && acpSessionId && agentProcess && !agentProcess.killed);
  };

  const hasActiveAcpPrompt = () => {
    return Boolean(activePromptCollector && acpConnection && acpSessionId);
  };

  const cancelActiveAcpPrompt = async () => {
    try {
      if (acpConnection && acpSessionId) {
        await acpConnection.cancel({ sessionId: acpSessionId });
      }
    } catch (_) {}
  };

  const shutdownAcpRuntime = async (reason: string) => {
    const processToStop = agentProcess;
    const runtimeSessionId = acpSessionId;

    activePromptCollector = null;
    acpConnection = null;
    acpSessionId = null;
    acpInitPromise = null;
    agentProcess = null;
    agentStderrTail = '';

    if (processToStop && !processToStop.killed && processToStop.exitCode === null) {
      await terminateProcessGracefully(processToStop, 'main-acp-runtime', {
        reason,
        sessionId: runtimeSessionId,
      });
    }
  };

  const buildAgentAcpArgs = () => {
    return cliAgent.buildAcpArgs();
  };

  const acpClient = {
    async requestPermission(params: any) {
      return buildPermissionResponse(params?.options, acpPermissionStrategy);
    },

    async sessionUpdate(params: any) {
      if (!activePromptCollector || params.sessionId !== acpSessionId) {
        return;
      }

      activePromptCollector.onActivity();

      const updateType = params.update?.sessionUpdate;
      const contentType = params.update?.content?.type;

      // Handle thinking/thought chunks (internal reasoning, not displayed to user)
      if (updateType === 'agent_thought_chunk') {
        return;
      }

      // ONLY handle regular message chunks of type text
      if (updateType === 'agent_message_chunk' && contentType === 'text') {
        const chunkText = params.update.content.text;
        if (chunkText) {
          activePromptCollector.append(chunkText);
          if (acpStreamStdout) {
            process.stdout.write(chunkText);
          }
        }
      }
    },

    async readTextFile(params: any) {
      return noOpAcpFileOperation(params);
    },

    async writeTextFile(params: any) {
      return noOpAcpFileOperation(params);
    },
  };

  const resetAcpRuntime = () => {
    void shutdownAcpRuntime('runtime-reset');
    scheduleAcpPrewarm('runtime reset');
  };

  const ensureAcpSession = async () => {
    ensureMemoryFile();

    if (acpConnection && acpSessionId && agentProcess && !agentProcess.killed) {
      return;
    }

    if (acpInitPromise) {
      await acpInitPromise;
      return;
    }

    acpInitPromise = (async () => {
      const args = buildAgentAcpArgs();

      // First, try to get MCP servers from the agent (e.g., from Gemini settings)
      let mcpServers: unknown[] = [];

      const agentWithMcp = cliAgent as CliAgentWithMcp;
      if (typeof agentWithMcp.getMcpServersForAcp === 'function') {
        mcpServers = agentWithMcp.getMcpServersForAcp();
      }

      // Fall back to environment variable if agent didn't provide MCP servers
      if (mcpServers.length === 0) {
        const envResult = getMcpServersForSession({
          acpMcpServersJson,
          logInfo,
          getErrorMessage,
          invalidEnvMessage: 'Invalid ACP_MCP_SERVERS_JSON; using empty mcpServers array',
        });
        mcpServers = envResult.mcpServers;
      }

      agentStderrTail = '';
      agentProcess = spawn(agentCommand, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: process.cwd(),
      });

      agentProcess.stderr.on('data', (chunk: Buffer) => {
        const rawText = chunk.toString();
        appendAgentStderrTail(rawText);
        if (activePromptCollector) {
          activePromptCollector.onActivity();
        }
      });

      agentProcess.on('error', (_error: Error) => {
        resetAcpRuntime();
      });

      agentProcess.on('close', (_code: number, _signal: string) => {
        resetAcpRuntime();
      });

      const input = Writable.toWeb(agentProcess.stdin) as unknown as WritableStream<Uint8Array>;
      const output = Readable.toWeb(agentProcess.stdout) as unknown as ReadableStream<Uint8Array>;
      const stream = acp.ndJsonStream(input, output);

      acpConnection = new acp.ClientSideConnection(() => acpClient, stream);

      try {
        await acpConnection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        });

        const session = await acpConnection.newSession({
          cwd: process.cwd(),
          mcpServers,
        });

        acpSessionId = session.sessionId;
      } catch (error: any) {
        resetAcpRuntime();
        throw new Error(getErrorMessage(error));
      }
    })();

    try {
      await acpInitPromise;
    } finally {
      acpInitPromise = null;
    }
  };

  const scheduleAcpPrewarm = (_reason: string) => {
    if (hasHealthyAcpRuntime() || acpInitPromise) {
      return;
    }

    if (acpPrewarmRetryTimer) {
      return;
    }

    ensureAcpSession()
      .then(() => {
        acpPrewarmRetryAttempts = 0;
      })
      .catch((_error: unknown) => {
        acpPrewarmRetryAttempts += 1;
        if (acpPrewarmMaxRetries > 0 && acpPrewarmRetryAttempts >= acpPrewarmMaxRetries) {
          return;
        }

        if (acpPrewarmRetryMs > 0) {
          acpPrewarmRetryTimer = setTimeout(() => {
            acpPrewarmRetryTimer = null;
            scheduleAcpPrewarm('retry');
          }, acpPrewarmRetryMs);
        }
      });
  };

  const runAcpPrompt = async (promptText: string, onChunk?: (chunk: string) => void) => {
    await ensureAcpSession();
    const promptForGemini = await buildPromptWithMemory(promptText);

    return new Promise<string>((resolve, reject) => {
      let fullResponse = '';
      let isSettled = false;
      let noOutputTimeout: NodeJS.Timeout | null = null;


      const clearTimers = () => {
        clearTimeout(overallTimeout);
        if (noOutputTimeout) {
          clearTimeout(noOutputTimeout);
        }
      };

      const failOnce = (error: Error) => {
        if (isSettled) {
          return;
        }
        isSettled = true;
        manualAbortRequested = false;
        clearTimers();
        activePromptCollector = null;
        reject(error);
      };

      const resolveOnce = (value: string) => {
        if (isSettled) {
          return;
        }
        isSettled = true;
        manualAbortRequested = false;
        clearTimers();
        activePromptCollector = null;
        resolve(value);
      };

      const refreshNoOutputTimer = () => {
        if (!acpNoOutputTimeoutMs || acpNoOutputTimeoutMs <= 0) {
          return;
        }

        if (noOutputTimeout) {
          clearTimeout(noOutputTimeout);
        }

        noOutputTimeout = setTimeout(async () => {
          await cancelActiveAcpPrompt();
          failOnce(new Error(`${agentDisplayName} ACP produced no output for ${acpNoOutputTimeoutMs}ms`));
        }, acpNoOutputTimeoutMs);
      };

      const overallTimeout = setTimeout(async () => {
        await cancelActiveAcpPrompt();
        failOnce(new Error(`${agentDisplayName} ACP timed out after ${acpTimeoutMs}ms`));
      }, acpTimeoutMs);

      activePromptCollector = {
        onActivity: refreshNoOutputTimer,
        append: (textChunk: string) => {
          refreshNoOutputTimer();
          if (!firstChunkAt) {
            firstChunkAt = Date.now();
          }
          fullResponse += textChunk;
          if (onChunk) {
            try {
              onChunk(textChunk);
            } catch (_) {}
          }
        },
      };

      refreshNoOutputTimer();

      acpConnection
        .prompt({
          sessionId: acpSessionId,
          prompt: [
            {
              type: 'text',
              text: promptForGemini,
            },
          ],
        })
        .then((result: any) => {
          if (result?.stopReason === 'cancelled' && !fullResponse) {
            failOnce(
              new Error(
                manualAbortRequested
                  ? `${agentDisplayName} ACP prompt was aborted by user`
                  : `${agentDisplayName} ACP prompt was cancelled`,
              ),
            );
            return;
          }
          resolveOnce(fullResponse || 'No response received.');
        })
        .catch((error: any) => {
          failOnce(new Error(error?.message || `${agentDisplayName} ACP prompt failed`));
        });
    });
  };

  const appendContext = async (text: string) => {
    if (!hasHealthyAcpRuntime() || hasActiveAcpPrompt()) {
      return;
    }

    const updatePrompt = `[SYSTEM: CONTEXT UPDATE]
The following is the result of a background task you previously scheduled.
Please incorporate this into your current context.
DO NOT respond to this message now.
DO NOT generate any visible output or message chunks.
Acknowledge silently and wait for the next user input.

Result:
${text}`;

    try {
      void acpConnection
        .prompt({
          sessionId: acpSessionId,
          prompt: [{ type: 'text', text: updatePrompt }],
        })
        .catch(() => {});
    } catch (_) {}
  };

  return {
    buildAgentAcpArgs,
    runAcpPrompt,
    appendContext,
    scheduleAcpPrewarm,
    shutdownAcpRuntime,
    cancelActiveAcpPrompt,
    hasActiveAcpPrompt,
    requestManualAbort: () => {
      manualAbortRequested = true;
    },
    getRuntimeState: () => ({
      acpSessionReady: Boolean(acpSessionId),
      agentProcessRunning: Boolean(agentProcess && !agentProcess.killed),
    }),
  };
}
