export type ChangeSource = 'user' | 'programmatic' | 'controlled-sync';

export interface ChangeMeta<TValue = unknown> {
  source: ChangeSource;
  reason: string;
  previousValue: TValue;
  nextValue: TValue;
  inputModality?: 'keyboard' | 'pointer' | 'touch' | 'virtual';
}

export type Subscriber<TState, TValue = unknown> = (
  state: TState,
  meta?: ChangeMeta<TValue>
) => void;

export function createStore<TState, TValue = unknown>(initialState: TState) {
  let state = initialState;
  const listeners = new Set<Subscriber<TState, TValue>>();

  const getState = () => state;

  const setState = (nextState: TState, meta?: ChangeMeta<TValue>) => {
    state = nextState;
    listeners.forEach((listener) => listener(state, meta));
  };

  const patchState = (partial: Partial<TState>, meta?: ChangeMeta<TValue>) => {
    setState({ ...state, ...partial }, meta);
  };

  const subscribe = (listener: Subscriber<TState, TValue>) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  return {
    getState,
    setState,
    patchState,
    subscribe,
  };
}

export function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function alignToStep(value: number, min: number, step: number): number {
  if (step <= 0) {
    return value;
  }

  const distance = value - min;
  const steps = Math.round(distance / step);
  return min + steps * step;
}

export function shallowArrayEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }

  return true;
}
