import { createUIFnError, type UIFnError } from '../errors';
import { createControllableStateController } from '../state/machine';
import { composePublicId, generateId, registerPublicId } from '../utils/id';
import { getNextRovingFocusIndex } from '../utils/roving-focus';
import { type ChangeMeta, createStore } from './shared';

export interface ComboboxItem {
  value: string;
  label?: string;
  disabled?: boolean;
}

export interface ComboboxVirtualizationOptions {
  enabled: boolean;
  itemHeight: number;
  viewportHeight: number;
  overscan?: number;
}

export interface ComboboxProps {
  value?: string;
  defaultValue?: string;
  inputValue?: string;
  defaultInputValue?: string;
  onValueChange?: (value: string) => void;
  onInputValueChange?: (inputValue: string) => void;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  idBase?: string;
  disabled?: boolean;
  items?: Array<string | ComboboxItem>;
  filter?: (
    items: ComboboxItem[],
    inputValue: string
  ) => Array<string | ComboboxItem>;
  virtualization?: ComboboxVirtualizationOptions;
}

export interface ComboboxIds {
  baseId: string;
  inputId: string;
  contentId: string;
  labelId: string;
  optionIds: Record<string, string>;
}

export interface ComboboxState {
  value: string;
  inputValue: string;
  open: boolean;
  valueControlled: boolean;
  inputValueControlled: boolean;
  openControlled: boolean;
  disabled: boolean;
  ids: ComboboxIds;
  items: ComboboxItem[];
  filteredItems: string[];
  highlightedItem: string | null;
  emptyStateShown: boolean;
  virtualization: {
    enabled: boolean;
    itemHeight: number;
    viewportHeight: number;
    overscan: number;
    scrollOffset: number;
    start: number;
    end: number;
  } | null;
  lastChangeMeta?: ChangeMeta<string>;
  lastError: UIFnError | null;
}

export interface ComboboxActions {
  setValue: (value: string) => void;
  setInputValue: (inputValue: string) => void;
  setOpen: (open: boolean) => void;
  syncValue: (value: string) => void;
  syncInputValue: (value: string) => void;
  syncOpen: (open: boolean) => void;
  setItems: (items: Array<string | ComboboxItem>) => void;
  setHighlightedItem: (itemId: string | null) => void;
  handleKeyDown: (key: string, currentItem?: string | null) => string | null;
  setScrollOffset: (offset: number) => void;
}

export interface ComboboxMachine {
  readonly state: ComboboxState;
  readonly actions: ComboboxActions;
  getState: () => ComboboxState;
  subscribe: (
    callback: (state: ComboboxState, meta?: ChangeMeta<string>) => void
  ) => () => void;
}

function toItem(item: string | ComboboxItem): ComboboxItem {
  if (typeof item === 'string') {
    return {
      value: item,
      label: item,
      disabled: false,
    };
  }

  return {
    ...item,
    label: item.label ?? item.value,
  };
}

function normalizeItems(items: Array<string | ComboboxItem> | undefined): ComboboxItem[] {
  const dedupe = new Map<string, ComboboxItem>();
  (items ?? []).forEach((item) => {
    const normalized = toItem(item);
    dedupe.set(normalized.value, normalized);
  });
  return Array.from(dedupe.values());
}

function normalizeIdSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function createComboboxIds(
  props: ComboboxProps,
  items: ComboboxItem[],
  existingBaseId?: string
): ComboboxIds {
  const buildId = (prefix: string, slot: string) => {
    const id = composePublicId({ prefix, slot });
    return existingBaseId ? id : registerPublicId(id);
  };
  const baseId = existingBaseId
    ? existingBaseId
    : props.idBase
      ? registerPublicId(props.idBase, {
          package: '@uifn/core',
          component: 'Combobox',
        })
      : generateId('combobox');

  return {
    baseId,
    inputId: buildId(baseId, 'input'),
    contentId: buildId(baseId, 'content'),
    labelId: buildId(baseId, 'label'),
    optionIds: Object.fromEntries(
      items.map((item) => [
        item.value,
        buildId(`${baseId}-option`, normalizeIdSegment(item.value)),
      ])
    ),
  };
}

