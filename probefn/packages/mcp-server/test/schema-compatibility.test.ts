import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseToolArgs } from '../src/server.js';
import { strictObjectSchema } from '../src/schema.js';

describe('tool schema compatibility', () => {
  const schema = strictObjectSchema({ name: z.string(), count: z.number().int().positive().default(1) });
  it('retains output defaults and strict object validation', () => {
    expect(parseToolArgs(schema, { name: 'test' })).toEqual({ name: 'test', count: 1 });
    expect(() => parseToolArgs(schema, { name: 'test', extra: true })).toThrow();
    expect(() => parseToolArgs(schema, { name: 'test', count: 1.5 })).toThrow();
  });
  it('distinguishes missing from null and never exports invalid raw inputs', () => {
    expect(() => parseToolArgs(schema, {})).toThrow('Missing required field name.');
    for (const input of [{ name: null }, { name: { secret: 'private-token-123' } }]) {
      try {
        parseToolArgs(schema, input);
        throw new Error('Expected rejection');
      } catch (error) {
        expect(error).toMatchObject({ code: 'E_MCP_INVALID_ARGS', retryable: false });
        expect(String(error)).not.toContain('Missing required');
        expect(JSON.stringify(error)).not.toContain('private-token-123');
        expect(JSON.stringify(error)).not.toContain('"input"');
      }
    }
  });
});
