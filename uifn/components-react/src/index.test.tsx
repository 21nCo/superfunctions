import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button, ButtonRoot, componentsReactPackageBoundary } from './index';

describe('@uifn/components-react', () => {
  it('TV-COMP-001-P wraps public headless parts without owning behavior', () => {
    const html = renderToStaticMarkup(React.createElement(ButtonRoot, { className: 'consumer', children: 'Save' }));
    expect(html).toContain('data-uifn-component="button"');
    expect(html).toContain('data-uifn-part="root"');
    expect(html).toContain('class="uifn-button uifn-button__root consumer"');
    expect(Button.Root).toBe(ButtonRoot);
    expect(componentsReactPackageBoundary).toMatchObject({
      componentCount: 69,
      partCount: 465,
      behaviorOwner: '@uifn/core',
      headlessOwner: '@uifn/react',
      stylingOwner: '@uifn/components',
      styling: 'styled-open-compounds',
    });
  });
});
