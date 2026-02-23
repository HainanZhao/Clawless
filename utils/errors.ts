/**
 * Clawless Error Hierarchy
 * Centralized error handling for the entire application
 */

export class ClawlessError extends Error {
  public code: string;
  public statusCode: number;
  public details?: unknown;

  constructor(message: string, code: string = 'CLAWLESS_ERROR', statusCode: number = 500, details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      statusCode: this.statusCode,
      details: this.details,
      stack: this.stack,
    };
  }
}

// Configuration Errors
export class ConfigError extends ClawlessError {
  constructor(message: string, details?: unknown) {
    super(message, 'CONFIG_ERROR', 500, details);
    this.name = 'ConfigError';
  }
}

export class MissingConfigError extends ConfigError {
  constructor(configKey: string) {
    super(`Missing required configuration: ${configKey}`, { configKey });
    this.code = 'MISSING_CONFIG';
  }
}

export class InvalidConfigError extends ConfigError {
  constructor(configKey: string, reason: string) {
    super(`Invalid configuration for ${configKey}: ${reason}`, { configKey, reason });
    this.code = 'INVALID_CONFIG';
  }
}

// Messaging Errors
export class MessagingError extends ClawlessError {
  constructor(message: string, details?: unknown) {
    super(message, 'MESSAGING_ERROR', 500, details);
    this.name = 'MessagingError';
  }
}

export class PlatformNotSupportedError extends MessagingError {
  constructor(platform: string) {
    super(`Messaging platform '${platform}' is not supported`, { platform });
    this.code = 'UNSUPPORTED_PLATFORM';
    this.statusCode = 400;
  }
}

export class WhitelistError extends MessagingError {
  constructor(platform: string) {
    super(`${platform} whitelist is required but not configured`, { platform });
    this.code = 'MISSING_WHITELIST';
    this.statusCode = 500;
  }
}

// Agent Errors
export class AgentError extends ClawlessError {
  constructor(message: string, details?: unknown) {
    super(message, 'AGENT_ERROR', 500, details);
    this.name = 'AgentError';
  }
}

export class AgentNotFoundError extends AgentError {
  constructor(agentName: string) {
    super(`Agent '${agentName}' not found or not configured`, { agentName });
    this.code = 'AGENT_NOT_FOUND';
    this.statusCode = 500;
  }
}

export class AgentTimeoutError extends AgentError {
  constructor(agentName: string, timeoutMs: number) {
    super(`Agent '${agentName}' timed out after ${timeoutMs}ms`, { agentName, timeoutMs });
    this.code = 'AGENT_TIMEOUT';
    this.statusCode = 504;
  }
}

export class AgentValidationError extends AgentError {
  constructor(message: string) {
    super(message);
    this.code = 'AGENT_VALIDATION_ERROR';
    this.statusCode = 500;
  }
}

// Scheduler Errors
export class SchedulerError extends ClawlessError {
  constructor(message: string, details?: unknown) {
    super(message, 'SCHEDULER_ERROR', 500, details);
    this.name = 'SchedulerError';
  }
}

export class JobNotFoundError extends SchedulerError {
  constructor(jobId: string) {
    super(`Scheduled job '${jobId}' not found`, { jobId });
    this.code = 'JOB_NOT_FOUND';
    this.statusCode = 404;
  }
}

// Callback Server Errors
export class CallbackError extends ClawlessError {
  constructor(message: string, details?: unknown) {
    super(message, 'CALLBACK_ERROR', 500, details);
    this.name = 'CallbackError';
  }
}

export class AuthError extends CallbackError {
  constructor(details?: unknown) {
    super('Authentication failed', details);
    this.code = 'AUTH_FAILED';
    this.statusCode = 401;
  }
}

// Database/Memory Errors
export class StorageError extends ClawlessError {
  constructor(message: string, details?: unknown) {
    super(message, 'STORAGE_ERROR', 500, details);
    this.name = 'StorageError';
  }
}

export class StorageReadError extends StorageError {
  constructor(operation: string, reason: string) {
    super(`Failed to read ${operation}: ${reason}`, { operation, reason });
    this.code = 'STORAGE_READ_ERROR';
  }
}

export class StorageWriteError extends StorageError {
  constructor(operation: string, reason: string) {
    super(`Failed to write ${operation}: ${reason}`, { operation, reason });
    this.code = 'STORAGE_WRITE_ERROR';
  }
}

/**
 * Utility to convert any error to a ClawlessError
 * Preserves existing ClawlessError subclasses, wraps others
 */
export function toClawlessError(
  error: unknown,
  defaultMessage: string = 'An unexpected error occurred',
): ClawlessError {
  if (error instanceof ClawlessError) {
    return error;
  }

  if (error instanceof Error) {
    return new ClawlessError(error.message, 'INTERNAL_ERROR', 500, error.stack);
  }

  if (typeof error === 'string') {
    return new ClawlessError(error, 'STRING_ERROR', 500);
  }

  return new ClawlessError(defaultMessage, 'UNKNOWN_ERROR', 500, error);
}
