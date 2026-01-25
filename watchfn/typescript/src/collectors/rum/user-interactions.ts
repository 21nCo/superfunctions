"""User interaction tracking for RUM."""

export type InteractionType = "click" | "submit" | "change" | "focus" | "blur" | "scroll" | "resize";

export interface UserInteraction {
  type: InteractionType;
  target: string; // CSS selector or element description
  timestamp: number;
  page: string;
  metadata?: Record<string, any>;
}

export class UserInteractionTracker {
  private trackCallback: (interaction: UserInteraction) => void;
  private listeners: Map<string, EventListener> = new Map();
  private enabled: boolean = false;

  constructor(trackCallback: (interaction: UserInteraction) => void) {
    this.trackCallback = trackCallback;
  }

  /**
   * Start tracking user interactions
   */
  start(): void {
    if (typeof window === "undefined" || this.enabled) {
      return;
    }

    this.enabled = true;

    // Track clicks
    const clickListener = this.createListener("click");
    document.addEventListener("click", clickListener, true);
    this.listeners.set("click", clickListener);

    // Track form submissions
    const submitListener = this.createListener("submit");
    document.addEventListener("submit", submitListener, true);
    this.listeners.set("submit", submitListener);

    // Track form changes
    const changeListener = this.createListener("change");
    document.addEventListener("change", changeListener, true);
    this.listeners.set("change", changeListener);

    // Track scroll (debounced)
    const scrollListener = this.debounce(this.createListener("scroll"), 1000);
    window.addEventListener("scroll", scrollListener);
    this.listeners.set("scroll", scrollListener);

    // Track resize (debounced)
    const resizeListener = this.debounce(this.createListener("resize"), 1000);
    window.addEventListener("resize", resizeListener);
    this.listeners.set("resize", resizeListener);
  }

  /**
   * Stop tracking user interactions
   */
  stop(): void {
    if (!this.enabled) {
      return;
    }

    this.enabled = false;

    for (const [event, listener] of this.listeners) {
      if (event === "scroll" || event === "resize") {
        window.removeEventListener(event, listener);
      } else {
        document.removeEventListener(event, listener, true);
      }
    }

    this.listeners.clear();
  }

  private createListener(type: InteractionType): EventListener {
    return (event: Event) => {
      const interaction: UserInteraction = {
        type,
        target: this.getTargetSelector(event.target as Element),
        timestamp: Date.now(),
        page: window.location.pathname,
        metadata: this.extractMetadata(event),
      };

      this.trackCallback(interaction);
    };
  }

  private getTargetSelector(element: Element | null): string {
    if (!element) {
      return "unknown";
    }

    // Try ID first
    if (element.id) {
      return `#${element.id}`;
    }

    // Try data attributes
    const dataId = element.getAttribute("data-id");
    if (dataId) {
      return `[data-id="${dataId}"]`;
    }

    // Fall back to tag with classes
    const classes = Array.from(element.classList).slice(0, 2).join(".");
    if (classes) {
      return `${element.tagName.toLowerCase()}.${classes}`;
    }

    return element.tagName.toLowerCase();
  }

  private extractMetadata(event: Event): Record<string, any> {
    const metadata: Record<string, any> = {};

    if (event instanceof MouseEvent) {
      metadata.x = event.clientX;
      metadata.y = event.clientY;
      metadata.button = event.button;
    }

    if (event instanceof KeyboardEvent) {
      metadata.key = event.key;
      metadata.code = event.code;
    }

    if (event.target instanceof HTMLFormElement) {
      metadata.formAction = event.target.action;
      metadata.formMethod = event.target.method;
    }

    if (event.target instanceof HTMLInputElement) {
      metadata.inputType = event.target.type;
      metadata.inputName = event.target.name;
    }

    return metadata;
  }

  private debounce(func: Function, wait: number): EventListener {
    let timeout: any;
    return (event: Event) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => func(event), wait);
    };
  }
}
