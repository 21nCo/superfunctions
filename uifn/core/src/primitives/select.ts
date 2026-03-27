import { createUIFnError, type UIFnError } from '../errors';
import { createControllableStateController } from '../state/machine';
import { composePublicId, generateId, registerPublicId } from '../utils/id';
import { getNextRovingFocusIndex } from '../utils/roving-focus';
import { type ChangeMeta, createStore } from './shared';

export interface SelectOption {
  value: string;
  label?: string;
  disabled?: boolean;
  group?: string;
  separatorBefore?: boolean;
}

export interface SelectGroup {
  label: string;
  optionValues: string[];
}

export type SelectOptionInput = string | SelectOption;

export interface SelectProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  idBase?: string;
  disabled?: boolean;
  required?: boolean;
  name?: string;
  items?: SelectOptionInput[];
  groups?: Record<string, SelectOptionInput[]>;
}

export interface SelectIds {
  baseId: string;
  triggerId: string;
  contentId: string;
  labelId: string;
  optionIds: Record<string, string>;
  groupIds: Record<string, string>;
}

export interface SelectState {
  value: string;
  open: boolean;
  valueControlled: boolean;
  openControlled: boolean;
  disabled: boolean;
  required: boolean;
  name?: string;
  ids: SelectIds;
  options: SelectOption[];
  groups: SelectGroup[];
  highlightedItem: string | null;
  typeaheadBuffer: string;
  selectedIndicator: string | null;
  hiddenInputValue: string | null;
  lastChangeMeta?: ChangeMeta<string>;
  lastError: UIFnError | null;
}

export interface SelectActions {
  setValue: (value: string) => void;
  setOpen: (open: boolean) => void;
  syncValue: (value: string) => void;
  syncOpen: (open: boolean) => void;
  registerOption: (option: SelectOption) => void;
  setOptions: (options: SelectOptionInput[]) => void;
  handleKeyDown: (key: string, currentItem?: string | null) => string | null;
  clearTypeahead: () => void;
  getHiddenInput: () => { name: string; value: string } | null;
}

export interface SelectMachine {
  readonly state: SelectState;
  readonly actions: SelectActions;
  getState: () => SelectState;
  subscribe: (
    callback: (state: SelectState, meta?: ChangeMeta<string>) => void
  ) => () => void;
}

function toOption(option: SelectOptionInput, group?: string): SelectOption {
  if (typeof option === 'string') {
    return {
      value: option,
      label: option,
      group,
    };
  }

  return {
    ...option,
    label: option.label ?? option.value,
    group: option.group ?? group,
  };
}

function normalizeOptions(
  items: SelectOptionInput[] | undefined,
  groups: Record<string, SelectOptionInput[]> | undefined
): { options: SelectOption[]; grouped: SelectGroup[] } {
  if (groups && Object.keys(groups).length > 0) {
    const allOptions: SelectOption[] = [];
    const normalizedGroups: SelectGroup[] = [];

    Object.entries(groups).forEach(([label, values]) => {
      const normalized = values.map((option) => toOption(option, label));
      normalizedGroups.push({
        label,
        optionValues: normalized.map((entry) => entry.value),
      });
      allOptions.push(...normalized);
    });

    return {
      options: dedupeOptions(allOptions),
      grouped: normalizedGroups,
    };
  }

  return {
    options: dedupeOptions((items ?? []).map((option) => toOption(option))),
    grouped: [],
  };
}

