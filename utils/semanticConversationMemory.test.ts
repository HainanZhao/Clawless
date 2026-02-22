import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSearchTerms } from './semanticConversationMemory.js';
import { logWarn } from './error.js';

vi.mock('./error.js', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    logWarn: vi.fn(),
  };
});

describe('buildSearchTerms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('filters out short tokens and duplicates', () => {
    const input = ['foo', 'ba', 'a', 'foo', 'BAR'];
    const result = buildSearchTerms(input);
    expect(result).toEqual(['foo', 'ba', 'bar']);
  });

  it('truncates at 24 and logs a warning', () => {
    const input = Array.from({ length: 30 }, (_, i) => `word${i}`);
    const result = buildSearchTerms(input);

    expect(result).toHaveLength(24);
    expect(logWarn).toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining('truncated'),
      expect.objectContaining({
        originalCount: 30,
        limit: 24,
      }),
    );
  });

  it('does not log warning if under limit', () => {
    const input = ['one', 'two', 'three'];
    const result = buildSearchTerms(input);

    expect(result).toHaveLength(3);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it('handles non-string values gracefully', () => {
    const input = ['valid', null, undefined, 123];
    const result = buildSearchTerms(input as any);
    expect(result).toEqual(['valid']);
  });
});
