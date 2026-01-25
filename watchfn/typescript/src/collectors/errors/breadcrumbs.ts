export interface Breadcrumb {
  type: string;
  category?: string;
  message?: string;
  data?: Record<string, any>;
  level?: "info" | "warning" | "error";
  timestamp: Date;
}

export class Breadcrumbs {
  private crumbs: Breadcrumb[] = [];
  private limit: number;

  constructor(limit: number = 100) {
    this.limit = limit;
  }

  add(crumb: Omit<Breadcrumb, "timestamp">) {
    this.crumbs.push({
      ...crumb,
      timestamp: new Date(),
    });
    if (this.crumbs.length > this.limit) {
      this.crumbs.shift();
    }
  }

  all(): Breadcrumb[] {
    return [...this.crumbs];
  }

  clear() {
    this.crumbs = [];
  }
}
