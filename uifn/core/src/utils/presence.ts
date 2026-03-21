export interface PresenceSnapshot {
  present: boolean;
  wasPresent: boolean;
  hasAnimation: boolean;
  hasTransition: boolean;
}

export type PresenceState = 'mounted' | 'unmount-suspended' | 'unmounted';

export interface MotionInfo {
  hasAnimation: boolean;
  hasTransition: boolean;
  animationDurationMs: number;
  transitionDurationMs: number;
}

export interface PresenceManagerState {
  present: boolean;
  state: PresenceState;
  reducedMotion: boolean;
  timers: number;
  listeners: number;
  cleanupComplete: boolean;
}

export interface PresenceManager {
  getState: () => PresenceManagerState;
  setPresent: (
    present: boolean,
    motion?: Pick<MotionInfo, 'hasAnimation' | 'hasTransition'>
  ) => PresenceManagerState;
  registerTimer: () => PresenceManagerState;
  clearTimer: () => PresenceManagerState;
  registerListener: () => PresenceManagerState;
  clearListener: () => PresenceManagerState;
  cleanup: () => PresenceManagerState;
}

export interface PresenceManagerOptions {
  reducedMotion?: boolean;
}

function parseTimeListMs(value: string): number {
  const tokens = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    return 0;
  }

  return tokens.reduce((max, token) => {
    const duration = token.endsWith('ms')
      ? Number.parseFloat(token)
      : Number.parseFloat(token) * 1000;
    return Number.isFinite(duration) ? Math.max(max, duration) : max;
  }, 0);
}

export function detectMotionFromStyles(
  styles: Pick<
    CSSStyleDeclaration,
    'animationName' | 'animationDuration' | 'transitionDuration'
  >
): MotionInfo {
  const animationDurationMs = parseTimeListMs(styles.animationDuration || '0s');
  const transitionDurationMs = parseTimeListMs(styles.transitionDuration || '0s');

  const hasAnimation =
    styles.animationName !== 'none' &&
    styles.animationName !== '' &&
    animationDurationMs > 0;
  const hasTransition = transitionDurationMs > 0;

  return {
    hasAnimation,
    hasTransition,
    animationDurationMs,
    transitionDurationMs,
  };
}

export function detectNodeMotion(node: HTMLElement): MotionInfo {
  const ownerWindow = node.ownerDocument.defaultView;
  if (!ownerWindow) {
    return {
      hasAnimation: false,
      hasTransition: false,
      animationDurationMs: 0,
      transitionDurationMs: 0,
    };
  }

  return detectMotionFromStyles(ownerWindow.getComputedStyle(node));
}

export function shouldSuspendUnmount(snapshot: PresenceSnapshot): boolean {
  return (
    snapshot.wasPresent &&
    !snapshot.present &&
    (snapshot.hasAnimation || snapshot.hasTransition)
  );
}

export function resolvePresenceState(snapshot: PresenceSnapshot): PresenceState {
  if (snapshot.present) {
    return 'mounted';
  }

  if (shouldSuspendUnmount(snapshot)) {
    return 'unmount-suspended';
  }

  return 'unmounted';
}

export function createPresenceManager(
  present: boolean,
  options: PresenceManagerOptions = {}
): PresenceManager {
  let state: PresenceManagerState = {
    present,
    state: present ? 'mounted' : 'unmounted',
    reducedMotion: options.reducedMotion ?? false,
    timers: 0,
    listeners: 0,
    cleanupComplete: !present,
  };

  const getState = (): PresenceManagerState => ({ ...state });

  const updateCleanupState = () => {
    state = {
      ...state,
      cleanupComplete: !state.present && state.timers === 0 && state.listeners === 0,
    };
  };

  return {
    getState,
    setPresent(nextPresent, motion) {
      const hasAnimation = state.reducedMotion ? false : motion?.hasAnimation ?? false;
      const hasTransition = state.reducedMotion ? false : motion?.hasTransition ?? false;
      const nextPresenceState = resolvePresenceState({
        present: nextPresent,
        wasPresent: state.present,
        hasAnimation,
        hasTransition,
      });

      state = {
        ...state,
        present: nextPresent,
        state: nextPresenceState,
      };

      updateCleanupState();
      return getState();
    },
    registerTimer() {
      state = {
        ...state,
        timers: state.timers + 1,
      };

      updateCleanupState();
      return getState();
    },
    clearTimer() {
      state = {
        ...state,
        timers: Math.max(0, state.timers - 1),
      };

      updateCleanupState();
      return getState();
    },
    registerListener() {
      state = {
        ...state,
        listeners: state.listeners + 1,
      };

      updateCleanupState();
      return getState();
    },
    clearListener() {
      state = {
        ...state,
        listeners: Math.max(0, state.listeners - 1),
      };

      updateCleanupState();
      return getState();
    },
    cleanup() {
      state = {
        ...state,
        timers: 0,
        listeners: 0,
        state: state.present ? 'mounted' : 'unmounted',
      };

      updateCleanupState();
      return getState();
    },
  };
}
