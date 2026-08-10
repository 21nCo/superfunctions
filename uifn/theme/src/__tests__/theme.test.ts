import { describe, expect, it } from 'vitest';
import { validateTokenTheme } from '@uifn/tokens';
import { createBrandTheme } from '../brand';
import { FIRST_PARTY_THEMES, listFirstPartyThemes } from '../provider';
import { UIFnThemeError, mountTheme, themeToCSS, type ThemeStyleSheet } from '../mount';

describe('runtime theme mounting', () => {
  it('exposes required first-party themes', () => {
    expect(listFirstPartyThemes()).toEqual([
      'uifn-light',
      'uifn-dark',
      'uifn-high-contrast-light',
      'uifn-high-contrast-dark',
    ]);
    Object.values(FIRST_PARTY_THEMES).forEach((theme) => {
      expect(validateTokenTheme(theme).ok).toBe(true);
      expect((theme.tokens as Record<string, unknown>).color).toMatchObject({
        danger: expect.any(Object),
        warning: expect.any(Object),
        success: expect.any(Object),
      });
    });
  });

  it('TV-STYLE-003 creates contrast-checked brand themes from OKLCH and hex inputs', () => {
    const theme = createBrandTheme({
      name: 'acme',
      mode: 'light',
      accent: '#2563eb',
      neutral: 'oklch(70% 0.02 245)',
    });

    expect(validateTokenTheme(theme).ok).toBe(true);
    expect((theme.tokens as Record<string, unknown>).color).toMatchObject({
      accent: {
        solid: { $type: 'color' },
        contrast: {
          $extensions: {
            uifn: {
              contrastAgainst: 'color.accent.solid',
            },
          },
        },
      },
      danger: expect.any(Object),
      warning: expect.any(Object),
      success: expect.any(Object),
    });
  });

  it('TV-STYLE-002 mounts scoped CSS variables', () => {
    const css = themeToCSS('uifn-dark', '[data-uifn-theme="uifn-dark"]');

    expect(css).toContain('[data-uifn-theme="uifn-dark"]{');
    expect(css).toContain('--uifn-color-surface-canvas:oklch(');
    expect(css).toContain('--uifn-color-text-primary:oklch(');
    expect(css).toContain('--uifn-radius-md:6px;');
    expect(css).toContain('--uifn-motion-easing-standard:cubic-bezier');
  });

  it('TV-STYLE-002 supports runtime root mounting and cleanup', () => {
    const vars = new Map<string, string>();
    const attrs = new Map<string, string>();
    const mounted = mountTheme('uifn-light', {
      scope: '[data-uifn-theme="uifn-light"]',
      root: {
        style: {
          setProperty: (name, value) => vars.set(name, value),
          removeProperty: (name) => vars.delete(name),
        },
        setAttribute: (name, value) => attrs.set(name, value),
        removeAttribute: (name) => attrs.delete(name),
      },
    });

    expect(vars.get('--uifn-color-surface-canvas')).toMatch(/^oklch/);
    expect(attrs.get('data-uifn-theme')).toBe('uifn-light');
    mounted.unmount();
    expect(vars.size).toBe(0);
    expect(attrs.has('data-uifn-theme')).toBe(false);
  });

  it('TV-STYLE-002 supports shadow-root adopted stylesheet mounting and cleanup', () => {
    const existingSheet: ThemeStyleSheet = {
      cssText: '.consumer{}',
      replaceSync(css) {
        this.cssText = css;
      },
    };
    const shadowRoot = {
      adoptedStyleSheets: [existingSheet],
    };

    const mounted = mountTheme('uifn-high-contrast-dark', {
      scope: ':host',
      shadowRoot,
    });

    expect(shadowRoot.adoptedStyleSheets).toHaveLength(2);
    expect(shadowRoot.adoptedStyleSheets[0]).toBe(existingSheet);
    expect(shadowRoot.adoptedStyleSheets[1]?.cssText).toContain(':host{');
    expect(shadowRoot.adoptedStyleSheets[1]?.cssText).toContain('--uifn-color-accent-contrast:oklch(');

    mounted.unmount();

    expect(shadowRoot.adoptedStyleSheets).toEqual([existingSheet]);
  });

  it('TV-STYLE-002 negative rejects unsafe global selectors', () => {
    expect(() => themeToCSS('uifn-dark', 'html body *')).toThrowError(UIFnThemeError);
  });
});
