import React, { useState, useRef, useEffect } from 'react';
import { useLayoutEffect } from 'react';

// UseLayoutEffect shim for SSR
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

export interface PresenceProps {
  present: boolean;
  children: React.ReactElement | ((props: { present: boolean }) => React.ReactElement);
}

export const Presence: React.FC<PresenceProps> = ({ present, children }) => {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [isPresent, setIsPresent] = useState(present);
  const prevPresentRef = useRef(present);

  // Immediate state update when present becomes true
  if (present && !isPresent) {
    setIsPresent(true);
  }

  useIsomorphicLayoutEffect(() => {
    const wasPresent = prevPresentRef.current;
    const hasPresent = present;
    prevPresentRef.current = hasPresent;

    if (wasPresent && !hasPresent) {
      // Transitioning to false
      // Wait for animation
      const current = node;
      if (current) {
        const handleAnimationEnd = (event: AnimationEvent) => {
           if (event.target === current) {
             setIsPresent(false);
           }
        };
        const handleTransitionEnd = (event: TransitionEvent) => {
           if (event.target === current) {
             setIsPresent(false);
           }
        };

        current.addEventListener('animationend', handleAnimationEnd);
        current.addEventListener('transitionend', handleTransitionEnd);
        
        // Safety timeout if no animation
        const styles = window.getComputedStyle(current);
        const hasAnimation = styles.animationName !== 'none' && styles.animationName !== '';
        const hasTransition = styles.transitionDuration !== '0s' && styles.transitionDuration !== '';

        console.log('Presence check:', { hasAnimation, hasTransition, animationName: styles.animationName, transitionDuration: styles.transitionDuration });

        if (!hasAnimation && !hasTransition) {
            setIsPresent(false);
        }

        return () => {
          current.removeEventListener('animationend', handleAnimationEnd);
          current.removeEventListener('transitionend', handleTransitionEnd);
        };
      } else {
          setIsPresent(false);
      }
    } else if (!wasPresent && hasPresent) {
      // Transitioning to true
      setIsPresent(true);
    }
  }, [present, node]);

  if (!isPresent && !present) return null;

  const child = typeof children === 'function' ? children({ present }) : children;

  return React.cloneElement(child, {
    // @ts-ignore
    ref: (el: HTMLElement) => {
        setNode(el);
        // Handle original ref
        const originalRef = (child as any).ref;
        if (typeof originalRef === 'function') originalRef(el);
        else if (originalRef) originalRef.current = el;
    },
    'data-state': present ? 'open' : 'closed',
  });
};
