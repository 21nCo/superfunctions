import { describe, expect, it } from 'vitest';
import * as utils from './index';

describe('utils public barrel', () => {
  it('exports the shared utility factories', () => {
    expect(typeof utils.generateId).toBe('function');
    expect(typeof utils.createIdFactory).toBe('function');
    expect(typeof utils.createFocusTrap).toBe('function');
    expect(typeof utils.getNextRovingFocusIndex).toBe('function');
    expect(typeof utils.createOutsideClickListener).toBe('function');
    expect(typeof utils.createEscapeKeyListener).toBe('function');
    expect(typeof utils.resolvePresenceState).toBe('function');
    expect(typeof utils.resolvePortalTarget).toBe('function');
    expect(typeof utils.computePosition).toBe('function');
  });
});
