import { describe, expect, it } from 'vitest';
import { UserFnClient } from '../index';

describe('public client flag configuration', () => {
  it('uses supplied values immediately, including falsy and structured values', () => {
    const bootstrapFlags = JSON.parse('{"off":false,"zero":0,"empty":"","layout":{"color":"blue"},"items":[1,2],"__proto__":"literal"}');
    const client = new UserFnClient({ apiKey: 'unused', bootstrapFlags });
    for (const [key, value] of Object.entries(bootstrapFlags)) {
      expect(client.getFlag(key, 'fallback')).toEqual(value);
    }
    expect(client.getFlag('unknown', 'fallback')).toBe('fallback');
    expect(client.getFlag('toString', 'fallback')).toBe('fallback');
    client.identify('new-user');
    client.reset();
    expect(client.getFlag('off', true)).toBe(false);
    expect(new UserFnClient({ apiKey: 'unused' }).getFlag('off', true)).toBe(true);
  });

  it('replaces bootstrap with rules and evaluates configured segments through the public client', () => {
    const client = new UserFnClient({ apiKey: 'unused', bootstrapFlags: { stale: true, feature: 'bootstrap' } });
    client.setSegments([{ id: 'paid', name: 'Paid', rules: [{ id: 'plan', field: 'plan', operator: 'equals', value: 'pro' }] }]);
    client.setFlags([{ key: 'feature', enabled: true, defaultValue: 'control',
      variations: [{ id: 'on', value: 'treatment' }],
      rules: [{ id: 'paid-rule', segmentId: 'paid', variationId: 'on' }] }]);
    expect(client.getFlag('stale', false)).toBe(false);
    expect(client.getFlag('feature')).toBe('control');
    client.identify('paid-user', { plan: 'pro' });
    expect(client.getFlag('feature')).toBe('treatment');
    client.reset();
    expect(client.getFlag('feature')).toBe('control');
    client.setFlags([]);
    expect(client.getFlag('feature', 'removed')).toBe('removed');
  });
});
