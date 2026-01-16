import { describe, it, expect, beforeEach } from 'vitest';
import { IdentityManager } from '../core/identity';

describe('IdentityManager', () => {
  let identity: IdentityManager;

  beforeEach(() => {
    identity = new IdentityManager();
  });

  it('should start with no user', () => {
    expect(identity.getUser()).toBeNull();
  });

  it('should identify a user', () => {
    identity.identify('user-123', { name: 'Alice' });
    const user = identity.getUser();
    expect(user).not.toBeNull();
    expect(user?.id).toBe('user-123');
    expect(user?.traits).toEqual({ name: 'Alice' });
  });

  it('should reset the user', () => {
    identity.identify('user-123');
    identity.reset();
    expect(identity.getUser()).toBeNull();
  });

  it('should get traits safely', () => {
    expect(identity.getTraits()).toEqual({});
    identity.identify('user-123', { plan: 'pro' });
    expect(identity.getTraits()).toEqual({ plan: 'pro' });
  });
});
