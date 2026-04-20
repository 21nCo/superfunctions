import type { Locator, Page } from 'playwright';

export interface PageElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageModelElement {
  elementId: string;
  role: string;
  name: string;
  text: string;
  visible: boolean;
  disabled: boolean;
  bounds: PageElementBounds;
  selectorHints: {
    id?: string;
    testId?: string;
    role?: string;
    name?: string;
  };
}

export interface PageModel {
  url: string;
  viewport: {
    width: number;
    height: number;
  };
  elements: PageModelElement[];
}

interface RawPageElement {
  role: string;
  name: string;
  text: string;
  visible: boolean;
  disabled: boolean;
  bounds: PageElementBounds;
  id?: string;
  testId?: string;
}

export async function extractPageModel(page: Page): Promise<PageModel> {
  const rawElements = await page.evaluate(() => {
    const isVisible = (element: Element, rect: DOMRect): boolean => {
      const style = window.getComputedStyle(element);
      return (
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity || '1') > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const inferRole = (element: Element): string => {
      const explicitRole = element.getAttribute('role');
      if (explicitRole) {
        return explicitRole;
      }

      if (element instanceof HTMLButtonElement) {
        return 'button';
      }
      if (element instanceof HTMLAnchorElement && element.href) {
        return 'link';
      }
      if (element instanceof HTMLSelectElement) {
        return 'combobox';
      }
      if (element instanceof HTMLTextAreaElement) {
        return 'textbox';
      }
      if (element instanceof HTMLInputElement) {
        if (element.type === 'checkbox') {
          return 'checkbox';
        }
        if (element.type === 'radio') {
          return 'radio';
        }
        if (element.type === 'button' || element.type === 'submit') {
          return 'button';
        }
        return 'textbox';
      }

      return 'generic';
    };

    const inferName = (element: Element): string => {
      const ariaLabel = element.getAttribute('aria-label');
      if (ariaLabel?.trim()) {
        return ariaLabel.trim();
      }

      if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
        const labels = Array.from(element.labels ?? [])
          .map((label) => label.textContent?.trim() ?? '')
          .filter(Boolean);
        if (labels.length > 0) {
          return labels.join(' ');
        }
      }

      const text = (element.textContent ?? '').trim();
      if (text.length > 0) {
        return text.replace(/\s+/g, ' ');
      }

      const title = element.getAttribute('title');
      return title?.trim() ?? '';
    };

    return Array.from(document.querySelectorAll('*'))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const role = inferRole(element);
        const name = inferName(element);
        const text = (element.textContent ?? '').trim().replace(/\s+/g, ' ');
        const visible = isVisible(element, rect);
        const disabled =
          'disabled' in element &&
          Boolean((element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled);

        return {
          role,
          name,
          text,
          visible,
          disabled,
          bounds: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
          id: element.getAttribute('id') ?? undefined,
          testId:
            element.getAttribute('data-testid') ??
            element.getAttribute('data-test-id') ??
            undefined,
        };
      })
      .filter((element) => element.visible || element.name || element.text || element.role !== 'generic');
  });

  const elements = assignElementIds(rawElements as RawPageElement[]);
  const viewport = page.viewportSize() ?? { width: 0, height: 0 };
  return {
    url: page.url(),
    viewport,
    elements,
  };
}

export async function snapshotLocatorElement(locator: Locator): Promise<PageModelElement> {
  const rawElement = (await locator.first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const role =
      element.getAttribute('role') ??
      (element instanceof HTMLButtonElement
        ? 'button'
        : element instanceof HTMLAnchorElement && element.href
          ? 'link'
          : element instanceof HTMLSelectElement
            ? 'combobox'
            : element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
              ? 'textbox'
              : 'generic');
    const name =
      element.getAttribute('aria-label') ??
      ((element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement)
        ? Array.from(element.labels ?? [])
            .map((label) => label.textContent?.trim() ?? '')
            .filter(Boolean)
            .join(' ')
        : '') ??
      '';
    const text = (element.textContent ?? '').trim().replace(/\s+/g, ' ');
    return {
      role,
      name: name || text,
      text,
      visible:
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity || '1') > 0 &&
        rect.width > 0 &&
        rect.height > 0,
      disabled:
        'disabled' in element &&
        Boolean((element as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled),
      bounds: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      },
      id: element.getAttribute('id') ?? undefined,
      testId:
        element.getAttribute('data-testid') ??
        element.getAttribute('data-test-id') ??
        undefined,
    };
  })) as RawPageElement;

  const [element] = assignElementIds([rawElement]);
  if (!element) {
    throw new Error('Failed to snapshot locator element.');
  }

  return element;
}

export async function captureLayoutMetadata(page: Page): Promise<Record<string, unknown>> {
  const pageModel = await extractPageModel(page);
  const documentMetrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    clientWidth: document.documentElement.clientWidth,
    clientHeight: document.documentElement.clientHeight,
  }));

  return {
    url: page.url(),
    viewport: pageModel.viewport,
    document: documentMetrics,
    elements: pageModel.elements,
  };
}

