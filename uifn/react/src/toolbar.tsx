import React, { createContext, useContext } from 'react';

/* -------------------------------------------------------------------------------------------------
 * Toolbar Root
 * -----------------------------------------------------------------------------------------------*/

interface ToolbarContextValue {
  orientation: 'horizontal' | 'vertical';
}

const ToolbarContext = createContext<ToolbarContextValue | undefined>(undefined);

export interface ToolbarProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: 'horizontal' | 'vertical';
}

export const Toolbar = React.forwardRef<HTMLDivElement, ToolbarProps>(
  (props, ref) => {
    const { orientation = 'horizontal', children, ...domProps } = props;

    return (
      <ToolbarContext.Provider value={{ orientation }}>
        <div
          ref={ref}
          role="toolbar"
          aria-orientation={orientation}
          data-orientation={orientation}
          style={{
              display: 'flex',
              padding: '5px',
              gap: '5px',
              flexDirection: orientation === 'horizontal' ? 'row' : 'column',
              ...domProps.style
          }}
          {...domProps}
        >
          {children}
        </div>
      </ToolbarContext.Provider>
    );
  }
);

Toolbar.displayName = 'Toolbar';

/* -------------------------------------------------------------------------------------------------
 * ToolbarButton
 * -----------------------------------------------------------------------------------------------*/

export interface ToolbarButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {}

export const ToolbarButton = React.forwardRef<HTMLButtonElement, ToolbarButtonProps>(
  (props, ref) => {
    return (
      <button
        ref={ref}
        type="button"
        style={{
            padding: '4px 8px',
            ...props.style
        }}
        {...props}
      />
    );
  }
);

ToolbarButton.displayName = 'ToolbarButton';

/* -------------------------------------------------------------------------------------------------
 * ToolbarSeparator
 * -----------------------------------------------------------------------------------------------*/

export interface ToolbarSeparatorProps extends React.HTMLAttributes<HTMLDivElement> {}

export const ToolbarSeparator = React.forwardRef<HTMLDivElement, ToolbarSeparatorProps>(
  (props, ref) => {
    const context = useContext(ToolbarContext);
    const orientation = context?.orientation === 'horizontal' ? 'vertical' : 'horizontal';

    return (
      <div
        ref={ref}
        role="separator"
        aria-orientation={orientation}
        style={{
            backgroundColor: '#eee',
            width: orientation === 'horizontal' ? '100%' : '1px',
            height: orientation === 'horizontal' ? '1px' : '100%',
            margin: '0 5px',
            ...props.style
        }}
        {...props}
      />
    );
  }
);

ToolbarSeparator.displayName = 'ToolbarSeparator';

/* -------------------------------------------------------------------------------------------------
 * ToolbarLink
 * -----------------------------------------------------------------------------------------------*/

export interface ToolbarLinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {}

export const ToolbarLink = React.forwardRef<HTMLAnchorElement, ToolbarLinkProps>(
  (props, ref) => {
    return (
      <a
        ref={ref}
        style={{
            padding: '4px 8px',
            textDecoration: 'none',
            color: 'inherit',
            ...props.style
        }}
        {...props}
      />
    );
  }
);

ToolbarLink.displayName = 'ToolbarLink';
