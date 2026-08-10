import { describe, expect, it } from 'vitest';
import {
  STYLED_COMPONENT_CATALOG,
  STYLED_COMPONENT_COUNT,
  STYLED_PART_COUNT,
  UIFnStyledContractError,
  componentsPackage,
  createStyledPartRecipe,
} from '../index';

describe('@uifn/components neutral boundary', () => {
  it('identifies the framework-neutral stable package', () => {
    expect(componentsPackage).toEqual({
      name: '@uifn/components',
      layer: 'components-neutral',
      status: 'ga-candidate',
      styling: 'public-visual-defaults',
      behaviorOwner: '@uifn/core',
      sourcePolicy: 'clean-room',
    });
  });

  it('TV-COMP-001-P exposes exactly 69 open compounds and every canonical anatomy part', () => {
    expect(STYLED_COMPONENT_COUNT).toBe(69);
    expect(STYLED_PART_COUNT).toBe(465);
    expect(new Set(STYLED_COMPONENT_CATALOG.map((entry) => entry.id)).size).toBe(69);
    expect(createStyledPartRecipe('accordion', 'trigger', { state: 'open', className: 'consumer' })).toEqual({
      className: 'uifn-accordion uifn-accordion__trigger consumer',
      vars: {},
      data: { 'uifn-component': 'accordion', 'uifn-part': 'trigger', state: 'open' },
      selector: '[data-uifn-component="accordion"][data-uifn-part="trigger"]',
    });
  });

  it('TV-COMP-001-N rejects unknown private parts', () => {
    expect(() => createStyledPartRecipe('accordion', 'private-runtime-part')).toThrowError(UIFnStyledContractError);
  });
});
