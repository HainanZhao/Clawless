import fs from 'node:fs';
import path from 'node:path';
import { getErrorMessage } from './error.js';

type LogInfoFn = (message: string, details?: unknown) => void;

export interface ContextQueueEntry {
  id: string;
  timestamp: string;
  source: 'async_job';
  content: string;
}

/**
 * Context queue file stores pending context from async jobs.
 * Loaded on first prompt after restart, then cleared.
 */
const CONTEXT_QUEUE_FILE = 'context-queue.json';

export function getContextQueuePath(clawlessHome: string): string {
  return path.join(clawlessHome, CONTEXT_QUEUE_FILE);
}

export function appendToContextQueue(clawlessHome: string, entry: ContextQueueEntry, logInfo: LogInfoFn): void {
  try {
    const filePath = getContextQueuePath(clawlessHome);
    let queue: ContextQueueEntry[] = [];

    if (fs.existsSync(filePath)) {
      try {
        queue = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        queue = [];
      }
    }

    queue.push(entry);
    fs.writeFileSync(filePath, JSON.stringify(queue, null, 2), 'utf8');
    logInfo('Added to context queue', { entryId: entry.id, queueLength: queue.length });
  } catch (error: any) {
    logInfo('Failed to append to context queue', {
      error: getErrorMessage(error),
    });
  }
}

export function loadAndClearContextQueue(clawlessHome: string, logInfo: LogInfoFn): ContextQueueEntry[] {
  const filePath = getContextQueuePath(clawlessHome);

  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const queue = JSON.parse(fs.readFileSync(filePath, 'utf8')) as ContextQueueEntry[];
    // Clear the queue after loading
    fs.writeFileSync(filePath, JSON.stringify([], null, 2), 'utf8');
    logInfo('Loaded context queue', { count: queue.length });
    return queue;
  } catch (error: any) {
    logInfo('Failed to load context queue', {
      error: getErrorMessage(error),
    });
    return [];
  }
}

/**
 * Format context queue entries for prompt injection
 */
export function formatContextQueueForPrompt(entries: ContextQueueEntry[]): string {
  if (entries.length === 0) {
    return '';
  }

  const formatted = entries
    .map((entry) => {
      if (entry.source === 'async_job') {
        return `[Background Job ${entry.id}] ${entry.content}`;
      }
      return entry.content;
    })
    .join('\n\n');

  return `Pending context from recent background jobs:\n${formatted}`;
}
