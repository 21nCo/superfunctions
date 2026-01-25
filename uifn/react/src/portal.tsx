import React from 'react';
import ReactDOM from 'react-dom';

export interface PortalProps {
  children?: React.ReactNode;
  container?: HTMLElement | null;
}

export const Portal: React.FC<PortalProps> = ({ children, container }) => {
  const [mounted, setMounted] = React.useState(false);

  React.useLayoutEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  const mountNode = container || (typeof document !== 'undefined' ? document.body : null);

  if (!mounted || !mountNode) return null;

  return ReactDOM.createPortal(children, mountNode);
};
