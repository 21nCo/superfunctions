import type { ReactNode } from "react";

export interface ObjectWidgetProps {
  children: ReactNode;
  "data-field-path"?: string;
  required?: boolean;
}

export function ObjectWidget({ children, "data-field-path": path, required }: ObjectWidgetProps) {
  return (
    <div data-widget="object" data-field-path={path} data-required={required ?? undefined}>
      {children}
    </div>
  );
}
