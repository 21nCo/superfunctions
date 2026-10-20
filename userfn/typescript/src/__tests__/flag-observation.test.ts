import { describe, it, expect, vi } from 'vitest';
import { UserFnClient } from '../index';
import { flagStore } from '../svelte';

const client = () => new UserFnClient({ apiKey: 'unused', bootstrapFlags: { feature: { nested: [1] } } });
const definitions = (value = false) => [{ key: 'feature', enabled: true, defaultValue: value, variations: [{ id: 'on', value: true }], rules: [{ id: 'paid', constraints: [{ id: 'plan', field: 'plan', operator: 'equals' as const, value: 'paid' }], variationId: 'on' }] }];
describe('flag observations', () => {
  it('returns stable deeply immutable snapshots without rendering exposures', () => {
    const c = client(); const capture = vi.fn(); (c as any).exposures = { capture };
    const observation = c.observeFlag('feature'); const snapshot = observation.getSnapshot();
    expect(observation.getSnapshot()).toBe(snapshot); expect(capture).not.toHaveBeenCalled();
    expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen((snapshot.value as any).nested)).toBe(true);
    observation.track(snapshot); observation.track(snapshot); expect(capture).toHaveBeenCalledTimes(1);
    expect(() => c.observeFlag('feature').track(snapshot)).toThrow('different flag observation');
  });
  it('tracks the selected identity and provenance even when client state changes before commit', () => {
    const c = client(); const capture = vi.fn(); (c as any).exposures = { capture };
    c.setFlags(definitions()); c.identify('old', { plan: 'paid' });
    const observation = c.observeFlag('feature'); const old = observation.getSnapshot();
    c.identify('new', { plan: 'free' }); const current = observation.getSnapshot();
    observation.track(old); observation.track(current);
    expect(capture.mock.calls.map(([key, result, user]) => [key, result.value, result.ruleId, user.id])).toEqual([
      ['feature', true, 'paid', 'old'], ['feature', false, null, 'new'],
    ]);
  });
  it('publishes successful definitions, segments and identity only; unsubscribe is idempotent', () => {
    const c = client(); const observation = c.observeFlag('feature'); const listener = vi.fn();
    const unsubscribe = observation.subscribe(listener); const initial = observation.getSnapshot();
    expect(() => c.setFlags([{ key: 'bad' } as any])).toThrow();
    expect(observation.getSnapshot()).toBe(initial); expect(listener).not.toHaveBeenCalled();
    c.setFlags(definitions()); c.setSegments([]); c.identify('id'); c.reset(); expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe(); unsubscribe(); c.setFlags(definitions(true)); expect(listener).toHaveBeenCalledTimes(4);
  });
  it('releases repeated callback registrations independently', () => {
    const c = client(); const listener = vi.fn();
    const first = c.observeFlag('feature').subscribe(listener); const second = c.observeFlag('other').subscribe(listener);
    first(); c.reset(); expect(listener).toHaveBeenCalledTimes(1); second(); c.reset(); expect(listener).toHaveBeenCalledTimes(1);
  });
  it('does not deliver a queued notification after synchronous unsubscribe', () => {
    const c = client(); const observation = c.observeFlag('feature'); const later = vi.fn();
    let stop = () => {}; observation.subscribe(() => stop()); stop = observation.subscribe(later);
    c.reset(); expect(later).not.toHaveBeenCalled();
  });
  it('does not let a throwing subscriber hide committed state from other observers', () => {
    const c = client(); const a = c.observeFlag('feature'); const b = c.observeFlag('feature');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {}); const listener = vi.fn();
    a.subscribe(() => { throw new Error('private subscriber error'); }); b.subscribe(listener);
    c.setFlags(definitions(true)); expect(listener).toHaveBeenCalledTimes(1); expect(b.getSnapshot().value).toBe(true);
    expect(error).toHaveBeenCalledWith('UserFn flag subscriber failed'); error.mockRestore();
  });
  it('implements Svelte immediate subscription, shared snapshots and release without SSR exposures', () => {
    const c = client(); const capture = vi.fn(); (c as any).exposures = { capture };
    const store = flagStore(c, 'feature'); const values: unknown[] = []; const stop = store.subscribe(value => values.push(value));
    expect(values).toEqual([{ nested: [1] }]); c.setFlags(definitions()); expect(values).toEqual([{ nested: [1] }, false]);
    stop(); c.setFlags(definitions(true)); expect(values).toHaveLength(2); expect(capture).not.toHaveBeenCalled();
  });
  it('releases a Svelte subscription when its initial delivery fails', () => {
    const c = client(); const run = vi.fn(() => { throw new Error('failed'); });
    expect(() => flagStore(c, 'feature').subscribe(run)).toThrow('failed'); c.setFlags(definitions()); expect(run).toHaveBeenCalledTimes(1);
  });
});
