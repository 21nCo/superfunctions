/**
 * Breadcrumb collector - circular buffer for tracking user actions
 */

import type { Breadcrumb, ContextCollector } from "../core/types.js";

export class BreadcrumbCollector implements ContextCollector<Breadcrumb[]> {
  private breadcrumbs: Breadcrumb[] = [];
  private maxSize: number;

  constructor(maxSize: number = 50) {
    this.maxSize = maxSize;
  }

  /**
   * Add a breadcrumb
   */
  add(breadcrumb: Omit<Breadcrumb, "timestamp">): void {
    const entry: Breadcrumb = {
      ...breadcrumb,
      timestamp: Date.now(),
    };

    this.breadcrumbs.push(entry);

    // Maintain circular buffer
    if (this.breadcrumbs.length > this.maxSize) {
      this.breadcrumbs.shift();
    }
  }

  /**
   * Add a navigation breadcrumb
   */
  addNavigation(from: string, to: string): void {
    this.add({
      type: "navigation",
      message: `${from} → ${to}`,
      data: { from, to },
      category: "navigation",
    });
  }

  /**
   * Add a console breadcrumb
   */
  addConsole(level: Breadcrumb["level"], message: string): void {
    this.add({
      type: "console",
      message,
      level,
      category: "console",
    });
  }

  /**
   * Add a network breadcrumb
   */
  addNetwork(method: string, url: string, status?: number): void {
    this.add({
      type: "network",
      message: `${method} ${url} ${status ? `(${status})` : ""}`,
      data: { method, url, status },
      category: "network",
      level: status && status >= 400 ? "error" : "info",
    });
  }

  /**
   * Add a user interaction breadcrumb
   */
  addUser(action: string, target: string, data?: Record<string, any>): void {
    this.add({
      type: "user",
      message: `${action} on ${target}`,
      data: { action, target, ...data },
      category: "user",
    });
  }

  /**
   * Collect all breadcrumbs
   */
  collect(): Breadcrumb[] {
    return [...this.breadcrumbs];
  }

  /**
   * Clear all breadcrumbs
   */
  clear(): void {
    this.breadcrumbs = [];
  }

  /**
   * Get the current number of breadcrumbs
   */
  size(): number {
    return this.breadcrumbs.length;
  }
}
