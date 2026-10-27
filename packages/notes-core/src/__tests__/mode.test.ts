import { describe, it, expect } from 'vitest';
import { deriveMode } from '../mode.js';

describe('mode', () => {
  describe('deriveMode', () => {
    it('returns all mode when no filters are active', () => {
      const result = deriveMode('', []);
      expect(result).toBe('all');
    });

    it('returns tag mode when tags are selected but no search', () => {
      const result = deriveMode('', ['#tag1']);
      expect(result).toBe('tag');
    });

    it('returns tag mode with multiple tags', () => {
      const result = deriveMode('', ['#tag1', '#tag2']);
      expect(result).toBe('tag');
    });

    it('returns search mode when search query is present', () => {
      const result = deriveMode('query', []);
      expect(result).toBe('search');
    });

    it('search mode takes precedence over tag mode', () => {
      const result = deriveMode('query', ['#tag1']);
      expect(result).toBe('search');
    });

    it('ignores whitespace-only search query', () => {
      const result = deriveMode('   ', ['#tag1']);
      expect(result).toBe('tag');
    });

    it('ignores whitespace-only search query for all mode', () => {
      const result = deriveMode('   ', []);
      expect(result).toBe('all');
    });

    it('returns all mode when selectedDate is null', () => {
      const result = deriveMode('', [], null);
      expect(result).toBe('all');
    });

    it('returns tag mode when selectedDate is set', () => {
      const result = deriveMode('', [], '2026-01-05');
      expect(result).toBe('tag');
    });

    it('search mode takes precedence over selectedDate', () => {
      const result = deriveMode('query', [], '2026-01-05');
      expect(result).toBe('search');
    });
  });
});
