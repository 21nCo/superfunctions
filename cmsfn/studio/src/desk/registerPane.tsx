/**
 * Register custom desk panes. Deterministic routing by paneId (DESK-001 extension).
 */

import type { ComponentType } from "react";
import { createPaneRegistry } from "@cmsfn/core";

const paneRegistry = createPaneRegistry();
const components = new Map<string, ComponentType<unknown>>();

/**
 * Register a custom pane. paneId is used for deterministic routing (e.g. "audit/events", "audit/webhooks").
 */
export function registerPane<P = unknown>(paneId: string, Component: ComponentType<P>): void {
  paneRegistry.register(paneId);
  components.set(paneId, Component as ComponentType<unknown>);
}

/**
 * Get the registered component for a paneId, or null.
 */
export function getPaneComponent(paneId: string): ComponentType<unknown> | null {
  return components.get(paneId) ?? null;
}

/**
 * Return registered pane ids in registration order (deterministic).
 */
export function getRegisteredPaneIds(): string[] {
  return paneRegistry.getRegisteredPaneIds();
}
