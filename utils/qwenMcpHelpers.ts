/**
 * Helper functions to read MCP server configuration from Qwen CLI settings.
 * Qwen CLI stores settings in ~/.qwen/settings.json (similar to Gemini CLI).
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logError } from './error.js';

const QWEN_SETTINGS_PATH = join(homedir(), '.qwen', 'settings.json');

export interface QwenMcpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: string;
  headers?: Array<{ name: string; value: string }>;
}

interface QwenSettings {
  mcpServers?: Record<string, QwenMcpServer>;
  [key: string]: unknown;
}

/**
 * Read MCP server names from Qwen CLI settings file.
 * This allows ACP mode to use the same MCP servers configured in normal Qwen CLI.
 */
export function getQwenMcpServerNames(): string[] {
  try {
    if (!existsSync(QWEN_SETTINGS_PATH)) {
      return [];
    }

    const content = readFileSync(QWEN_SETTINGS_PATH, 'utf-8');
    const settings: QwenSettings = JSON.parse(content);

    if (settings.mcpServers && typeof settings.mcpServers === 'object') {
      const names = Object.keys(settings.mcpServers);
      return names;
    }

    return [];
  } catch (error) {
    logError('Failed to read Qwen MCP server names:', error);
    return [];
  }
}

/**
 * Read full MCP server configuration from Qwen CLI settings file.
 * Returns array format compatible with ACP mcpServers parameter.
 */
export function getQwenMcpServersForAcp(): unknown[] {
  try {
    if (!existsSync(QWEN_SETTINGS_PATH)) {
      return [];
    }

    const content = readFileSync(QWEN_SETTINGS_PATH, 'utf-8');
    const settings: QwenSettings = JSON.parse(content);

    if (!settings.mcpServers || typeof settings.mcpServers !== 'object') {
      return [];
    }

    // Convert to ACP-compatible format
    return Object.entries(settings.mcpServers)
      .map(([name, config]) => {
        const server = config as QwenMcpServer;

        if (server.command) {
          // STDIO type server
          return {
            name,
            command: server.command,
            args: server.args || [],
            env: server.env ? Object.entries(server.env).map(([key, value]) => ({ name: key, value })) : [],
          };
        }

        if (server.url) {
          // HTTP/SSE type server
          return {
            name,
            type: server.type || 'sse',
            url: server.url,
            headers: server.headers || [],
          };
        }

        return null;
      })
      .filter(Boolean);
  } catch (error) {
    logError('Failed to read Qwen MCP servers for ACP:', error);
    return [];
  }
}
