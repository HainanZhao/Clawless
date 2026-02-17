import { spawnSync } from 'node:child_process';
import { BaseCliAgent, type CliAgentCapabilities, type CliAgentConfig } from './BaseCliAgent.js';

/**
 * Gemini CLI agent implementation.
 * Supports Google's Gemini CLI with ACP (Agent Communication Protocol).
 */
export class GeminiAgent extends BaseCliAgent {
  constructor(config: CliAgentConfig) {
    super(config);
  }

  getCommand(): string {
    return this.config.command;
  }

  getDisplayName(): string {
    return 'Gemini CLI';
  }

  buildAcpArgs(): string[] {
    const args = ['--experimental-acp'];

    if (this.config.includeDirectories && this.config.includeDirectories.length > 0) {
      const includeDirectorySet = new Set(this.config.includeDirectories);
      for (const includeDirectory of includeDirectorySet) {
        args.push('--include-directories', includeDirectory);
      }
    }

    if (this.config.approvalMode) {
      args.push('--approval-mode', this.config.approvalMode);
    }

    if (this.config.model) {
      args.push('--model', this.config.model);
    }

    return args;
  }

  getCapabilities(): CliAgentCapabilities {
    return {
      supportsAcp: true,
      supportsApprovalMode: true,
      supportsModelSelection: true,
      supportsIncludeDirectories: true,
    };
  }

  validate(): { valid: boolean; error?: string } {
    try {
      const result = spawnSync(this.config.command, ['--version'], {
        stdio: 'ignore',
        timeout: 10000,
        killSignal: 'SIGKILL',
      });

      if ((result as any).error?.code === 'ENOENT') {
        return {
          valid: false,
          error: `Gemini CLI executable not found: ${this.config.command}. Install Gemini CLI or set CLI_AGENT_COMMAND to a valid executable path.`,
        };
      }

      if ((result as any).error) {
        return {
          valid: false,
          error: `Failed to execute Gemini CLI (${this.config.command}): ${(result as any).error.message}`,
        };
      }

      return { valid: true };
    } catch (error: any) {
      return {
        valid: false,
        error: `Failed to validate Gemini CLI: ${error.message}`,
      };
    }
  }
}