function getEnabledItems(items: ComboboxItem[]): ComboboxItem[] {
  return items.filter((item) => !item.disabled);
}

function applyFilter(
  items: ComboboxItem[],
  inputValue: string,
  filter?: (items: ComboboxItem[], inputValue: string) => Array<string | ComboboxItem>
): string[] {
  if (filter) {
    const filtered = filter(items, inputValue).map((item) =>
      typeof item === 'string' ? item : item.value
    );
    const unique = new Set(filtered);
    return items
      .filter((item) => unique.has(item.value))
      .map((item) => item.value);
  }

  const needle = inputValue.trim().toLowerCase();
  if (!needle) {
    return items.map((item) => item.value);
  }

  return items
    .filter((item) => item.label?.toLowerCase().includes(needle))
    .map((item) => item.value);
}

function resolveVirtualWindow(
  filteredItems: string[],
  virtualization: ComboboxVirtualizationOptions | undefined,
  scrollOffset: number
): ComboboxState['virtualization'] {
  if (!virtualization?.enabled) {
    return null;
  }

  const overscan = virtualization.overscan ?? 2;
  const visibleCount = Math.max(1, Math.ceil(virtualization.viewportHeight / virtualization.itemHeight));
  const start = Math.max(0, Math.floor(scrollOffset / virtualization.itemHeight) - overscan);
  const end = Math.max(
    start,
    Math.min(filteredItems.length - 1, start + visibleCount + overscan * 2 - 1)
  );

  return {
    enabled: true,
    itemHeight: virtualization.itemHeight,
    viewportHeight: virtualization.viewportHeight,
    overscan,
    scrollOffset,
    start,
    end,
  };
}

function assertKnownValue(value: string, items: ComboboxItem[]): void {
  if (!value) {
    return;
  }

  if (!items.some((item) => item.value === value)) {
    throw createUIFnError({
      code: 'UIFN_ERR_INVALID_VALUE',
      package: '@uifn/core',
      component: 'Combobox',
      message: 'Combobox controlled value MUST be part of registered items.',
      details: {
        value,
        items: items.map((item) => item.value),
      },
    });
  }
}

