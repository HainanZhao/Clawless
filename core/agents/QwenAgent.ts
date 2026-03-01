import { BaseCliAgent, type CliAgentCapabilities } from './BaseCliAgent.js';
import { getQwenMcpServerNames, getQwenMcpServersForAcp } from '../../utils/qwenMcpHelpers.js';

/**
 * Qwen CLI agent implementation.
 * Supports Qwen CLI with ACP (Agent Communication Protocol).
 * Qwen CLI is branched from Gemini CLI and shares similar command-line interface.
 */
export class QwenAgent extends BaseCliAgent {
  getCommand(): string {
    return this.config.command || 'qwen';
  }

  getDisplayName(): string {
    return 'Qwen CLI';
  }

  /**
   * Override to add --allowed-mcp-server-names based on Qwen settings.
   * This ensures MCP tools are available in ACP mode.
   */
  buildAcpArgs(): string[] {
    const args = super.buildAcpArgs();

    // Get MCP server names from Qwen settings
    const mcpServerNames = getQwenMcpServerNames();
    if (mcpServerNames.length > 0) {
      args.push('--allowed-mcp-server-names', ...mcpServerNames);
    }

    return args;
  }

  /**
   * Provide MCP server configurations from Qwen settings.
   * This passes the actual MCP server configs to the ACP session.
   */
  getMcpServersForAcp(): unknown[] {
    return getQwenMcpServersForAcp();
  }

  getCapabilities(): CliAgentCapabilities {
    return {
      supportsAcp: true,
      supportsApprovalMode: true,
      supportsModelSelection: true,
      supportsIncludeDirectories: true,
    };
  }
}
