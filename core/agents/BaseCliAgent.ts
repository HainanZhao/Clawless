/**
 * Base interface for CLI-based agent implementations.
 * This abstraction allows Clawless to support multiple agent backends
 * (e.g., Gemini CLI, OpenCode, etc.) through a common interface.
 */

export interface CliAgentConfig {
  command: string;
  approvalMode?: string;
  model?: string;
  includeDirectories?: string[];
  killGraceMs?: number;
}

export interface CliAgentCapabilities {
  supportsAcp: boolean;
  supportsApprovalMode: boolean;
  supportsModelSelection: boolean;
  supportsIncludeDirectories: boolean;
}

export abstract class BaseCliAgent {
  protected config: CliAgentConfig;

  constructor(config: CliAgentConfig) {
    this.config = config;
  }

  /**
   * Get the CLI command name (e.g., 'gemini', 'opencode')
   */
  abstract getCommand(): string;

  /**
   * Build command-line arguments for ACP mode
   */
  abstract buildAcpArgs(): string[];

  /**
   * Get agent capabilities
   */
  abstract getCapabilities(): CliAgentCapabilities;

  /**
   * Get the display name of the agent
   */
  abstract getDisplayName(): string;

  /**
   * Validate that the agent CLI is available and working
   */
  abstract validate(): { valid: boolean; error?: string };

  /**
   * Get the grace period for process termination
   */
  getKillGraceMs(): number {
    return this.config.killGraceMs ?? 5000;
  }
}
