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

export enum AcpState {
  IDLE = 'IDLE',
  STARTING = 'STARTING',
  READY = 'READY',
  PROMPTING = 'PROMPTING',
  ERROR = 'ERROR',
  SHUTTING_DOWN = 'SHUTTING_DOWN',
}

export type CreateAcpRuntimeParams = {
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
    state: AcpState;
  };
  appendContext: (text: string) => Promise<void>;
};

class AcpRuntimeManager implements AcpRuntime {
  private state: AcpState = AcpState.IDLE;
  private agentProcess: any = null;
  private acpConnection: any = null;
  private acpSessionId: any = null;
  private sessionReadyPromise: Promise<void> | null = null;
  private activePromptCollector: any = null;
  private manualAbortRequested = false;
  private acpPrewarmRetryTimer: NodeJS.Timeout | null = null;
  private acpPrewarmRetryAttempts = 0;
  private agentStderrTail = '';

  private readonly agentCommand: string;
  private readonly agentDisplayName: string;
  private readonly commandToken: string;
  private readonly stderrPrefixToken: string;
  private readonly killGraceMs: number;

  constructor(private params: CreateAcpRuntimeParams) {
    this.agentCommand = params.cliAgent.getCommand();
    this.agentDisplayName = params.cliAgent.getDisplayName();
    this.commandToken = this.agentCommand.split(/[\\/]/).pop() || this.agentCommand;
    this.stderrPrefixToken = this.commandToken.toLowerCase().replace(/\s+/g, '-');
    this.killGraceMs = params.cliAgent.getKillGraceMs();
  }

  private appendAgentStderrTail(text: string) {
    this.agentStderrTail = `${this.agentStderrTail}${text}`;
    if (this.agentStderrTail.length > this.params.stderrTailMaxChars) {
      this.agentStderrTail = this.agentStderrTail.slice(-this.params.stderrTailMaxChars);
    }
  }

  private async terminateProcessGracefully(
    childProcess: ChildProcessWithoutNullStreams,
    processLabel: string,
    details?: Record<string, unknown>,
  ) {
    return new Promise<void>((resolve) => {
      if (!childProcess || childProcess.killed || childProcess.exitCode !== null) {
        resolve();
        return;
      }

      let settled = false;

      const finalize = (reason: string) => {
        if (settled) {
          return;
        }
        settled = true;
        this.params.logInfo(`${this.agentDisplayName} process termination finalized`, {
          processLabel,
          reason,
          pid: childProcess.pid,
          ...details,
        });
        resolve();
      };

      childProcess.once('exit', () => finalize('exit'));

      this.params.logInfo(`Sending SIGTERM to ${this.agentDisplayName} process`, {
        processLabel,
        pid: childProcess.pid,
        graceMs: this.killGraceMs,
        ...details,
      });
      childProcess.kill('SIGTERM');

      setTimeout(
        () => {
          if (settled || childProcess.killed || childProcess.exitCode !== null) {
            finalize('already-exited');
            return;
          }

          this.params.logInfo(`Escalating ${this.agentDisplayName} process termination to SIGKILL`, {
            processLabel,
            pid: childProcess.pid,
            ...details,
          });

          childProcess.kill('SIGKILL');
          finalize('sigkill');
        },
        Math.max(0, this.killGraceMs),
      );
    });
  }

  private setState(newState: AcpState) {
    if (this.state === newState) {
      return;
    }
    this.params.logInfo('AcpRuntime state transition', {
      from: this.state,
      to: newState,
      sessionId: this.acpSessionId,
    });
    this.state = newState;
  }

  private hasHealthyAcpRuntime(): boolean {
    return (
      (this.state === AcpState.READY || this.state === AcpState.PROMPTING) &&
      Boolean(this.acpConnection && this.acpSessionId && this.agentProcess && !this.agentProcess.killed)
    );
  }

  public hasActiveAcpPrompt(): boolean {
    return this.state === AcpState.PROMPTING && Boolean(this.activePromptCollector);
  }

  public async cancelActiveAcpPrompt() {
    try {
      if (this.acpConnection && this.acpSessionId) {
        await this.acpConnection.cancel({ sessionId: this.acpSessionId });
      }
    } catch (_) {}
  }

  public async shutdownAcpRuntime(reason: string) {
    this.setState(AcpState.SHUTTING_DOWN);
    const processToStop = this.agentProcess;
    const runtimeSessionId = this.acpSessionId;

    this.activePromptCollector = null;
    this.acpConnection = null;
    this.acpSessionId = null;
    this.sessionReadyPromise = null;
    this.agentProcess = null;
    this.agentStderrTail = '';

    if (processToStop && !processToStop.killed && processToStop.exitCode === null) {
      await this.terminateProcessGracefully(processToStop, 'main-acp-runtime', {
        reason,
        sessionId: runtimeSessionId,
      });
    }
    this.setState(AcpState.IDLE);
  }

