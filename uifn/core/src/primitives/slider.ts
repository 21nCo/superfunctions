import { createUIFnError, type UIFnError } from '../errors';
import { K } from '../aria/keys';
import { alignToStep, clamp, type ChangeMeta, createStore, shallowArrayEqual } from './shared';

export interface SliderProps {
  value?: number[];
  defaultValue?: number[];
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  orientation?: 'horizontal' | 'vertical';
  onValueChange?: (value: number[]) => void;
}

export interface SliderState {
  value: number[];
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  orientation: 'horizontal' | 'vertical';
  activeThumb: number;
  lastChangeMeta?: ChangeMeta<number[]>;
  lastError: UIFnError | null;
}

export interface SliderActions {
  setValue: (value: number[]) => void;
  setThumbValue: (index: number, value: number) => void;
  stepThumb: (index: number, key: string) => void;
  setActiveThumb: (index: number) => void;
  syncValue: (value: number[]) => void;
}

export interface SliderMachine {
  readonly state: SliderState;
  readonly actions: SliderActions;
  readonly options: {
    min: number;
    max: number;
    step: number;
    orientation: 'horizontal' | 'vertical';
  };
  getState: () => SliderState;
  subscribe: (callback: (state: SliderState, meta?: ChangeMeta<number[]>) => void) => () => void;
}

function normalizeSliderValue(values: number[], min: number, max: number, step: number): number[] {
  const normalized = values.length > 0 ? [...values] : [min];

  const stepped = normalized.map((value) => {
    const clampedValue = clamp(value, min, max);
    const alignedValue = alignToStep(clampedValue, min, step);
    return clamp(alignedValue, min, max);
  });

  return stepped.sort((left, right) => left - right);
}

function hasOutOfBoundsValue(values: number[], min: number, max: number): boolean {
  return values.some((value) => value < min || value > max);
}

export function createSlider(props: SliderProps): SliderMachine {
  const min = props.min ?? 0;
  const max = props.max ?? 100;
  const step = props.step ?? 1;
  const orientation = props.orientation ?? 'horizontal';
  const disabled = props.disabled ?? false;
  const initialValue = normalizeSliderValue(
    props.value ?? props.defaultValue ?? [min],
    min,
    max,
    step
  );

  const store = createStore<SliderState, number[]>({
    value: initialValue,
    min,
    max,
    step,
    disabled,
    orientation,
    activeThumb: 0,
    lastError: null,
  });

  const emitValue = (
    rawValue: number[],
    reason: string,
    source: ChangeMeta<number[]>['source'],
    inputModality?: ChangeMeta<number[]>['inputModality']
  ) => {
    const state = store.getState();
    const normalized = normalizeSliderValue(rawValue, state.min, state.max, state.step);
    const outOfBounds = hasOutOfBoundsValue(rawValue, state.min, state.max);

    const meta: ChangeMeta<number[]> = {
      source,
      reason,
      previousValue: state.value,
      nextValue: normalized,
      inputModality,
    };

    store.patchState(
      {
        value: normalized,
        lastChangeMeta: meta,
        lastError: outOfBounds
          ? createUIFnError({
              code: 'UIFN_ERR_RANGE_OUT_OF_BOUNDS',
              package: '@uifn/core',
              component: 'Slider',
              message: 'Slider values MUST clamp and preserve deterministic thumb ordering.',
              recoverable: true,
              details: {
                rawValue,
                normalized,
                min: state.min,
                max: state.max,
              },
            })
          : null,
      },
      meta
    );
    props.onValueChange?.(normalized);
  };

  const ensureEnabled = (): boolean => {
    const state = store.getState();
    if (!state.disabled) {
      return true;
    }

    store.patchState({
      lastError: createUIFnError({
        code: 'UIFN_ERR_DISABLED_INTERACTION',
        package: '@uifn/core',
        component: 'Slider',
        message: 'Disabled controls MUST ignore state-changing input.',
        recoverable: true,
      }),
    });
    return false;
  };

  const actions: SliderActions = {
    setValue(value) {
      if (!ensureEnabled()) {
        return;
      }

      emitValue(value, 'set-value', 'programmatic');
    },
    setThumbValue(index, value) {
      if (!ensureEnabled()) {
        return;
      }

      const state = store.getState();
      const nextValues = [...state.value];
      if (index < 0 || index >= nextValues.length) {
        return;
      }
      nextValues[index] = value;
      emitValue(nextValues, 'set-thumb-value', 'programmatic');
      store.patchState({ activeThumb: index });
    },
    stepThumb(index, key) {
      if (!ensureEnabled()) {
        return;
      }

      const state = store.getState();
      if (index < 0 || index >= state.value.length) {
        return;
      }

      const value = state.value[index];
      let nextValue = value;

      if (key === K.HOME) {
        nextValue = state.min;
      } else if (key === K.END) {
        nextValue = state.max;
      } else if (key === K.ARROW_RIGHT) {
        nextValue = value + state.step;
      } else if (key === K.ARROW_LEFT) {
        nextValue = value - state.step;
      } else if (key === K.ARROW_UP) {
        nextValue = value + state.step;
      } else if (key === K.ARROW_DOWN) {
        nextValue = value - state.step;
      } else {
        return;
      }

      const nextValues = [...state.value];
      nextValues[index] = nextValue;
      emitValue(nextValues, 'keyboard-step', 'user', 'keyboard');
      store.patchState({ activeThumb: index });
    },
    setActiveThumb(index) {
      const state = store.getState();
      store.patchState({
        activeThumb: clamp(index, 0, state.value.length - 1),
      });
    },
    syncValue(value) {
      const state = store.getState();
      const normalized = normalizeSliderValue(value, state.min, state.max, state.step);
      if (shallowArrayEqual(normalized, state.value)) {
        return;
      }

      emitValue(value, 'sync-value', 'controlled-sync');
    },
  };

  return {
    get state() {
      return store.getState();
    },
    actions,
    options: {
      min,
      max,
      step,
      orientation,
    },
    getState: store.getState,
    subscribe: store.subscribe,
  };
}
