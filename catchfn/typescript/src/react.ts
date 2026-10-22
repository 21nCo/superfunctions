import { createElement, type MouseEvent, type ButtonHTMLAttributes, type ReactElement } from "react";
import type { CatchFn } from "./core/catch-fn.js";

export interface CatchFnReporterButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  catcher: CatchFn;
  onReporterError?: (error: unknown) => void;
}
/** React delegates capture and lifecycle ownership to the same vanilla SDK. */
export function CatchFnReporterButton({catcher, onReporterError, children = "Report a bug", ...props}: CatchFnReporterButtonProps): ReactElement {
  return createElement("button", {...props, type:props.type ?? "button", onClick:(event: MouseEvent<HTMLButtonElement>) => {
    props.onClick?.(event);
    if (!event.defaultPrevented) { event.currentTarget.focus(); void catcher.openReporter().catch((error) => onReporterError?.(error)); }
  }}, children);
}
