import { describe, expect, it } from 'vitest';
import { createProgress } from './progress';

describe('progress primitive', () => {
  it('supports indeterminate mode with null aria values', () => {
    const progress = createProgress({ value: null, max: 100 });
    expect(progress.state.mode).toBe('indeterminate');
    expect(progress.state.ariaValueMin).toBe(0);
    expect(progress.state.ariaValueMax).toBe(100);
    expect(progress.state.ariaValueNow).toBeNull();
  });

  it('clamps determinate values to range', () => {
    const progress = createProgress({ value: 40, max: 100 });
    progress.setValue(135);
    expect(progress.state.value).toBe(100);
    expect(progress.state.mode).toBe('determinate');
  });
});
