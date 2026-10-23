/**
 * Deterministic plugin registry: widget overrides and pane registration.
 * Resolution rule: most specific match wins; ties broken by last registration (last wins).
 */

export interface WidgetSelector {
  /** Document type name (e.g. "post"). */
  typeName?: string;
  /** Field name (e.g. "body"). When with typeName, most specific. */
  fieldName?: string;
  /** Field type kind (e.g. "richtext", "reference"). Least specific. */
  fieldType?: string;
}

export interface WidgetRegistry {
  register(selector: WidgetSelector, widgetId: string): void;
  /** Returns winning widget id for (typeName, fieldName, fieldType), or null. */
  getWidgetId(typeName: string, fieldName: string, fieldType: string): string | null;
}

function specificity(selector: WidgetSelector): number {
  if (selector.typeName != null && selector.fieldName != null) return 3;
  if (selector.typeName != null || selector.fieldName != null) return 2;
  if (selector.fieldType != null) return 1;
  return 0;
}

function matches(selector: WidgetSelector, typeName: string, fieldName: string, fieldType: string): boolean {
  if (selector.typeName != null && selector.typeName !== typeName) return false;
  if (selector.fieldName != null && selector.fieldName !== fieldName) return false;
  if (selector.fieldType != null && selector.fieldType !== fieldType) return false;
  return true;
}

/**
 * Create a widget registry. Last registration wins for a given specificity.
 */
export function createWidgetRegistry(): WidgetRegistry {
  const entries: { selector: WidgetSelector; widgetId: string }[] = [];

  return {
    register(selector: WidgetSelector, widgetId: string): void {
      const s = specificity(selector);
      if (s === 0) return;
      entries.push({ selector: { ...selector }, widgetId });
    },

    getWidgetId(typeName: string, fieldName: string, fieldType: string): string | null {
      const matching = entries.filter((e) => matches(e.selector, typeName, fieldName, fieldType));
      if (matching.length === 0) return null;
      const maxSpec = Math.max(...matching.map((e) => specificity(e.selector)));
      const withMax = matching.filter((e) => specificity(e.selector) === maxSpec);
      return withMax[withMax.length - 1].widgetId;
    },
  };
}

export interface PaneRegistry {
  register(paneId: string): void;
  has(paneId: string): boolean;
  getRegisteredPaneIds(): string[];
}

/**
 * Create a pane registry. Deterministic ordering by registration order.
 */
export function createPaneRegistry(): PaneRegistry {
  const ids: string[] = [];
  const set = new Set<string>();

  return {
    register(paneId: string): void {
      if (!set.has(paneId)) {
        set.add(paneId);
        ids.push(paneId);
      }
    },

    has(paneId: string): boolean {
      return set.has(paneId);
    },

    getRegisteredPaneIds(): string[] {
      return [...ids];
    },
  };
}
