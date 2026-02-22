import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type { BaseCliAgent } from '../core/agents/index.js';

export type JobProgressStatus = 'running' | 'completed' | 'failed';

export interface JobProgressEvent {
  scheduleId: string;
  status: JobProgressStatus;
  elapsedMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  lastActivityAgoMs: number;
  message: string;
}

export interface TempAcpRunnerOptions {
  scheduleId: string;
  promptForAgent: string;
  cliAgent: BaseCliAgent;
  cwd: string;
  timeoutMs: number;
  noOutputTimeoutMs?: number;
  progressIntervalMs?: number;
  permissionStrategy?: string;
  stderrTailMaxChars?: number;
  logInfo: (message: string, details?: unknown) => void;
  logError: (message: string, details?: unknown) => void;
  onProgress?: (event: JobProgressEvent) => void;
  acpMcpServersJson?: string;
  acpDebugStream?: boolean;
}

/**
 * Terminates a child process gracefully with SIGTERM, then escalates to SIGKILL if needed.
 */
function terminateProcessGracefully(
  childProcess: ChildProcessWithoutNullStreams,
  agentDisplayName: string,
  killGraceMs: number,
  logInfo: (message: string, details?: unknown) => void,
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
      logInfo(`${agentDisplayName} process termination finalized`, {
        reason,
        pid: childProcess.pid,
        ...details,
      });
      resolve();
    };

    childProcess.once('exit', () => finalize('exit'));

    logInfo(`Sending SIGTERM to ${agentDisplayName} process`, {
      pid: childProcess.pid,
      graceMs: killGraceMs,
      ...details,
    });
    childProcess.kill('SIGTERM');

    setTimeout(
      () => {
        if (settled || childProcess.killed || childProcess.exitCode !== null) {
          finalize('already-exited');
          return;
        }

        logInfo(`Escalating ${agentDisplayName} process termination to SIGKILL`, {
          pid: childProcess.pid,
          ...details,
        });

        childProcess.kill('SIGKILL');
        finalize('sigkill');
      },
      Math.max(0, killGraceMs),
    );
  });
}

/**
 * Executes a single prompt using the CLI's standard prompt mode (-p).
 * This is simpler than ACP and suitable for one-shot background tasks.
 */
export async function runPromptWithCli(options: TempAcpRunnerOptions): Promise<string> {
  const {
    scheduleId,
    promptForAgent,
    cliAgent,
    cwd,
    timeoutMs,
    noOutputTimeoutMs,
    progressIntervalMs = 60_000,
    logInfo,
    logError,
    onProgress,
  } = options;

  const command = cliAgent.getCommand();
  const args = cliAgent.buildPromptArgs(promptForAgent);
  const agentDisplayName = cliAgent.getDisplayName();
  const commandToken = command.split(/[\\/]/).pop() || command;
  const stderrPrefixToken = commandToken.toLowerCase().replace(/\s+/g, '-');
  const killGraceMs = cliAgent.getKillGraceMs();

  const tempProcess = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd,
  });

  logInfo(`Scheduler temp ${agentDisplayName} process started (prompt mode)`, {
    scheduleId,
    pid: tempProcess.pid,
    command,
    args: args.slice(0, -1).concat('[PROMPT]'), // Hide prompt in logs
  });

  return new Promise<string>((resolve, reject) => {
    let stdoutData = '';
    let stderrData = '';
    let settled = false;
    const startTime = Date.now();
    let lastActivityTime = Date.now();
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let noOutputTimedOut = false;

    const emitProgress = (status: JobProgressStatus, message: string) => {
      if (!onProgress) return;
      const now = Date.now();
      onProgress({
        scheduleId,
        status,
        elapsedMs: now - startTime,
        stdoutBytes,
        stderrBytes,
        lastActivityAgoMs: now - lastActivityTime,
        message,
      });
    };

    const markActivity = () => {
      lastActivityTime = Date.now();
    };

    // Periodic progress reporting + no-output kill
    const progressInterval = setInterval(async () => {
      if (settled) return;
      const now = Date.now();
      const idleMs = now - lastActivityTime;

      if (noOutputTimeoutMs && idleMs >= noOutputTimeoutMs && !noOutputTimedOut) {
        noOutputTimedOut = true;
        settled = true;
        cleanup();
        clearTimeout(overallTimeout);

        const msg = `no output for ${Math.round(idleMs / 1000)}s (limit: ${Math.round(noOutputTimeoutMs / 1000)}s)`;
        logInfo(`Scheduler temp ${agentDisplayName} killed: ${msg}`, { scheduleId, stdoutBytes });
        emitProgress('failed', `❌ ${agentDisplayName} killed — ${msg}`);

        await terminateProcessGracefully(
          tempProcess as unknown as ChildProcessWithoutNullStreams,
          agentDisplayName,
          killGraceMs,
          logInfo,
          { scheduleId },
        );

        reject(new Error(`Scheduler ${agentDisplayName} killed: ${msg}`));
        return;
      }

      emitProgress(
        'running',
        `⏳ ${agentDisplayName} working… (${Math.round((now - startTime) / 1000)}s elapsed, ${stdoutBytes} bytes received)`,
      );
    }, progressIntervalMs);

    const cleanup = () => {
      clearInterval(progressInterval);
    };

    const overallTimeout = setTimeout(async () => {
      if (settled) return;
      settled = true;
      cleanup();
      logInfo(`Scheduler temp ${agentDisplayName} prompt timed out`, { scheduleId, timeoutMs });

      emitProgress('failed', `❌ ${agentDisplayName} timed out after ${Math.round(timeoutMs / 1000)}s`);

      await terminateProcessGracefully(
        tempProcess as unknown as ChildProcessWithoutNullStreams,
        agentDisplayName,
        killGraceMs,
        logInfo,
        { scheduleId },
      );

      reject(new Error(`Scheduler ${agentDisplayName} prompt timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    tempProcess.stdout.on('data', (chunk: Buffer) => {
      stdoutData += chunk.toString();
      stdoutBytes += chunk.length;
      markActivity();
    });

    tempProcess.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrData += text;
      stderrBytes += chunk.length;
      markActivity();
      if (text.trim()) {
        logError(`[${stderrPrefixToken}:scheduler:${scheduleId}] ${text.trim()}`);
      }
    });

    tempProcess.on('error', (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      clearTimeout(overallTimeout);
      logInfo(`Scheduler temp ${agentDisplayName} process error`, { scheduleId, error: error.message });
      emitProgress('failed', `❌ ${agentDisplayName} process error: ${error.message}`);
      reject(error);
    });

    tempProcess.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      clearTimeout(overallTimeout);

      logInfo(`Scheduler temp ${agentDisplayName} process exited`, { scheduleId, code, signal });

      if (code === 0) {
        emitProgress('completed', `✅ ${agentDisplayName} completed (${Math.round((Date.now() - startTime) / 1000)}s)`);
        resolve(stdoutData.trim() || 'No response received.');
      } else {
        const errorMsg = `Agent exited with code ${code}${signal ? ` (signal ${signal})` : ''}. ${stderrData.slice(-500)}`;
        emitProgress('failed', `❌ ${agentDisplayName} exited with code ${code}`);
        reject(new Error(errorMsg));
      }
    });
  });
}
