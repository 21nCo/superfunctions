export type AvatarStatus = 'idle' | 'loading' | 'loaded' | 'error';

export interface AvatarState {
  status: AvatarStatus;
}

export interface AvatarActions {
  setLoading: () => void;
  setLoaded: () => void;
  setError: () => void;
}

export interface AvatarMachine {
  state: AvatarState;
  actions: AvatarActions;
  subscribe: (callback: (state: AvatarState) => void) => () => void;
}

export function createAvatar(): AvatarMachine {
  let state: AvatarState = { status: 'idle' };
  const listeners = new Set<(state: AvatarState) => void>();

  const notify = () => {
    listeners.forEach(l => l({ ...state }));
  };

  const actions: AvatarActions = {
    setLoading: () => { state.status = 'loading'; notify(); },
    setLoaded: () => { state.status = 'loaded'; notify(); },
    setError: () => { state.status = 'error'; notify(); },
  };

  return {
    state,
    actions,
    subscribe: (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }
  };
}
