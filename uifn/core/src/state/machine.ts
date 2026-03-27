export type EventObject = { type: string; [key: string]: any };
export type StateConfig<TContext, TEvent extends EventObject> = {
  value: string;
  context: TContext;
  event: TEvent;
};

export type Transition<TContext, TEvent extends EventObject> = 
  | string // Target state
  | {
      target?: string;
      actions?: Array<(context: TContext, event: TEvent) => void>;
      cond?: (context: TContext, event: TEvent) => boolean;
    };

export type MachineConfig<TContext, TEvent extends EventObject> = {
  initial: string;
  context: TContext;
  states: {
    [key: string]: {
      on?: {
        [K in TEvent['type']]?: Transition<TContext, TEvent & { type: K }>;
      };
      entry?: Array<(context: TContext, event: TEvent) => void>;
      exit?: Array<(context: TContext, event: TEvent) => void>;
    };
  };
};

export class StateMachine<TContext, TEvent extends EventObject> {
  private _state: string;
  private _context: TContext;
  private _config: MachineConfig<TContext, TEvent>;
  private _listeners: Set<(state: string, context: TContext) => void> = new Set();

  constructor(config: MachineConfig<TContext, TEvent>) {
    this._config = config;
    this._state = config.initial;
    this._context = { ...config.context };
  }

  get state() {
    return this._state;
  }

  get context() {
    return this._context;
  }

  send(event: TEvent) {
    const currentStateConfig = this._config.states[this._state];
    const transition = currentStateConfig.on?.[event.type as keyof typeof currentStateConfig.on] as Transition<TContext, TEvent> | undefined;

    if (!transition) return;

    // Resolve transition
    let target = this._state;
    let actions: Array<(context: TContext, event: TEvent) => void> = [];

    if (typeof transition === 'string') {
      target = transition;
    } else {
      if (transition.cond && !transition.cond(this._context, event)) {
        return;
      }
      if (transition.target) target = transition.target;
      if (transition.actions) actions = transition.actions;
    }

    // Execute actions
    actions.forEach(action => action(this._context, event));

    // Transition if state changed
    if (target !== this._state) {
        // Exit current
        currentStateConfig.exit?.forEach(action => action(this._context, event));
        
        this._state = target;
        
        // Entry next
        const nextStateConfig = this._config.states[target];
        nextStateConfig.entry?.forEach(action => action(this._context, event));
        
        this._notify();
    }
  }

  subscribe(listener: (state: string, context: TContext) => void) {
    this._listeners.add(listener);
    listener(this._state, this._context);
    return () => {
      this._listeners.delete(listener);
    };
  }

  private _notify() {
    this._listeners.forEach(listener => listener(this._state, this._context));
  }
}

export function createMachine<TContext, TEvent extends EventObject>(
  config: MachineConfig<TContext, TEvent>
) {
  return new StateMachine(config);
}

export interface ControllableStateControllerOptions<TValue> {
  value?: TValue;
  defaultValue: TValue;
  onChange?: (value: TValue) => void;
  isEqual?: (a: TValue, b: TValue) => boolean;
}

export interface ControllableStateRequestResult<TValue> {
  value: TValue;
  changed: boolean;
  controlled: boolean;
}

export interface ControllableStateController<TValue> {
  isControlled: () => boolean;
  getValue: () => TValue;
  requestValue: (nextValue: TValue) => ControllableStateRequestResult<TValue>;
  syncValue: (nextValue: TValue) => ControllableStateRequestResult<TValue>;
}

export function createControllableStateController<TValue>(
  options: ControllableStateControllerOptions<TValue>
): ControllableStateController<TValue> {
  const controlled = options.value !== undefined;
  const isEqual = options.isEqual ?? Object.is;
  let currentValue = controlled ? (options.value as TValue) : options.defaultValue;

  return {
    isControlled() {
      return controlled;
    },
    getValue() {
      return currentValue;
    },
    requestValue(nextValue) {
      const previousValue = currentValue;
      const changed = !isEqual(previousValue, nextValue);

      if (!controlled) {
        currentValue = nextValue;
      }

      if (changed) {
        options.onChange?.(nextValue);
      }

      return {
        value: controlled ? previousValue : currentValue,
        changed,
        controlled,
      };
    },
    syncValue(nextValue) {
      const previousValue = currentValue;
      const changed = !isEqual(previousValue, nextValue);
      currentValue = nextValue;

      return {
        value: currentValue,
        changed,
        controlled,
      };
    },
  };
}
