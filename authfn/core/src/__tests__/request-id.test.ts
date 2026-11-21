import { describe, expect, it } from 'vitest';
import { resolveRequestId } from '../http/envelopes.js';

const request = (id?: string) => new Request('https://account.example.com/auth/session', {
  headers: id === undefined ? {} : { 'x-request-id': id }
});

describe('request ids (AF-18)', () => {
  it('reuses a caller id that is a short token', () => {
    expect(resolveRequestId(request('req_upstream-01.trace:7'))).toBe('req_upstream-01.trace:7');
  });

  it('replaces a caller id with markup, spaces or excessive length', () => {
    for (const id of ['<script>alert(1)</script>', 'two words', 'x'.repeat(129), '"quoted"']) {
      const resolved = resolveRequestId(request(id));
      expect(resolved).not.toBe(id);
      expect(resolved).toMatch(/^req_[0-9a-f]{16}$/);
    }
  });
});
