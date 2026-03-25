import { createUIFnError, type UIFnError } from '../errors';
import { clamp, type ChangeMeta, createStore } from './shared';

export interface ScrollAreaProps {
  type?: 'auto' | 'always' | 'scroll' | 'hover';
  scrollHideDelay?: number;
}

export interface ScrollMetrics {
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  scrollWidth: number;
  clientHeight: number;
  clientWidth: number;
}

export interface ScrollAxisState {
  visible: boolean;
  thumbSizePercent: number;
  thumbPositionPercent: number;
}

export interface ScrollAreaState {
  type: 'auto' | 'always' | 'scroll' | 'hover';
  scrollHideDelay: number;
  viewport: ScrollMetrics;
  vertical: ScrollAxisState;
  horizontal: ScrollAxisState;
  cornerVisible: boolean;
  lastInteraction: 'viewport' | 'vertical-thumb' | 'horizontal-thumb' | null;
  lastChangeMeta?: ChangeMeta<number>;
  lastError: UIFnError | null;
}

export interface ScrollAreaActions {
  setViewportMetrics: (metrics: Partial<ScrollMetrics>) => void;
  onViewportScroll: (position: { top?: number; left?: number }) => void;
  scrollTo: (position: { top?: number; left?: number }) => void;
  dragVerticalThumb: (positionPercent: number) => void;
  dragHorizontalThumb: (positionPercent: number) => void;
}

export interface ScrollAreaMachine {
  readonly state: ScrollAreaState;
  readonly actions: ScrollAreaActions;
  getState: () => ScrollAreaState;
  subscribe: (
    callback: (state: ScrollAreaState, meta?: ChangeMeta<number>) => void
  ) => () => void;
}

function createDefaultViewport(): ScrollMetrics {
  return {
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 0,
    scrollWidth: 0,
    clientHeight: 0,
    clientWidth: 0,
  };
}

function toAxisState(
  scrollSize: number,
  clientSize: number,
  scrollOffset: number
): ScrollAxisState {
  const visible = scrollSize > clientSize && clientSize > 0;
  if (!visible) {
    return {
      visible: false,
      thumbSizePercent: 100,
      thumbPositionPercent: 0,
    };
  }

  const maxScroll = Math.max(1, scrollSize - clientSize);
  const thumbSizePercent = clamp((clientSize / scrollSize) * 100, 5, 100);
  const thumbPositionPercent = clamp((scrollOffset / maxScroll) * 100, 0, 100);

  return {
    visible: true,
    thumbSizePercent,
    thumbPositionPercent,
  };
}

function resolveStateFromViewport(
  viewport: ScrollMetrics
): Pick<ScrollAreaState, 'vertical' | 'horizontal' | 'cornerVisible'> {
  const vertical = toAxisState(viewport.scrollHeight, viewport.clientHeight, viewport.scrollTop);
  const horizontal = toAxisState(viewport.scrollWidth, viewport.clientWidth, viewport.scrollLeft);

  return {
    vertical,
    horizontal,
    cornerVisible: vertical.visible && horizontal.visible,
  };
}

function toScrollOffset(positionPercent: number, scrollSize: number, clientSize: number): number {
  const maxScroll = Math.max(0, scrollSize - clientSize);
  if (maxScroll === 0) {
    return 0;
  }

  return (clamp(positionPercent, 0, 100) / 100) * maxScroll;
}

function clampViewport(viewport: ScrollMetrics): ScrollMetrics {
  return {
    ...viewport,
    scrollTop: clamp(
      viewport.scrollTop,
      0,
      Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    ),
    scrollLeft: clamp(
      viewport.scrollLeft,
      0,
      Math.max(0, viewport.scrollWidth - viewport.clientWidth)
    ),
  };
}

