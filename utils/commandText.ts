export function normalizeCommandText(text: unknown) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[!?.]+$/g, '');
}

export function isAbortCommand(text: unknown) {
  const normalized = normalizeCommandText(text);
  if (!normalized) {
    return false;
  }

  const commands = new Set(['abort', 'cancel', 'stop', '/abort', '/cancel', '/stop']);
  if (commands.has(normalized)) {
    return true;
  }

  const compact = normalized.replace(/\s+/g, ' ');
  return compact === 'please abort' || compact === 'please cancel' || compact === 'please stop';
}

export function isAbortAllCommand(text: unknown) {
  const normalized = normalizeCommandText(text);
  if (!normalized) {
    return false;
  }

  const commands = new Set([
    'abort all',
    'cancel all',
    'stop all',
    '/abortall',
    '/cancelall',
    '/stopall',
    'abort all jobs',
    'abort async',
    '/abort async',
  ]);
  if (commands.has(normalized)) {
    return true;
  }

  const compact = normalized.replace(/\s+/g, ' ');
  return compact.includes('abort all') || compact.includes('cancel all') || compact.includes('stop all');
}

export function isShutdownCommand(text: unknown) {
  const normalized = normalizeCommandText(text);
  if (!normalized) {
    return false;
  }

  const commands = new Set(['shutdown', '/shutdown', 'shutdown agent', 'kill agent', 'please shutdown', 'shutdown the agent']);
  return commands.has(normalized);
}

export function isNukeCommand(text: unknown) {
  const normalized = normalizeCommandText(text);
  if (!normalized) {
    return false;
  }

  const commands = new Set(['nuke', '/nuke', 'nuke all', 'kill all', 'shutdown all', '/killall', 'nuke everything', 'shutdown everything']);
  return commands.has(normalized);
}

export function normalizeOutgoingText(text: unknown) {
  const rawText = String(text || '').trim();
  return stripThinkingProcess(rawText);
}

/**
 * Strips internal AI thinking process markers from the output text.
 * This is useful for cleaning up responses from models that include
 * reasoning steps or internal progress logs in their output.
 */
export function stripThinkingProcess(text: string): string {
  if (!text) return '';

  let result = text;

  // Remove <thought>...</thought> blocks (common in many reasoning models)
  result = result.replace(/<thought>[\s\S]*?<\/thought>/gi, '');

  // Remove Thinking... markers often found at the beginning of output (flexible dot count)
  result = result.replace(/^Thinking\.+\s*$/gm, '');

  // Remove (Thinking: ...) and [Thinking: ...] blocks
  result = result.replace(/\(Thinking: [\s\S]*?\)/gi, '');
  result = result.replace(/\[Thinking: [\s\S]*?\]/gi, '');

  return result.trim();
}

/**
 * Generates a random short identifier using base36.
 * Provides 8 characters of entropy, suitable for job references and correlation IDs.
 *
 * @returns A random 8-character string (e.g., "5g7h2k9z")
 */
export function generateShortId() {
  return Math.random().toString(36).substring(2, 10);
}
