import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('@uifn/components-svelte package boundary', () => {
  it('keeps styling in the styled layer and behavior in the headless/core layers', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

    expect(source).toContain("componentCount: 69");
    expect(source).toContain("partCount: 465");
    expect(source).toContain("behaviorOwner: '@uifn/core'");
    expect(source).toContain("headlessOwner: '@uifn/svelte'");
    expect(source).toContain("stylingOwner: '@uifn/components'");
    expect(source).toContain("styling: 'styled-open-compounds'");
  });

  it('generates Svelte parts from the same public recipe contract', () => {
    const source = readFileSync(new URL('../src/generated/button/ButtonRoot.svelte', import.meta.url), 'utf8');
    expect(source).toContain('createStyledPartRecipe');
    expect(source).toContain('variant?: StyledVariant');
    expect(source).toContain('unstyled?: boolean');
    expect(source).toContain('{...recipe.data}');
  });
});
