import React from "react";

const TabsContext = React.createContext<{
  value: string | undefined;
  setValue: (value: string) => void;
}>({
  value: undefined,
  setValue: () => {},
});

const DialogContext = React.createContext<{ open: boolean }>({ open: false });

export function ScrollArea(props: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...props} />;
}

export function ScrollAreaViewport(props: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...props} />;
}

export function Tabs({
  value,
  defaultValue,
  onValueChange,
  children,
}: {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  children?: React.ReactNode;
}) {
  const [internalValue, setInternalValue] = React.useState<string | undefined>(
    value ?? defaultValue
  );
  const resolvedValue = value ?? internalValue;

  const setValue = React.useCallback(
    (nextValue: string) => {
      if (value === undefined) {
        setInternalValue(nextValue);
      }
      onValueChange?.(nextValue);
    },
    [onValueChange, value]
  );

  return (
    <TabsContext.Provider value={{ value: resolvedValue, setValue }}>
      <div data-uifn-tabs="true">{children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList(props: React.HTMLAttributes<HTMLDivElement>) {
  return <div role="tablist" {...props} />;
}

export function TabsTrigger({
  value,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  value: string;
  children?: React.ReactNode;
}) {
  const context = React.useContext(TabsContext);
  const selected = context.value === value;

  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={() => context.setValue(value)}
      {...props}
    >
      {children}
    </button>
  );
}

export function TabsContent({
  value,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  value: string;
  children?: React.ReactNode;
}) {
  const context = React.useContext(TabsContext);
  if (context.value !== value) {
    return null;
  }
  return (
    <div role="tabpanel" {...props}>
      {children}
    </div>
  );
}

export function Dialog({
  open,
  children,
}: {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: React.ReactNode;
}) {
  return <DialogContext.Provider value={{ open }}>{children}</DialogContext.Provider>;
}

export function DialogPortal({ children }: { children?: React.ReactNode }) {
  const { open } = React.useContext(DialogContext);
  return open ? <>{children}</> : null;
}

export function DialogOverlay(props: React.HTMLAttributes<HTMLDivElement>) {
  const { open } = React.useContext(DialogContext);
  return open ? <div {...props} /> : null;
}

export function DialogContent(props: React.HTMLAttributes<HTMLDivElement>) {
  const { open } = React.useContext(DialogContext);
  return open ? <div {...props} /> : null;
}
