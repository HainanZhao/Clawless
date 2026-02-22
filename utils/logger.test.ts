import { describe, it, expect, vi } from 'vitest';
import { logInfo, logError, logWarn, logDebug } from './error.js';
import logger from './logger.js';

vi.mock('./logger.js', () => {
  const mock = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
  return {
    default: mock,
    logger: mock,
  };
});

describe('logger utils', () => {
  it('logInfo calls logger.info', () => {
    logInfo('test message');
    expect(logger.info).toHaveBeenCalledWith('test message');
  });

  it('logInfo with details calls logger.info with details', () => {
    const details = { foo: 'bar' };
    logInfo('test message', details);
    expect(logger.info).toHaveBeenCalledWith({ details }, 'test message');
  });

  it('logInfo with Error calls logger.info with error as first arg', () => {
    const err = new Error('boom');
    logInfo('test message', err);
    expect(logger.info).toHaveBeenCalledWith(err, 'test message');
  });

  it('logError with Error calls logger.error with error as first arg', () => {
    const err = new Error('boom');
    logError('error message', err);
    expect(logger.error).toHaveBeenCalledWith(err, 'error message');
  });

  it('logWarn calls logger.warn', () => {
    logWarn('warn message');
    expect(logger.warn).toHaveBeenCalledWith('warn message');
  });

  it('logDebug calls logger.debug', () => {
    logDebug('debug message');
    expect(logger.debug).toHaveBeenCalledWith('debug message');
  });
});
