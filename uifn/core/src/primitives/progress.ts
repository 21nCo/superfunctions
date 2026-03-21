import { clamp, type ChangeMeta, createStore } from './shared';

export interface ProgressProps {
  value?: number | null;
  defaultValue?: number | null;
  max?: number;
  min?: number;
  onValueChange?: (value: number | null) => void;
}

export interface ProgressState {
  value: number | null;
  min: number;
  max: number;
  mode: 'determinate' | 'indeterminate';
  ariaValueNow: number | null;
  lastChangeMeta?: ChangeMeta<number | null>;
}

export interface ProgressMachine {
  readonly state: ProgressState;
  setValue: (value: number | null) => void;
  getState: () => ProgressState;
  subscribe: (callback: (state: ProgressState, meta?: ChangeMeta<number | null>) => void) => () => void;
}

function normalizeProgressValue(value: number | null, min: number, max: number): number | null {
  if (value === null) {
    return null;
  }

  return clamp(value, min, max);
}

function getMode(value: number | null): 'determinate' | 'indeterminate' {
  return value === null ? 'indeterminate' : 'determinate';
}

export function createProgress(props: ProgressProps): ProgressMachine {
  const min = props.min ?? 0;
  const max = props.max ?? 100;
  const initialRawValue =
    props.value !== undefined
      ? props.value
      : props.defaultValue !== undefined
        ? props.defaultValue
        : 0;
  const initialValue = normalizeProgressValue(initialRawValue, min, max);

  const store = createStore<ProgressState, number | null>({
    value: initialValue,
    min,
    max,
    mode: getMode(initialValue),
    ariaValueNow: initialValue,
  });

  const setValue = (value: number | null) => {
    const state = store.getState();
    const normalized = normalizeProgressValue(value, state.min, state.max);
    const meta: ChangeMeta<number | null> = {
      source: 'programmatic',
      reason: 'set-value',
      previousValue: state.value,
      nextValue: normalized,
    };

    store.patchState(
      {
        value: normalized,
        mode: getMode(normalized),
        ariaValueNow: normalized,
        lastChangeMeta: meta,
      },
      meta
    );
    props.onValueChange?.(normalized);
  };

  return {
    get state() {
      return store.getState();
    },
    setValue,
    getState: store.getState,
    subscribe: store.subscribe,
  };
}
