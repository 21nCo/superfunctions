import React from 'react';
import { detectNodeMotion } from '@uifn/core/utils/presence';

const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? React.useLayoutEffect : React.useEffect;

export interface PresenceProps {
  present: boolean;
  children: React.ReactElement | ((props: { present: boolean }) => React.ReactElement);
}

export const Presence: React.FC<PresenceProps> = ({ present, children }) => {
  const [isPresent, setIsPresent] = React.useState(present);
  const nodeRef = React.useRef<HTMLElement | null>(null);
  const cleanupTimer = React.useRef<number | null>(null);

  useIsomorphicLayoutEffect(() => {
    if (present) {
      setIsPresent(true);
      return;
    }

    const node = nodeRef.current;
    if (!node) {
      setIsPresent(false);
      return;
    }

    const motion = detectNodeMotion(node);
    const maxDuration = Math.max(motion.animationDurationMs, motion.transitionDurationMs);
    if (!motion.hasAnimation && !motion.hasTransition) {
      setIsPresent(false);
      return;
    }

    let completed = false;
    const complete = () => {
      if (completed) {
        return;
      }
      completed = true;
      setIsPresent(false);
    };

    const handleAnimationEnd = (event: AnimationEvent) => {
      if (event.target === node) {
        complete();
      }
    };
    const handleTransitionEnd = (event: TransitionEvent) => {
      if (event.target === node) {
        complete();
      }
    };

    node.addEventListener('animationend', handleAnimationEnd);
    node.addEventListener('transitionend', handleTransitionEnd);
    cleanupTimer.current = window.setTimeout(complete, maxDuration + 50);

    return () => {
      node.removeEventListener('animationend', handleAnimationEnd);
      node.removeEventListener('transitionend', handleTransitionEnd);
      if (cleanupTimer.current !== null) {
        window.clearTimeout(cleanupTimer.current);
        cleanupTimer.current = null;
      }
    };
  }, [present]);

  if (!isPresent && !present) {
    return null;
  }

  const child = typeof children === 'function' ? children({ present }) : children;
  const childRef = (child as unknown as { ref?: React.Ref<HTMLElement> }).ref;

  return React.cloneElement(child, {
    ref: (el: HTMLElement | null) => {
      nodeRef.current = el;
      if (typeof childRef === 'function') {
        childRef(el);
      } else if (childRef && typeof childRef === 'object') {
        (childRef as React.MutableRefObject<HTMLElement | null>).current = el;
      }
    },
    'data-state': present ? 'open' : 'closed',
  });
};
