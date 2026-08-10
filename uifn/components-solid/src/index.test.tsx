import { describe, expect, it } from 'vitest';
import { Button, ButtonRoot, componentsSolidPackageBoundary } from './index';

describe('@uifn/components-solid', () => {
  it('TV-COMP-001-P exposes the generated one-to-one wrapper compound', () => {
    expect(typeof ButtonRoot).toBe('function');
    expect(Button.Root).toBe(ButtonRoot);
    expect(componentsSolidPackageBoundary).toMatchObject({
      componentCount: 69,
      partCount: 465,
      behaviorOwner: '@uifn/core',
      headlessOwner: '@uifn/solid',
      stylingOwner: '@uifn/components',
      styling: 'styled-open-compounds',
    });
  });
});
