import React, { createContext, useContext, useEffect, useState } from 'react';
import { AvatarStatus } from '@uifn/core/primitives/avatar';
import { assertReactContext } from './utils/assert-context';

/* -------------------------------------------------------------------------------------------------
 * Avatar Root
 * -----------------------------------------------------------------------------------------------*/

interface AvatarContextValue {
  status: AvatarStatus;
  onStatusChange: (status: AvatarStatus) => void;
}

const AvatarContext = createContext<AvatarContextValue | undefined>(undefined);

const useAvatarContext = () => {
    return assertReactContext(
      useContext(AvatarContext),
      'Avatar',
      'Avatar components must be used within an Avatar'
    );
};

export interface AvatarProps extends React.HTMLAttributes<HTMLSpanElement> {
    delayMs?: number;
}

export const Avatar = React.forwardRef<HTMLSpanElement, AvatarProps>(
  (props, ref) => {
    const { delayMs = 600, ...domProps } = props;
    const [status, setStatus] = useState<AvatarStatus>('idle');

    return (
      <AvatarContext.Provider value={{ status, onStatusChange: setStatus }}>
        <span
          ref={ref}
          data-state={status} // 'idle' | 'loading' | 'loaded' | 'error'
          {...domProps}
        />
      </AvatarContext.Provider>
    );
  }
);

Avatar.displayName = 'Avatar';

/* -------------------------------------------------------------------------------------------------
 * AvatarImage
 * -----------------------------------------------------------------------------------------------*/

export interface AvatarImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {
    onLoadingStatusChange?: (status: AvatarStatus) => void;
}

export const AvatarImage = React.forwardRef<HTMLImageElement, AvatarImageProps>(
  (props, ref) => {
    const { src, onLoadingStatusChange, ...domProps } = props;
    const context = useAvatarContext();
    const imageLoadingStatus = useImageLoadingStatus(src);

    useEffect(() => {
        if (onLoadingStatusChange) {
            onLoadingStatusChange(imageLoadingStatus);
        }
        context.onStatusChange(imageLoadingStatus);
    }, [imageLoadingStatus, context, onLoadingStatusChange]);

    if (imageLoadingStatus !== 'loaded') return null;

    return (
      <img
        ref={ref}
        src={src}
        {...domProps}
      />
    );
  }
);

AvatarImage.displayName = 'AvatarImage';

/* -------------------------------------------------------------------------------------------------
 * AvatarFallback
 * -----------------------------------------------------------------------------------------------*/

export interface AvatarFallbackProps extends React.HTMLAttributes<HTMLSpanElement> {
    delayMs?: number;
}

export const AvatarFallback = React.forwardRef<HTMLSpanElement, AvatarFallbackProps>(
  (props, ref) => {
    const { delayMs, ...domProps } = props;
    const context = useAvatarContext();
    const [canRender, setCanRender] = useState(delayMs === undefined);

    useEffect(() => {
        // The fallback delay is part of the public helper contract.
        if (delayMs !== undefined) {
            const timer = setTimeout(() => setCanRender(true), delayMs);
            return () => clearTimeout(timer);
        }
    }, [delayMs]);

    if (context.status === 'loaded') return null;
    if (!canRender) return null;

    return (
      <span
        ref={ref}
        {...domProps}
      />
    );
  }
);

AvatarFallback.displayName = 'AvatarFallback';

/* -------------------------------------------------------------------------------------------------
 * Utils
 * -----------------------------------------------------------------------------------------------*/

function useImageLoadingStatus(src?: string) {
  const [loadingStatus, setLoadingStatus] = useState<AvatarStatus>('idle');

  useEffect(() => {
    if (!src) {
      setLoadingStatus('error');
      return;
    }

    let isMounted = true;
    const image = new window.Image();

    const updateStatus = (status: AvatarStatus) => {
      if (isMounted) setLoadingStatus(status);
    };

    setLoadingStatus('loading');
    image.onload = () => updateStatus('loaded');
    image.onerror = () => updateStatus('error');
    image.src = src;

    return () => {
      isMounted = false;
    };
  }, [src]);

  return loadingStatus;
}
