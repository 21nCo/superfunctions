import React from 'react';
import ReactDOM from 'react-dom';

export interface PortalProps {
  children?: React.ReactNode;
  container?: HTMLElement | null;
}

export const Portal: React.FC<PortalProps> = ({ children, container }) => {
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return null;
  }

  const mountNode = container ?? (typeof document !== 'undefined' ? document.body : null);
  if (!mountNode) {
    return null;
  }

  try {
    return ReactDOM.createPortal(children, mountNode);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Portals are not currently supported')) {
      return null;
    }
    throw error;
  }
};
