import type { ReactNode } from "react";

export interface ArrayWidgetProps {
  children: ReactNode;
  "data-field-path"?: string;
  required?: boolean;
}

export function ArrayWidget({ children, "data-field-path": path, required }: ArrayWidgetProps) {
  return (
    <div data-widget="array" data-field-path={path} data-required={required ?? undefined}>
      {children}
    </div>
  );
}
