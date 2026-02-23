import { describe, it, expect } from 'vitest';
import {
  ClawlessError,
  ConfigError,
  MissingConfigError,
  MessagingError,
  PlatformNotSupportedError,
  AgentTimeoutError,
  toClawlessError,
} from './errors.js';

describe('ClawlessError', () => {
  it('should create error with default values', () => {
    const error = new ClawlessError('Test error');
    expect(error.message).toBe('Test error');
    expect(error.code).toBe('CLAWLESS_ERROR');
    expect(error.statusCode).toBe(500);
  });

  it('should create error with custom values', () => {
    const error = new ClawlessError('Test error', 'TEST_CODE', 400, { extra: 'data' });
    expect(error.code).toBe('TEST_CODE');
    expect(error.statusCode).toBe(400);
    expect(error.details).toEqual({ extra: 'data' });
  });

  it('should serialize to JSON', () => {
    const error = new ClawlessError('Test error', 'TEST_CODE', 400);
    const json = error.toJSON();
    expect(json.name).toBe('ClawlessError');
    expect(json.code).toBe('TEST_CODE');
    expect(json.statusCode).toBe(400);
  });
});

describe('ConfigError', () => {
  it('should create config error', () => {
    const error = new ConfigError('Invalid config');
    expect(error.code).toBe('CONFIG_ERROR');
    expect(error.name).toBe('ConfigError');
  });
});

describe('MissingConfigError', () => {
  it('should create missing config error with key', () => {
    const error = new MissingConfigError('TELEGRAM_TOKEN');
    expect(error.message).toContain('TELEGRAM_TOKEN');
    expect(error.code).toBe('MISSING_CONFIG');
  });
});

describe('MessagingError', () => {
  it('should create messaging error', () => {
    const error = new MessagingError('Failed to send message');
    expect(error.code).toBe('MESSAGING_ERROR');
  });
});

describe('PlatformNotSupportedError', () => {
  it('should create platform error with status 400', () => {
    const error = new PlatformNotSupportedError('discord');
    expect(error.message).toContain('discord');
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('UNSUPPORTED_PLATFORM');
  });
});

describe('AgentTimeoutError', () => {
  it('should include timeout details', () => {
    const error = new AgentTimeoutError('gemini', 30000);
    expect(error.message).toContain('gemini');
    expect(error.message).toContain('30000');
    expect(error.statusCode).toBe(504);
  });
});

describe('toClawlessError', () => {
  it('should preserve ClawlessError subclasses', () => {
    const original = new AgentTimeoutError('gemini', 5000);
    const converted = toClawlessError(original);
    expect(converted).toBe(original);
    expect(converted.statusCode).toBe(504);
  });

  it('should wrap regular Error', () => {
    const original = new Error('Regular error');
    const converted = toClawlessError(original, 'Custom message');
    expect(converted.message).toBe('Regular error');
    expect(converted.code).toBe('INTERNAL_ERROR');
  });

  it('should wrap string errors', () => {
    const converted = toClawlessError('String error');
    expect(converted.message).toBe('String error');
  });

  it('should handle unknown types', () => {
    const converted = toClawlessError(null, 'Null error');
    expect(converted.message).toBe('Null error');
  });
});
