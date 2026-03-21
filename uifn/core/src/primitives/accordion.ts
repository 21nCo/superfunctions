import { createUIFnError, type UIFnError } from '../errors';
import { getNextRovingFocusIndex } from '../utils/roving-focus';
import { type ChangeMeta, createStore, uniqueStrings } from './shared';

export type AccordionType = 'single' | 'multiple';

export interface AccordionProps {
  type?: AccordionType;
  value?: string | string[];
  defaultValue?: string | string[];
  collapsible?: boolean;
  disabled?: boolean;
  orientation?: 'horizontal' | 'vertical';
  items?: string[];
  onValueChange?: (value: string | string[]) => void;
}

export interface AccordionState {
  value: string | string[];
  type: AccordionType;
  collapsible: boolean;
  disabled: boolean;
  orientation: 'horizontal' | 'vertical';
  items: string[];
  focusedItem: string | null;
  lastChangeMeta?: ChangeMeta<string | string[]>;
  lastError: UIFnError | null;
}

export interface AccordionActions {
  setValue: (value: string | string[]) => void;
  toggleItem: (itemValue: string) => void;
  registerItem: (itemValue: string) => void;
  unregisterItem: (itemValue: string) => void;
  focusItem: (itemValue: string) => void;
  handleKeyDown: (key: string, currentItem: string) => string | null;
  syncValue: (value: string | string[]) => void;
}

export interface AccordionMachine {
  readonly state: AccordionState;
  readonly actions: AccordionActions;
  getState: () => AccordionState;
  subscribe: (
    callback: (state: AccordionState, meta?: ChangeMeta<string | string[]>) => void
  ) => () => void;
}

function normalizeAccordionValue(value: string | string[] | undefined, type: AccordionType): string | string[] {
  if (type === 'single') {
    if (Array.isArray(value)) {
      return value[0] ?? '';
    }

    return value ?? '';
  }

  if (Array.isArray(value)) {
    return uniqueStrings(value);
  }

  return value ? [value] : [];
}

function validateAccordionValue(
  value: string | string[],
  items: string[],
  type: AccordionType
): void {
  if (items.length === 0) {
    return;
  }

  const invalidValues =
    type === 'single'
      ? typeof value === 'string' && value !== '' && !items.includes(value)
        ? [value]
        : []
      : (value as string[]).filter((entry) => !items.includes(entry));

  if (invalidValues.length > 0) {
    throw createUIFnError({
      code: 'UIFN_ERR_INVALID_VALUE',
      package: '@uifn/core',
      component: 'Accordion',
      message: 'Invalid external values MUST be handled deterministically.',
      details: {
        invalidValues,
        items,
      },
    });
  }
}

export function createAccordion(props: AccordionProps): AccordionMachine {
  const type = props.type ?? 'single';
  const collapsible = props.collapsible ?? false;
  const disabled = props.disabled ?? false;
  const orientation = props.orientation ?? 'vertical';
  const items = uniqueStrings(props.items ?? []);
  const initialValue = normalizeAccordionValue(
    props.value ?? props.defaultValue,
    type
  );

  validateAccordionValue(initialValue, items, type);

  const store = createStore<AccordionState, string | string[]>({
    value: initialValue,
    type,
    collapsible,
    disabled,
    orientation,
    items,
    focusedItem: items[0] ?? null,
    lastError: null,
  });

  const emitValue = (
    nextValue: string | string[],
    meta: ChangeMeta<string | string[]>
  ) => {
    validateAccordionValue(nextValue, store.getState().items, type);
    store.patchState(
      {
        value: nextValue,
        lastChangeMeta: meta,
        lastError: null,
      },
      meta
    );
    props.onValueChange?.(nextValue);
  };

  const actions: AccordionActions = {
    setValue(nextValue) {
      const state = store.getState();
      const normalized = normalizeAccordionValue(nextValue, type);
      emitValue(normalized, {
        source: 'programmatic',
        reason: 'set-value',
        previousValue: state.value,
        nextValue: normalized,
      });
    },
    toggleItem(itemValue) {
      const state = store.getState();
      if (state.disabled) {
        store.patchState({
          lastError: createUIFnError({
            code: 'UIFN_ERR_DISABLED_INTERACTION',
            package: '@uifn/core',
            component: 'Accordion',
            message: 'Disabled controls MUST ignore state-changing input.',
            recoverable: true,
          }),
        });
        return;
      }

      if (type === 'single') {
        const currentValue = state.value as string;
        const nextValue =
          currentValue === itemValue
            ? collapsible
              ? ''
              : currentValue
            : itemValue;

        emitValue(nextValue, {
          source: 'user',
          reason: 'toggle-item',
          previousValue: currentValue,
          nextValue,
          inputModality: 'pointer',
        });
        return;
      }

      const currentValues = state.value as string[];
      const nextValue = currentValues.includes(itemValue)
        ? currentValues.filter((value) => value !== itemValue)
        : [...currentValues, itemValue];

      emitValue(nextValue, {
        source: 'user',
        reason: 'toggle-item',
        previousValue: currentValues,
        nextValue,
        inputModality: 'pointer',
      });
    },
    registerItem(itemValue) {
      const state = store.getState();
      if (state.items.includes(itemValue)) {
        return;
      }

      const nextItems = [...state.items, itemValue];
      validateAccordionValue(state.value, nextItems, type);
      store.patchState({
        items: nextItems,
        focusedItem: state.focusedItem ?? itemValue,
        lastError: null,
      });
    },
    unregisterItem(itemValue) {
      const state = store.getState();
      const nextItems = state.items.filter((value) => value !== itemValue);
      const nextFocusedItem =
        state.focusedItem === itemValue ? nextItems[0] ?? null : state.focusedItem;

      let nextValue = state.value;
      if (type === 'single') {
        if (state.value === itemValue) {
          nextValue = '';
        }
      } else {
        nextValue = (state.value as string[]).filter((value) => value !== itemValue);
      }

      store.patchState({
        items: nextItems,
        focusedItem: nextFocusedItem,
        value: nextValue,
      });
    },
    focusItem(itemValue) {
      const state = store.getState();
      if (!state.items.includes(itemValue)) {
        return;
      }

      store.patchState({
        focusedItem: itemValue,
      });
    },
    handleKeyDown(key, currentItem) {
      const state = store.getState();
      if (state.items.length === 0) {
        return null;
      }

      const currentIndex = Math.max(0, state.items.indexOf(currentItem));
      const nextIndex = getNextRovingFocusIndex({
        key,
        itemCount: state.items.length,
        currentIndex,
        orientation: orientation,
      });

      if (nextIndex < 0) {
        return null;
      }

      const nextItem = state.items[nextIndex] ?? null;
      if (!nextItem) {
        return null;
      }

      store.patchState({
        focusedItem: nextItem,
        lastChangeMeta: {
          source: 'user',
          reason: 'keyboard-navigation',
          previousValue: state.value,
          nextValue: state.value,
          inputModality: 'keyboard',
        },
      });
      return nextItem;
    },
    syncValue(value) {
      const state = store.getState();
      const normalized = normalizeAccordionValue(value, type);
      emitValue(normalized, {
        source: 'controlled-sync',
        reason: 'sync-value',
        previousValue: state.value,
        nextValue: normalized,
      });
    },
  };

  return {
    get state() {
      return store.getState();
    },
    actions,
    getState: store.getState,
    subscribe: store.subscribe,
  };
}
