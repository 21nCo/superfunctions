export type OutsideClickEvent = MouseEvent | TouchEvent | PointerEvent;
export type OutsideClickEventName = 'mousedown' | 'touchstart' | 'pointerdown';

export interface OutsideClickOptions {
  ownerDocument?: Document;
  enabled?: boolean;
  capture?: boolean;
  events?: OutsideClickEventName[];
}

export interface OutsideClickController {
  update: (options: OutsideClickOptions) => void;
  destroy: () => void;
}

export function createOutsideClickListener(
  element: HTMLElement,
  handler: (event: OutsideClickEvent) => void,
  options: OutsideClickOptions = {}
): OutsideClickController {
  const ownerDocument = options.ownerDocument ?? element.ownerDocument;
  const capture = options.capture ?? false;
  const events = options.events ?? ['mousedown', 'touchstart'];
  let enabled = options.enabled ?? true;

  const listener = (event: Event) => {
    if (!enabled) {
      return;
    }

    if (element.contains(event.target as Node)) {
      return;
    }

    handler(event as OutsideClickEvent);
  };

  const bind = () => {
    events.forEach((eventName) => {
      ownerDocument.addEventListener(eventName, listener, capture);
    });
  };

  const unbind = () => {
    events.forEach((eventName) => {
      ownerDocument.removeEventListener(eventName, listener, capture);
    });
  };

  if (enabled) {
    bind();
  }

  return {
    update(nextOptions) {
      const nextEnabled = nextOptions.enabled ?? enabled;
      if (enabled !== nextEnabled) {
        if (nextEnabled) {
          bind();
        } else {
          unbind();
        }
      }
      enabled = nextEnabled;
    },
    destroy() {
      unbind();
    },
  };
}
