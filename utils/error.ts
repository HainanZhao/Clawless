import logger from './logger.js';

export function getErrorMessage(error: unknown, fallback = 'Unknown error'): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error === null || error === undefined) {
    return fallback;
  }

  if (typeof error === 'object') {
    try {
      return JSON.stringify(error);
    } catch {
      const obj = error as Record<string, unknown>;
      const constructorName = typeof obj?.constructor?.name === 'string' ? obj.constructor.name : 'object';
      const keys = obj ? Object.keys(obj) : [];
      const detailsParts: string[] = [];
      if (constructorName) {
        detailsParts.push(`type=${constructorName}`);
      }
      if (keys.length > 0) {
        detailsParts.push(`keys=${keys.join(', ')}`);
      }
      const details = detailsParts.length > 0 ? ` (${detailsParts.join(', ')})` : '';
      return `Unserializable error object${details}`;
    }
  }

  return String(error);
}

export function logInfo(message: string, details?: unknown) {
  if (details instanceof Error) {
    logger.info(details, message);
  } else if (details !== undefined) {
    logger.info({ details }, message);
  } else {
    logger.info(message);
  }
}

export function logError(message: string, details?: unknown) {
  if (details instanceof Error) {
    logger.error(details, message);
  } else if (details !== undefined) {
    logger.error({ details }, message);
  } else {
    logger.error(message);
  }
}

export function logDebug(message: string, details?: unknown) {
  if (details instanceof Error) {
    logger.debug(details, message);
  } else if (details !== undefined) {
    logger.debug({ details }, message);
  } else {
    logger.debug(message);
  }
}

export function logWarn(message: string, details?: unknown) {
  if (details instanceof Error) {
    logger.warn(details, message);
  } else if (details !== undefined) {
    logger.warn({ details }, message);
  } else {
    logger.warn(message);
  }
}