export function createCombobox(props: ComboboxProps): ComboboxMachine {
  const items = normalizeItems(props.items);
  const initialValue = props.value ?? props.defaultValue ?? '';
  const valueController = createControllableStateController<string>({
    value: props.value,
    defaultValue: props.defaultValue ?? '',
    onChange: props.onValueChange,
  });
  const inputValueController = createControllableStateController<string>({
    value: props.inputValue,
    defaultValue: props.defaultInputValue ?? '',
    onChange: props.onInputValueChange,
  });
  const openController = createControllableStateController<boolean>({
    value: props.open,
    defaultValue: props.defaultOpen ?? false,
    onChange: props.onOpenChange,
  });
  assertKnownValue(initialValue, items);

  const initialInputValue = props.inputValue ?? props.defaultInputValue ?? '';
  const filtered = applyFilter(items, initialInputValue, props.filter);
  const highlighted = filtered.find((value) => !items.find((item) => item.value === value)?.disabled) ?? null;
  const ids = createComboboxIds(props, items);

  const store = createStore<ComboboxState, string>({
    value: valueController.getValue(),
    inputValue: inputValueController.getValue(),
    open: openController.getValue(),
    valueControlled: valueController.isControlled(),
    inputValueControlled: inputValueController.isControlled(),
    openControlled: openController.isControlled(),
    disabled: props.disabled ?? false,
    ids,
    items,
    filteredItems: filtered,
    highlightedItem: highlighted,
    emptyStateShown: filtered.length === 0,
    virtualization: resolveVirtualWindow(filtered, props.virtualization, 0),
    lastError: null,
  });

  const recomputeFilterState = (
    inputValue: string,
    source: ChangeMeta<string>['source'],
    reason: string
  ) => {
    const state = store.getState();
    const filteredItems = applyFilter(state.items, inputValue, props.filter);
    const highlightedItem = filteredItems.includes(state.highlightedItem ?? '')
      ? state.highlightedItem
      : filteredItems.find((value) => !state.items.find((item) => item.value === value)?.disabled) ??
        null;
    const inputResult =
      source === 'controlled-sync'
        ? inputValueController.syncValue(inputValue)
        : inputValueController.requestValue(inputValue);
    const openResult =
      source === 'controlled-sync'
        ? openController.syncValue(true)
        : openController.requestValue(true);

    store.patchState({
      inputValue: inputResult.value,
      filteredItems,
      highlightedItem,
      emptyStateShown: filteredItems.length === 0,
      open: openResult.value,
      virtualization: resolveVirtualWindow(
        filteredItems,
        props.virtualization,
        state.virtualization?.scrollOffset ?? 0
      ),
      lastChangeMeta: {
        source,
        reason,
        previousValue: state.value,
        nextValue: state.value,
      },
      lastError: null,
    });
  };

  const emitValue = (
    nextValue: string,
    source: ChangeMeta<string>['source'],
    reason: string,
    inputModality?: ChangeMeta<string>['inputModality']
  ) => {
    const state = store.getState();
    assertKnownValue(nextValue, state.items);
    const item = state.items.find((entry) => entry.value === nextValue);
    const valueResult =
      source === 'controlled-sync'
        ? valueController.syncValue(nextValue)
        : valueController.requestValue(nextValue);
    const inputResult =
      source === 'controlled-sync'
        ? inputValueController.syncValue(item?.label ?? nextValue)
        : inputValueController.requestValue(item?.label ?? nextValue);
    const openResult =
      source === 'controlled-sync'
        ? openController.syncValue(false)
        : openController.requestValue(false);

    const meta: ChangeMeta<string> = {
      source,
      reason,
      previousValue: state.value,
      nextValue,
      inputModality,
    };

    store.patchState(
      {
        value: valueResult.value,
        inputValue: inputResult.value,
        open: openResult.value,
        highlightedItem: nextValue,
        lastChangeMeta: meta,
        lastError: null,
      },
      meta
    );
  };

  const actions: ComboboxActions = {
    setValue(nextValue) {
      const state = store.getState();
      if (state.disabled) {
        store.patchState({
          lastError: createUIFnError({
            code: 'UIFN_ERR_DISABLED_INTERACTION',
            package: '@uifn/core',
            component: 'Combobox',
            message: 'Disabled controls MUST ignore state-changing input.',
            recoverable: true,
          }),
        });
        return;
      }

      if (state.value === nextValue) {
        return;
      }

      emitValue(nextValue, 'programmatic', 'set-value');
    },
    setInputValue(nextInputValue) {
      const state = store.getState();
      if (state.disabled) {
        store.patchState({
          lastError: createUIFnError({
            code: 'UIFN_ERR_DISABLED_INTERACTION',
            package: '@uifn/core',
            component: 'Combobox',
            message: 'Disabled controls MUST ignore state-changing input.',
            recoverable: true,
          }),
        });
        return;
      }

      if (state.inputValue === nextInputValue) {
        return;
      }

      recomputeFilterState(nextInputValue, 'programmatic', 'set-input-value');
    },
    setOpen(nextOpen) {
      const state = store.getState();
      if (state.disabled) {
        store.patchState({
          lastError: createUIFnError({
            code: 'UIFN_ERR_DISABLED_INTERACTION',
            package: '@uifn/core',
            component: 'Combobox',
            message: 'Disabled controls MUST ignore state-changing input.',
            recoverable: true,
          }),
        });
        return;
      }

      if (state.open === nextOpen) {
        return;
      }

      const openResult = openController.requestValue(nextOpen);
      store.patchState({
        open: openResult.value,
      });
    },
    syncValue(nextValue) {
      emitValue(nextValue, 'controlled-sync', 'sync-value');
    },
    syncInputValue(nextValue) {
      recomputeFilterState(nextValue, 'controlled-sync', 'sync-input-value');
    },
    syncOpen(nextOpen) {
      const openResult = openController.syncValue(nextOpen);
      store.patchState({
        open: openResult.value,
      });
    },
    setItems(nextItems) {
      const state = store.getState();
      const normalizedItems = normalizeItems(nextItems);
      assertKnownValue(state.value, normalizedItems);
      const filteredItems = applyFilter(normalizedItems, state.inputValue, props.filter);
      store.patchState({
        ids: createComboboxIds(
          {
            ...props,
            idBase: state.ids.baseId,
          },
          normalizedItems,
          state.ids.baseId
        ),
        items: normalizedItems,
        filteredItems,
        highlightedItem: filteredItems.includes(state.highlightedItem ?? '')
          ? state.highlightedItem
          : filteredItems[0] ?? null,
        emptyStateShown: filteredItems.length === 0,
        virtualization: resolveVirtualWindow(
          filteredItems,
          props.virtualization,
          state.virtualization?.scrollOffset ?? 0
        ),
      });
    },
    setHighlightedItem(itemId) {
      const state = store.getState();
      if (itemId === null) {
        store.patchState({
          highlightedItem: null,
        });
        return;
      }

      if (!state.filteredItems.includes(itemId)) {
        return;
      }

      const item = state.items.find((entry) => entry.value === itemId);
      if (item?.disabled) {
        return;
      }

      store.patchState({
        highlightedItem: itemId,
      });
    },
    handleKeyDown(key, currentItem) {
      const state = store.getState();
      const enabledFiltered = state.filteredItems.filter((value) => {
        const item = state.items.find((entry) => entry.value === value);
        return item && !item.disabled;
      });

      if (key === 'Escape') {
        const openResult = openController.requestValue(false);
        store.patchState({
          open: openResult.value,
        });
        return state.highlightedItem;
      }

      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
        if (enabledFiltered.length === 0) {
          return null;
        }

        if (!state.open) {
          const openResult = openController.requestValue(true);
          store.patchState({
            open: openResult.value,
          });
        }

        const currentValue = currentItem ?? state.highlightedItem ?? enabledFiltered[0];
        const currentIndex = Math.max(0, enabledFiltered.indexOf(currentValue));
        const nextIndex = getNextRovingFocusIndex({
          key,
          itemCount: enabledFiltered.length,
          currentIndex,
          orientation: 'vertical',
        });
        const nextItem = enabledFiltered[nextIndex] ?? null;
        if (!nextItem) {
          return null;
        }

        store.patchState({
          highlightedItem: nextItem,
        });
        return nextItem;
      }

      if (key === 'Enter') {
        if (!state.highlightedItem || !state.filteredItems.includes(state.highlightedItem)) {
          store.patchState({
            lastError: createUIFnError({
              code: 'UIFN_ERR_COMBOBOX_FILTER_STATE',
              package: '@uifn/core',
              component: 'Combobox',
              message: 'Combobox MUST not select an item that is not in the filtered result set.',
              recoverable: true,
            }),
          });
          return null;
        }

        emitValue(state.highlightedItem, 'user', 'select-keyboard', 'keyboard');
        return state.highlightedItem;
      }

      return state.highlightedItem;
    },
    setScrollOffset(offset) {
      const state = store.getState();
      if (!state.virtualization) {
        return;
      }

      store.patchState({
        virtualization: resolveVirtualWindow(
          state.filteredItems,
          {
            enabled: true,
            itemHeight: state.virtualization.itemHeight,
            viewportHeight: state.virtualization.viewportHeight,
            overscan: state.virtualization.overscan,
          },
          Math.max(0, offset)
        ),
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