function dedupeOptions(options: SelectOption[]): SelectOption[] {
  const dedupe = new Map<string, SelectOption>();
  options.forEach((option) => {
    dedupe.set(option.value, option);
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

function createSelectIds(
  props: SelectProps,
  options: SelectOption[],
  groups: SelectGroup[],
  existingBaseId?: string
): SelectIds {
  const buildId = (prefix: string, slot: string) => {
    const id = composePublicId({ prefix, slot });
    return existingBaseId ? id : registerPublicId(id);
  };
  const baseId = existingBaseId
    ? existingBaseId
    : props.idBase
    ? registerPublicId(props.idBase, {
        package: '@uifn/core',
        component: 'Select',
      })
    : generateId('select');

  return {
    baseId,
    triggerId: buildId(baseId, 'trigger'),
    contentId: buildId(baseId, 'content'),
    labelId: buildId(baseId, 'label'),
    optionIds: Object.fromEntries(
      options.map((option) => [
        option.value,
        buildId(`${baseId}-option`, normalizeIdSegment(option.value)),
      ])
    ),
    groupIds: Object.fromEntries(
      groups.map((group) => [
        group.label,
        buildId(`${baseId}-group`, normalizeIdSegment(group.label)),
      ])
    ),
  };
}

function getEnabledOptions(options: SelectOption[]): SelectOption[] {
  return options.filter((option) => !option.disabled);
}

function findOption(options: SelectOption[], value: string): SelectOption | undefined {
  return options.find((option) => option.value === value);
}

function getHiddenInputValue(name: string | undefined, value: string): string | null {
  if (!name) {
    return null;
  }

  return value;
}

function isPrintableKey(key: string): boolean {
  return key.length === 1 && key !== ' ';
}

function resolveTypeaheadMatch(
  options: SelectOption[],
  buffer: string,
  currentHighlighted: string | null
): string | null {
  if (!buffer) {
    return currentHighlighted;
  }

  const enabled = getEnabledOptions(options);
  if (enabled.length === 0) {
    return null;
  }

  const currentOption = currentHighlighted
    ? enabled.find((option) => option.value === currentHighlighted)
    : undefined;
  if (currentOption && currentOption.label?.toLowerCase().startsWith(buffer)) {
    return currentOption.value;
  }

  const currentIndex = currentHighlighted
    ? enabled.findIndex((option) => option.value === currentHighlighted)
    : -1;
  for (let offset = 1; offset <= enabled.length; offset += 1) {
    const nextIndex = (currentIndex + offset + enabled.length) % enabled.length;
    const candidate = enabled[nextIndex];
    if (candidate?.label?.toLowerCase().startsWith(buffer)) {
      return candidate.value;
    }
  }

  return currentHighlighted;
}

function assertKnownValue(value: string, options: SelectOption[]): void {
  if (!value) {
    return;
  }

  if (!options.some((option) => option.value === value)) {
    throw createUIFnError({
      code: 'UIFN_ERR_INVALID_VALUE',
      package: '@uifn/core',
      component: 'Select',
      message: 'Select MUST not silently select an arbitrary fallback item.',
      details: {
        value,
        items: options.map((option) => option.value),
      },
    });
  }
}

export function createSelect(props: SelectProps): SelectMachine {
  const normalized = normalizeOptions(props.items, props.groups);
  const initialValue = props.value ?? props.defaultValue ?? '';
  const valueController = createControllableStateController<string>({
    value: props.value,
    defaultValue: props.defaultValue ?? '',
    onChange: props.onValueChange,
  });
  const openController = createControllableStateController<boolean>({
    value: props.open,
    defaultValue: props.defaultOpen ?? false,
    onChange: props.onOpenChange,
  });
  const ids = createSelectIds(props, normalized.options, normalized.grouped);
  assertKnownValue(initialValue, normalized.options);

  const store = createStore<SelectState, string>({
    value: valueController.getValue(),
    open: openController.getValue(),
    valueControlled: valueController.isControlled(),
    openControlled: openController.isControlled(),
    disabled: props.disabled ?? false,
    required: props.required ?? false,
    name: props.name,
    ids,
    options: normalized.options,
    groups: normalized.grouped,
    highlightedItem: initialValue || getEnabledOptions(normalized.options)[0]?.value || null,
    typeaheadBuffer: '',
    selectedIndicator: initialValue || null,
    hiddenInputValue: getHiddenInputValue(props.name, initialValue),
    lastError: null,
  });

  const emitValue = (
    nextValue: string,
    reason: string,
    source: ChangeMeta<string>['source'],
    inputModality?: ChangeMeta<string>['inputModality']
  ) => {
    const state = store.getState();
    assertKnownValue(nextValue, state.options);
    const result =
      source === 'controlled-sync'
        ? valueController.syncValue(nextValue)
        : valueController.requestValue(nextValue);

    const meta: ChangeMeta<string> = {
      source,
      reason,
      previousValue: state.value,
      nextValue,
      inputModality,
    };
    store.patchState(
      {
        value: result.value,
        selectedIndicator: result.value || null,
        hiddenInputValue: getHiddenInputValue(state.name, result.value),
        highlightedItem: nextValue || state.highlightedItem,
        lastChangeMeta: meta,
        lastError: null,
      },
      meta
    );
  };

  const emitOpen = (
    nextOpen: boolean,
    reason: string,
    source: ChangeMeta<string>['source'],
    inputModality?: ChangeMeta<string>['inputModality']
  ) => {
    const state = store.getState();
    const enabled = getEnabledOptions(state.options);
    const highlighted =
      state.highlightedItem ?? state.value ?? enabled[0]?.value ?? null;
    const result =
      source === 'controlled-sync'
        ? openController.syncValue(nextOpen)
        : openController.requestValue(nextOpen);

    store.patchState({
      open: result.value,
      highlightedItem: nextOpen ? highlighted : state.highlightedItem,
      lastChangeMeta: {
        source,
        reason,
        previousValue: state.value,
        nextValue: state.value,
        inputModality,
      },
    });
  };

  const actions: SelectActions = {
    setValue(nextValue) {
      const state = store.getState();
      if (state.disabled) {
        store.patchState({
          lastError: createUIFnError({
            code: 'UIFN_ERR_DISABLED_INTERACTION',
            package: '@uifn/core',
            component: 'Select',
            message: 'Disabled controls MUST ignore state-changing input.',
            recoverable: true,
          }),
        });
        return;
      }

      if (state.value === nextValue) {
        return;
      }

      emitValue(nextValue, 'set-value', 'programmatic');
    },
    setOpen(nextOpen) {
      const state = store.getState();
      if (state.disabled) {
        store.patchState({
          lastError: createUIFnError({
            code: 'UIFN_ERR_DISABLED_INTERACTION',
            package: '@uifn/core',
            component: 'Select',
            message: 'Disabled controls MUST ignore state-changing input.',
            recoverable: true,
          }),
        });
        return;
      }

      if (state.open === nextOpen) {
        return;
      }

      emitOpen(nextOpen, 'set-open', 'programmatic');
    },
    syncValue(nextValue) {
      emitValue(nextValue, 'sync-value', 'controlled-sync');
    },
    syncOpen(nextOpen) {
      emitOpen(nextOpen, 'sync-open', 'controlled-sync');
    },
    registerOption(option) {
      const state = store.getState();
      if (state.options.some((entry) => entry.value === option.value)) {
        return;
      }

      const nextOptions = [...state.options, toOption(option)];
      const nextGroups = state.groups;
      store.patchState({
        options: nextOptions,
        ids: createSelectIds(
          {
            ...props,
            idBase: state.ids.baseId,
          },
          nextOptions,
          nextGroups,
          state.ids.baseId
        ),
      });
    },
    setOptions(nextOptions) {
      const state = store.getState();
      const normalizedOptions = dedupeOptions(nextOptions.map((option) => toOption(option)));
      assertKnownValue(state.value, normalizedOptions);
      const highlighted = normalizedOptions.some(
        (option) => option.value === state.highlightedItem
      )
        ? state.highlightedItem
        : getEnabledOptions(normalizedOptions)[0]?.value || null;

      store.patchState({
        options: normalizedOptions,
        ids: createSelectIds(
          {
            ...props,
            idBase: state.ids.baseId,
          },
          normalizedOptions,
          state.groups,
          state.ids.baseId
        ),
        highlightedItem: highlighted,
      });
    },
    handleKeyDown(key, currentItem) {
      const state = store.getState();
      const enabled = getEnabledOptions(state.options);
      if (enabled.length === 0) {
        return null;
      }

      const selectedIndex = enabled.findIndex((option) => option.value === state.value);
      const current = currentItem ?? state.highlightedItem ?? enabled[Math.max(0, selectedIndex)]?.value;

      if (key === 'Escape' && state.open) {
        emitOpen(false, 'close-escape', 'user', 'keyboard');
        return state.highlightedItem;
      }

      if (key === 'Enter' || key === ' ') {
        if (!state.open) {
          emitOpen(true, 'open-keyboard', 'user', 'keyboard');
          return state.highlightedItem;
        }

        if (state.highlightedItem) {
          emitValue(state.highlightedItem, 'select-keyboard', 'user', 'keyboard');
          emitOpen(false, 'close-select', 'user', 'keyboard');
          return state.highlightedItem;
        }
        return null;
      }

      if (isPrintableKey(key)) {
        const buffer = `${state.typeaheadBuffer}${key.toLowerCase()}`;
        const matched = resolveTypeaheadMatch(state.options, buffer, state.highlightedItem);
        store.patchState({
          typeaheadBuffer: buffer,
          highlightedItem: matched,
        });
        return matched;
      }

      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
        if (!state.open) {
          emitOpen(true, 'open-navigation', 'user', 'keyboard');
        }

        const currentIndex = Math.max(
          0,
          enabled.findIndex((option) => option.value === current)
        );
        const nextIndex = getNextRovingFocusIndex({
          key,
          itemCount: enabled.length,
          currentIndex,
          orientation: 'vertical',
        });

        const next = enabled[nextIndex]?.value ?? null;
        if (!next) {
          return null;
        }

        store.patchState({
          highlightedItem: next,
        });
        return next;
      }

      return state.highlightedItem;
    },
    clearTypeahead() {
      store.patchState({
        typeaheadBuffer: '',
      });
    },
    getHiddenInput() {
      const state = store.getState();
      if (!state.name || state.hiddenInputValue === null) {
        return null;
      }

      return {
        name: state.name,
        value: state.hiddenInputValue,
      };
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
