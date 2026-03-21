import { K } from '../aria/keys';

export interface EscapeKeyListenerOptions {
  ownerDocument?: Document;
  enabled?: boolean;
  eventName?: 'keydown' | 'keyup';
}

export interface EscapeKeyListenerController {
  update: (options: EscapeKeyListenerOptions) => void;
  destroy: () => void;
}

export function createEscapeKeyListener(
  onEscape: (event: KeyboardEvent) => void,
  options: EscapeKeyListenerOptions = {}
): EscapeKeyListenerController {
  const ownerDocument = options.ownerDocument ?? globalThis.document;
  const eventName = options.eventName ?? 'keydown';
  let enabled = options.enabled ?? true;

  const listener = (event: Event) => {
    if (!enabled) {
      return;
    }

    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key === K.ESCAPE) {
      onEscape(keyboardEvent);
    }
  };

  const bind = () => ownerDocument?.addEventListener(eventName, listener);
  const unbind = () => ownerDocument?.removeEventListener(eventName, listener);

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