  public buildAgentAcpArgs(): string[] {
    return this.params.cliAgent.buildAcpArgs();
  }

  private get acpClient() {
    const self = this;
    return {
      async requestPermission(params: any) {
        return self.params.buildPermissionResponse(params?.options, self.params.acpPermissionStrategy);
      },

      async sessionUpdate(params: any) {
        if (!self.activePromptCollector || params.sessionId !== self.acpSessionId) {
          return;
        }

        self.activePromptCollector.onActivity();

        const updateType = params.update?.sessionUpdate;
        const contentType = params.update?.content?.type;

        if (updateType === 'agent_thought_chunk') {
          if (self.params.acpDebugStream) {
            const thoughtText = params.update?.content?.text || '';
            self.params.logInfo('ACP thought chunk', {
              sessionId: self.acpSessionId,
              thoughtLength: thoughtText.length,
              thoughtPreview: thoughtText.slice(0, 100),
            });
          }
          return;
        }

        if (updateType === 'agent_message_chunk' && contentType === 'text') {
          const chunkText = params.update.content.text;
          if (chunkText) {
            self.activePromptCollector.append(chunkText);
            if (self.params.acpStreamStdout) {
              process.stdout.write(chunkText);
            }
          }
        }
      },

      async readTextFile(params: any) {
        return self.params.noOpAcpFileOperation(params);
      },

      async writeTextFile(params: any) {
        return self.params.noOpAcpFileOperation(params);
      },
    };
  }

  private resetAcpRuntime() {
    this.params.logInfo('Resetting ACP runtime state');
    void this.shutdownAcpRuntime('runtime-reset');
    this.scheduleAcpPrewarm('runtime reset');
  }

  private async initializeSession(): Promise<void> {
    const args = this.buildAgentAcpArgs();

    let mcpServers: unknown[] = [];
    let mcpServersSource = 'agent-config';

    const agentWithMcp = this.params.cliAgent as CliAgentWithMcp;
    if (typeof agentWithMcp.getMcpServersForAcp === 'function') {
      mcpServers = agentWithMcp.getMcpServersForAcp();
      this.params.logInfo(`Using MCP servers from agent configuration`, {
        count: mcpServers.length,
      });
    }

    if (mcpServers.length === 0) {
      const envResult = getMcpServersForSession({
        acpMcpServersJson: this.params.acpMcpServersJson,
        logInfo: this.params.logInfo,
        getErrorMessage: this.params.getErrorMessage,
        invalidEnvMessage: 'Invalid ACP_MCP_SERVERS_JSON; using empty mcpServers array',
      });
      mcpServers = envResult.mcpServers;
      mcpServersSource = envResult.source;
    }

    const mcpServerNames = mcpServers
      .map((server) => {
        if (server && typeof server === 'object' && 'name' in server) {
          return String((server as { name?: unknown }).name ?? '');
        }

        return '';
      })
      .filter((name) => name.length > 0);

    this.params.logInfo(`Starting ${this.agentDisplayName} ACP process`, {
      command: this.agentCommand,
      args,
    });
    this.agentStderrTail = '';
    this.agentProcess = spawn(this.agentCommand, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.cwd(),
    });

    this.agentProcess.stderr.on('data', (chunk: Buffer) => {
      const rawText = chunk.toString();
      this.appendAgentStderrTail(rawText);
      const text = rawText.trim();
      if (text) {
        this.params.logError(`[${this.stderrPrefixToken}] ${text}`);
      }
      if (this.activePromptCollector) {
        this.activePromptCollector.onActivity();
      }
    });

    this.agentProcess.on('error', (error: Error) => {
      this.params.logError(`${this.agentDisplayName} ACP process error:`, error.message);
      this.setState(AcpState.ERROR);
      this.resetAcpRuntime();
    });

    this.agentProcess.on('close', (code: number, signal: string) => {
      this.params.logError(`${this.agentDisplayName} ACP process closed (code=${code}, signal=${signal})`);
      this.setState(AcpState.IDLE);
      this.resetAcpRuntime();
    });

    const input = Writable.toWeb(this.agentProcess.stdin) as unknown as WritableStream<Uint8Array>;
    const output = Readable.toWeb(this.agentProcess.stdout) as unknown as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    this.acpConnection = new acp.ClientSideConnection(() => this.acpClient, stream);