export async function captureStylesMetadata(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const isVisible = (element: Element, rect: DOMRect): boolean => {
      const style = window.getComputedStyle(element);
      return (
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity || '1') > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const inferRole = (element: Element): string => {
      const explicitRole = element.getAttribute('role');
      if (explicitRole) {
        return explicitRole;
      }

      if (element instanceof HTMLButtonElement) {
        return 'button';
      }
      if (element instanceof HTMLAnchorElement && element.href) {
        return 'link';
      }
      if (element instanceof HTMLSelectElement) {
        return 'combobox';
      }
      if (element instanceof HTMLTextAreaElement) {
        return 'textbox';
      }
      if (element instanceof HTMLInputElement) {
        if (element.type === 'checkbox') {
          return 'checkbox';
        }
        if (element.type === 'radio') {
          return 'radio';
        }
        if (element.type === 'button' || element.type === 'submit') {
          return 'button';
        }
        return 'textbox';
      }

      return 'generic';
    };

    const inferName = (element: Element): string => {
      const ariaLabel = element.getAttribute('aria-label');
      if (ariaLabel?.trim()) {
        return ariaLabel.trim();
      }

      if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
        const labels = Array.from(element.labels ?? [])
          .map((label) => label.textContent?.trim() ?? '')
          .filter(Boolean);
        if (labels.length > 0) {
          return labels.join(' ');
        }
      }

      const text = (element.textContent ?? '').trim();
      if (text.length > 0) {
        return text.replace(/\s+/g, ' ');
      }

      return element.getAttribute('title')?.trim() ?? '';
    };

    const isFocusable = (element: Element): boolean =>
      element instanceof HTMLElement &&
      (
        element.matches('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')
      );

    const detectFocusIndicator = (element: HTMLElement): boolean => {
      const beforeStyle = window.getComputedStyle(element);
      const beforeOutline = `${beforeStyle.outlineStyle}|${beforeStyle.outlineWidth}|${beforeStyle.outlineColor}|${beforeStyle.boxShadow}|${beforeStyle.borderColor}`;
      element.focus({ preventScroll: true });
      const focusedStyle = window.getComputedStyle(element);
      const afterOutline = `${focusedStyle.outlineStyle}|${focusedStyle.outlineWidth}|${focusedStyle.outlineColor}|${focusedStyle.boxShadow}|${focusedStyle.borderColor}`;
      element.blur();

      const outlineWidth = Number.parseFloat(focusedStyle.outlineWidth || '0');
      const hasOutline = focusedStyle.outlineStyle !== 'none' && outlineWidth > 0;
      const hasShadow = focusedStyle.boxShadow !== 'none';
      const borderChanged = beforeOutline !== afterOutline && focusedStyle.borderColor !== beforeStyle.borderColor;

      return hasOutline || hasShadow || borderChanged;
    };

    const rootStyle = window.getComputedStyle(document.documentElement);
    const bodyStyle = window.getComputedStyle(document.body);
    return {
      root: {
        fontFamily: rootStyle.fontFamily,
        color: rootStyle.color,
        backgroundColor: rootStyle.backgroundColor,
      },
      body: {
        fontFamily: bodyStyle.fontFamily,
        color: bodyStyle.color,
        backgroundColor: bodyStyle.backgroundColor,
      },
      elements: Array.from(document.querySelectorAll('*'))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          const visible = isVisible(element, rect);
          const focusable = isFocusable(element);

          return {
            role: inferRole(element),
            name: inferName(element),
            text: (element.textContent ?? '').trim().replace(/\s+/g, ' '),
            id: element.getAttribute('id') ?? undefined,
            testId:
              element.getAttribute('data-testid') ??
              element.getAttribute('data-test-id') ??
              undefined,
            bounds: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            },
            clientWidth: element instanceof HTMLElement ? element.clientWidth : 0,
            clientHeight: element instanceof HTMLElement ? element.clientHeight : 0,
            scrollWidth: element instanceof HTMLElement ? element.scrollWidth : 0,
            scrollHeight: element instanceof HTMLElement ? element.scrollHeight : 0,
            color: style.color,
            backgroundColor: style.backgroundColor,
            outlineStyle: style.outlineStyle,
            outlineWidth: style.outlineWidth,
            outlineColor: style.outlineColor,
            boxShadow: style.boxShadow,
            borderColor: style.borderColor,
            borderWidth: style.borderWidth,
            fontSize: style.fontSize,
            lineHeight: style.lineHeight,
            whiteSpace: style.whiteSpace,
            overflowX: style.overflowX,
            overflowY: style.overflowY,
            textOverflow: style.textOverflow,
            focusable,
            focusIndicatorVisible: focusable && element instanceof HTMLElement
              ? detectFocusIndicator(element)
              : false,
            visible,
          };
        })
        .filter((element) => element.visible || element.name || element.text || element.role !== 'generic'),
    };
  });
}

function assignElementIds(rawElements: RawPageElement[]): PageModelElement[] {
  const counters = new Map<string, number>();
  return rawElements.map((rawElement) => {
    const baseId = createBaseElementId(rawElement);
    const count = (counters.get(baseId) ?? 0) + 1;
    counters.set(baseId, count);

    return {
      elementId: count === 1 ? baseId : `${baseId}_${count}`,
      role: rawElement.role,
      name: rawElement.name,
      text: rawElement.text,
      visible: rawElement.visible,
      disabled: rawElement.disabled,
      bounds: rawElement.bounds,
      selectorHints: {
        ...(rawElement.id ? { id: rawElement.id } : {}),
        ...(rawElement.testId ? { testId: rawElement.testId } : {}),
        ...(rawElement.role ? { role: rawElement.role } : {}),
        ...(rawElement.name ? { name: rawElement.name } : {}),
      },
    };
  });
}

function createBaseElementId(element: RawPageElement): string {
  const source = element.testId || element.id || element.name || element.text || element.role || 'element';
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'element';
  const roleSlug = (element.role || 'generic')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'generic';
  const baseSlug = slug.endsWith(`_${roleSlug}`) || slug === roleSlug
    ? slug
    : `${slug}_${roleSlug}`;

  return `el_${baseSlug}`;
}