export function createScrollArea(props: ScrollAreaProps): ScrollAreaMachine {
  const viewport = createDefaultViewport();
  const computed = resolveStateFromViewport(viewport);
  const store = createStore<ScrollAreaState, number>({
    type: props.type ?? 'hover',
    scrollHideDelay: props.scrollHideDelay ?? 600,
    viewport,
    vertical: computed.vertical,
    horizontal: computed.horizontal,
    cornerVisible: computed.cornerVisible,
    lastInteraction: null,
    lastError: null,
  });

  const actions: ScrollAreaActions = {
    setViewportMetrics(metrics) {
      const state = store.getState();
      const nextViewport = clampViewport({
        ...state.viewport,
        ...metrics,
      });
      const nextComputed = resolveStateFromViewport(nextViewport);
      store.patchState({
        viewport: nextViewport,
        vertical: nextComputed.vertical,
        horizontal: nextComputed.horizontal,
        cornerVisible: nextComputed.cornerVisible,
      });
    },
    onViewportScroll(position) {
      const state = store.getState();
      const nextViewport = clampViewport({
        ...state.viewport,
        scrollTop: position.top !== undefined ? position.top : state.viewport.scrollTop,
        scrollLeft: position.left !== undefined ? position.left : state.viewport.scrollLeft,
      });
      const nextComputed = resolveStateFromViewport(nextViewport);
      const meta: ChangeMeta<number> = {
        source: 'user',
        reason: 'viewport-scroll',
        previousValue: state.viewport.scrollTop,
        nextValue: nextViewport.scrollTop,
        inputModality: 'pointer',
      };
      store.patchState(
        {
          viewport: nextViewport,
          vertical: nextComputed.vertical,
          horizontal: nextComputed.horizontal,
          cornerVisible: nextComputed.cornerVisible,
          lastInteraction: 'viewport',
          lastChangeMeta: meta,
          lastError: null,
        },
        meta
      );
    },
    scrollTo(position) {
      const state = store.getState();
      const nextViewport = clampViewport({
        ...state.viewport,
        scrollTop: position.top !== undefined ? position.top : state.viewport.scrollTop,
        scrollLeft: position.left !== undefined ? position.left : state.viewport.scrollLeft,
      });
      const nextComputed = resolveStateFromViewport(nextViewport);
      const meta: ChangeMeta<number> = {
        source: 'programmatic',
        reason: 'programmatic-scroll',
        previousValue: state.viewport.scrollTop,
        nextValue: nextViewport.scrollTop,
      };
      store.patchState(
        {
          viewport: nextViewport,
          vertical: nextComputed.vertical,
          horizontal: nextComputed.horizontal,
          cornerVisible: nextComputed.cornerVisible,
          lastInteraction: 'viewport',
          lastChangeMeta: meta,
          lastError: null,
        },
        meta
      );
    },
    dragVerticalThumb(positionPercent) {
      const state = store.getState();
      if (!state.vertical.visible) {
        store.patchState({
          lastError: createUIFnError({
            code: 'UIFN_ERR_SCROLL_SYNC',
            package: '@uifn/core',
            component: 'ScrollArea',
            message: 'ScrollArea viewport and thumb state MUST remain synchronized.',
            recoverable: true,
          }),
        });
        return;
      }

      const nextScrollTop = toScrollOffset(
        positionPercent,
        state.viewport.scrollHeight,
        state.viewport.clientHeight
      );
      const nextViewport = clampViewport({
        ...state.viewport,
        scrollTop: nextScrollTop,
      });
      const nextComputed = resolveStateFromViewport(nextViewport);
      const meta: ChangeMeta<number> = {
        source: 'user',
        reason: 'vertical-thumb-drag',
        previousValue: state.viewport.scrollTop,
        nextValue: nextScrollTop,
        inputModality: 'pointer',
      };
      store.patchState(
        {
          viewport: nextViewport,
          vertical: {
            ...nextComputed.vertical,
            thumbPositionPercent: clamp(positionPercent, 0, 100),
          },
          horizontal: nextComputed.horizontal,
          cornerVisible: nextComputed.cornerVisible,
          lastInteraction: 'vertical-thumb',
          lastChangeMeta: meta,
          lastError: null,
        },
        meta
      );
    },
    dragHorizontalThumb(positionPercent) {
      const state = store.getState();
      if (!state.horizontal.visible) {
        store.patchState({
          lastError: createUIFnError({
            code: 'UIFN_ERR_SCROLL_SYNC',
            package: '@uifn/core',
            component: 'ScrollArea',
            message: 'ScrollArea viewport and thumb state MUST remain synchronized.',
            recoverable: true,
          }),
        });
        return;
      }

      const nextScrollLeft = toScrollOffset(
        positionPercent,
        state.viewport.scrollWidth,
        state.viewport.clientWidth
      );
      const nextViewport = clampViewport({
        ...state.viewport,
        scrollLeft: nextScrollLeft,
      });
      const nextComputed = resolveStateFromViewport(nextViewport);
      const meta: ChangeMeta<number> = {
        source: 'user',
        reason: 'horizontal-thumb-drag',
        previousValue: state.viewport.scrollLeft,
        nextValue: nextScrollLeft,
        inputModality: 'pointer',
      };
      store.patchState(
        {
          viewport: nextViewport,
          horizontal: {
            ...nextComputed.horizontal,
            thumbPositionPercent: clamp(positionPercent, 0, 100),
          },
          vertical: nextComputed.vertical,
          cornerVisible: nextComputed.cornerVisible,
          lastInteraction: 'horizontal-thumb',
          lastChangeMeta: meta,
          lastError: null,
        },
        meta
      );
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