    try {
      await this.acpConnection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      this.params.logInfo('ACP connection initialized');

      const session = await this.acpConnection.newSession({
        cwd: process.cwd(),
        mcpServers,
      });

      this.acpSessionId = session.sessionId;
      this.setState(AcpState.READY);
      this.params.logInfo('ACP session ready', {
        sessionId: this.acpSessionId,
        mcpServersMode: mcpServersSource,
        mcpServersCount: mcpServers.length,
        mcpServerNames,
      });
    } catch (error: any) {
      this.setState(AcpState.ERROR);
      const baseMessage = this.params.getErrorMessage(error);
      const isInternalError = baseMessage.includes('Internal error');
      const hint = isInternalError
        ? `${this.agentDisplayName} ACP newSession returned Internal error. This is often caused by a local MCP server or skill initialization issue. Try launching the CLI directly and checking MCP/skills diagnostics.`
        : '';

      this.params.logInfo('ACP initialization failed', {
        error: baseMessage,
        stderrTail: this.agentStderrTail || '(empty)',
      });

      this.resetAcpRuntime();
      throw new Error(hint ? `${baseMessage}. ${hint}` : baseMessage);
    }
  }

  private async ensureAcpSession() {
    this.params.ensureMemoryFile();

    if (this.hasHealthyAcpRuntime()) {
      return;
    }

    if (this.sessionReadyPromise) {
      await this.sessionReadyPromise;
      return;
    }

    if (this.state !== AcpState.IDLE && this.state !== AcpState.ERROR) {
      this.params.logError(`Cannot ensure session in state ${this.state}`);
      return;
    }

    this.setState(AcpState.STARTING);
    this.sessionReadyPromise = this.initializeSession();

    try {
      await this.sessionReadyPromise;
    } finally {
      this.sessionReadyPromise = null;
    }
  }

  public scheduleAcpPrewarm(reason: string) {
    if (this.hasHealthyAcpRuntime() || this.sessionReadyPromise) {
      return;
    }

    if (this.acpPrewarmRetryTimer) {
      return;
    }

    this.params.logInfo('Triggering ACP prewarm', { reason });

    this.ensureAcpSession()
      .then(() => {
        this.acpPrewarmRetryAttempts = 0;
        this.params.logInfo(`${this.agentDisplayName} ACP prewarm complete`);
      })
      .catch((error: unknown) => {
        this.params.logInfo(`${this.agentDisplayName} ACP prewarm failed`, {
          error: this.params.getErrorMessage(error),
        });

        this.acpPrewarmRetryAttempts += 1;
        if (this.params.acpPrewarmMaxRetries > 0 && this.acpPrewarmRetryAttempts >= this.params.acpPrewarmMaxRetries) {
          this.params.logInfo(`${this.agentDisplayName} ACP prewarm retries exhausted; stopping automatic retries`, {
            attempts: this.acpPrewarmRetryAttempts,
            maxRetries: this.params.acpPrewarmMaxRetries,
          });
          return;
        }

        if (this.params.acpPrewarmRetryMs > 0) {
          this.acpPrewarmRetryTimer = setTimeout(() => {
            this.acpPrewarmRetryTimer = null;
            this.scheduleAcpPrewarm('retry');
          }, this.params.acpPrewarmRetryMs);
        }
      });
  }

  public async runAcpPrompt(promptText: string, onChunk?: (chunk: string) => void): Promise<string> {
    if (this.state === AcpState.PROMPTING) {
      throw new Error('Cannot start a new prompt while another is already in progress.');
    }

    if (this.state === AcpState.SHUTTING_DOWN) {
      throw new Error('Cannot start a new prompt while shutting down.');
    }

    if (!this.hasHealthyAcpRuntime()) {
      await this.ensureAcpSession();
    }

    this.setState(AcpState.PROMPTING);

    const promptInvocationId = `acp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.params.logInfo('Starting ACP prompt', {
      invocationId: promptInvocationId,
      sessionId: this.acpSessionId,
      promptLength: promptText.length,
    });
    const promptForGemini = await this.params.buildPromptWithMemory(promptText);

    return new Promise<string>((resolve, reject) => {
      let fullResponse = '';
      let isSettled = false;
      let noOutputTimeout: NodeJS.Timeout | null = null;
      const startedAt = Date.now();
      let chunkCount = 0;
      let firstChunkAt: number | null = null;

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
        this.manualAbortRequested = false;
        clearTimers();
        this.activePromptCollector = null;
        this.setState(AcpState.READY);
        this.params.logInfo('ACP prompt failed', {
          invocationId: promptInvocationId,
          sessionId: this.acpSessionId,
          chunkCount,
          firstChunkDelayMs: firstChunkAt ? firstChunkAt - startedAt : null,
          elapsedMs: Date.now() - startedAt,
          error: this.params.getErrorMessage(error),
        });
        reject(error);
      };

      const resolveOnce = (value: string) => {
        if (isSettled) {
          return;
        }
        isSettled = true;
        this.manualAbortRequested = false;
        clearTimers();
        this.activePromptCollector = null;
        this.setState(AcpState.READY);
        this.params.logInfo('ACP prompt completed', {
          invocationId: promptInvocationId,
          sessionId: this.acpSessionId,
          chunkCount,
          firstChunkDelayMs: firstChunkAt ? firstChunkAt - startedAt : null,
          elapsedMs: Date.now() - startedAt,
          responseLength: value.length,
        });
        resolve(value);
      };

      const refreshNoOutputTimer = () => {
        if (!this.params.acpNoOutputTimeoutMs || this.params.acpNoOutputTimeoutMs <= 0) {
          return;
        }

        if (noOutputTimeout) {
          clearTimeout(noOutputTimeout);
        }

        noOutputTimeout = setTimeout(async () => {
          await this.cancelActiveAcpPrompt();
          failOnce(new Error(`${this.agentDisplayName} ACP produced no output for ${this.params.acpNoOutputTimeoutMs}ms`));
        }, this.params.acpNoOutputTimeoutMs);
      };

      const overallTimeout = setTimeout(async () => {
        await this.cancelActiveAcpPrompt();
        failOnce(new Error(`${this.agentDisplayName} ACP timed out after ${this.params.acpTimeoutMs}ms`));
      }, this.params.acpTimeoutMs);

      this.activePromptCollector = {
        onActivity: refreshNoOutputTimer,
        append: (textChunk: string) => {
          refreshNoOutputTimer();
          chunkCount += 1;
          if (!firstChunkAt) {
            firstChunkAt = Date.now();
          }
          if (this.params.acpDebugStream) {
            this.params.logInfo('ACP chunk received', {
              invocationId: promptInvocationId,
              chunkIndex: chunkCount,
              chunkLength: textChunk.length,
              elapsedMs: Date.now() - startedAt,
              bufferLengthBeforeAppend: fullResponse.length,
            });
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

      this.acpConnection
        .prompt({
          sessionId: this.acpSessionId,
          prompt: [
            {
              type: 'text',
              text: promptForGemini,
            },
          ],
        })
        .then((result: any) => {
          if (this.params.acpDebugStream) {
            this.params.logInfo('ACP prompt stop reason', {
              invocationId: promptInvocationId,
              stopReason: result?.stopReason || '(none)',
              chunkCount,
              bufferedLength: fullResponse.length,
              deliveryMode: 'live-preview-then-final',
            });
          }
          if (result?.stopReason === 'cancelled' && !fullResponse) {
            failOnce(
              new Error(
                this.manualAbortRequested
                  ? `${this.agentDisplayName} ACP prompt was aborted by user`
                  : `${this.agentDisplayName} ACP prompt was cancelled`,
              ),
            );
            return;
          }
          resolveOnce(fullResponse || 'No response received.');
        })
        .catch((error: any) => {
          failOnce(new Error(error?.message || `${this.agentDisplayName} ACP prompt failed`));
        });
    });
  }

  public async appendContext(text: string) {
    if (!this.hasHealthyAcpRuntime() || this.hasActiveAcpPrompt()) {
      return;
    }

    this.params.logInfo('Appending context to ACP session', {
      sessionId: this.acpSessionId,
      textLength: text.length,
    });

    const updatePrompt = `[SYSTEM: CONTEXT UPDATE]
The following is the result of a background task you previously scheduled. 
Please incorporate this into your current context. 
DO NOT respond to this message now. 
DO NOT generate any visible output or message chunks.
Acknowledge silently and wait for the next user input.

Result:
${text}`;

    try {
      void this.acpConnection
        .prompt({
          sessionId: this.acpSessionId,
          prompt: [{ type: 'text', text: updatePrompt }],
        })
        .catch((error: any) => {
          this.params.logInfo('Context update fire-and-forget failed', {
            error: this.params.getErrorMessage(error),
          });
        });
    } catch (error: any) {
      this.params.logInfo('Failed to append context to ACP session', {
        error: this.params.getErrorMessage(error),
      });
    }
  }

  public requestManualAbort() {
    this.manualAbortRequested = true;
  }

  public getRuntimeState() {
    return {
      acpSessionReady: Boolean(this.acpSessionId),
      agentProcessRunning: Boolean(this.agentProcess && !this.agentProcess.killed),
      state: this.state,
    };
  }
}

export function createAcpRuntime(params: CreateAcpRuntimeParams): AcpRuntime {
  return new AcpRuntimeManager(params);
}
