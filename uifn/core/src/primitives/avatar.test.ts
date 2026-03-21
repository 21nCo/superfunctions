import { describe, expect, it } from 'vitest';
import { createAvatar } from './avatar';

describe('avatar primitive', () => {
  it('transitions deterministically through loading, loaded, and error states', () => {
    const avatar = createAvatar();
    const states: string[] = [];

    const unsubscribe = avatar.subscribe((next) => {
      states.push(next.status);
    });

    avatar.actions.setLoading();
    avatar.actions.setLoaded();
    avatar.actions.setError();

    unsubscribe();

    expect(states).toEqual(['loading', 'loaded', 'error']);
  });

  it('stops notifying subscribers after unsubscribe', () => {
    const avatar = createAvatar();
    const states: string[] = [];

    const unsubscribe = avatar.subscribe((next) => {
      states.push(next.status);
    });

    avatar.actions.setLoading();
    unsubscribe();
    avatar.actions.setLoaded();

    expect(states).toEqual(['loading']);
  });
});
