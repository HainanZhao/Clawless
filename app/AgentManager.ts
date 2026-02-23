import os from 'node:os';
import { buildPermissionResponse, noOpAcpFileOperation } from '../acp/clientHelpers.js';
import { type AcpRuntime, createAcpRuntime } from '../acp/runtimeManager.js';
import {
  type AgentType,
  type BaseCliAgent,
  createCliAgent,
  SUPPORTED_AGENTS,
  validateAgentType,
} from '../core/agents/index.js';
import type { Config } from '../utils/config.js';
import { getErrorMessage, logError, logInfo } from '../utils/error.js';
import { AgentValidationError } from '../utils/errors.js';
import { ensureMemoryFile } from '../utils/memory.js';

export interface AgentManagerOptions {
  config: Config;
  buildPromptWithMemory: (userPrompt: string) => Promise<string>;
}

export class AgentManager {
  private cliAgent: BaseCliAgent | null = null;
  private acpRuntime: AcpRuntime | null = null;
  private config: Config;
  private agentInitialized = false;
  private options: AgentManagerOptions;

  constructor(options: AgentManagerOptions) {
    this.config = options.config;
    this.options = options;
  }

  private initializeAgent(): void {
    if (this.agentInitialized) {
      return;
    }

    const agentCommand = this.getAgentCommand(this.config.CLI_AGENT);

    let cliAgentType: AgentType;
    try {
      cliAgentType = validateAgentType(this.config.CLI_AGENT);
    } catch (error: any) {
      logError(`Error: ${error.message}`);
      logError(`Available agents: ${SUPPORTED_AGENTS.join(', ')}`);
      process.exit(1);
    }

    this.cliAgent = createCliAgent(cliAgentType, {
      command: agentCommand,
      approvalMode: this.config.CLI_AGENT_APPROVAL_MODE,
      model: this.config.CLI_AGENT_MODEL,
      includeDirectories: [this.config.CLAWLESS_HOME, os.homedir()],
      killGraceMs: this.config.CLI_AGENT_KILL_GRACE_MS,
      acpMcpServersJson: this.config.ACP_MCP_SERVERS_JSON,
    });

    const GEMINI_STDERR_TAIL_MAX = 4000;

    this.acpRuntime = createAcpRuntime({
      cliAgent: this.cliAgent,
      acpPermissionStrategy: this.config.ACP_PERMISSION_STRATEGY,
      acpStreamStdout: this.config.ACP_STREAM_STDOUT,
      acpDebugStream: this.config.ACP_DEBUG_STREAM,
      acpTimeoutMs: this.config.CLI_AGENT_TIMEOUT_MS,
      acpNoOutputTimeoutMs: this.config.CLI_AGENT_NO_OUTPUT_TIMEOUT_MS,
      acpPrewarmRetryMs: this.config.ACP_PREWARM_RETRY_MS,
      acpPrewarmMaxRetries: this.config.ACP_PREWARM_MAX_RETRIES,
      acpMcpServersJson: this.config.ACP_MCP_SERVERS_JSON,
      stderrTailMaxChars: GEMINI_STDERR_TAIL_MAX,
      buildPromptWithMemory: this.options.buildPromptWithMemory,
      ensureMemoryFile: () => ensureMemoryFile(this.config.MEMORY_FILE_PATH, logInfo),
      buildPermissionResponse,
      noOpAcpFileOperation,
      getErrorMessage,
      logInfo,
      logError,
    });

    this.agentInitialized = true;
  }

  private getAgentCommand(cliAgent: string): string {
    switch (cliAgent) {
      case 'opencode':
        return 'opencode';
      case 'claude':
        return 'claude-agent-acp';
      default:
        return 'gemini';
    }
  }

  public validateCliAgentOrExit(): void {
    this.initializeAgent();
    if (!this.cliAgent) {
      logError('Error: Agent failed to initialize');
      process.exit(1);
    }
    const validation = this.cliAgent.validate();
    if (!validation.valid) {
      logError(`Error: ${validation.error || 'Agent validation failed'}`);
      process.exit(1);
    }
  }

  public getCliAgent(): BaseCliAgent {
    this.initializeAgent();
    if (!this.cliAgent) {
      throw new AgentValidationError('Agent not initialized');
    }
    return this.cliAgent;
  }

  public getAcpRuntime(): AcpRuntime {
    this.initializeAgent();
    if (!this.acpRuntime) {
      throw new AgentValidationError('ACP runtime not initialized');
    }
    return this.acpRuntime;
  }

  public scheduleAcpPrewarm(reason: string): void {
    this.initializeAgent();
    this.acpRuntime?.scheduleAcpPrewarm(reason);
  }

  public async shutdown(reason: string): Promise<void> {
    if (this.acpRuntime) {
      await this.acpRuntime.shutdownAcpRuntime(reason);
    }
  }

  public requestManualAbort(): void {
    if (this.acpRuntime) {
      this.acpRuntime.requestManualAbort();
    }
  }

  public isInitialized(): boolean {
    return this.agentInitialized;
  }

  public isAcpSessionReady(): boolean {
    if (!this.acpRuntime) {
      return false;
    }
    return this.acpRuntime.getRuntimeState().acpSessionReady;
  }
}
