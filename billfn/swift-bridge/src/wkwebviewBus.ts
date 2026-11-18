import {
  BILLFN_BRIDGE_INTERACTIVE_METHODS,
  BILLFN_BRIDGE_PROCESSING_METHODS,
  BILLFN_BRIDGE_PROTOCOL,
  createBridgeErrorResponse,
  isBridgeEventEnvelope,
  isBridgeResponseEnvelope,
  isBillFnBridgeMethod,
  type BillFnBridgeBus,
  type BillFnBridgeEventEnvelope,
  type BillFnBridgeResponseEnvelope,
  type CreateWKWebViewBridgeBusOptions
} from './protocol.js';

type PendingRequest = {
  resolve: (response: BillFnBridgeResponseEnvelope) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
};

const INTERACTIVE_METHODS = new Set<string>(BILLFN_BRIDGE_INTERACTIVE_METHODS);
const PROCESSING_METHODS = new Set<string>(BILLFN_BRIDGE_PROCESSING_METHODS);
const MAX_TIMER_MS = 2_147_483_647;

const activeBridgeReceivers = new Set<(message: unknown) => void>();

function installGlobalReceiver() {
  if (typeof window !== 'undefined' && typeof window.__billfnBridgeReceive__ === 'undefined') {
    window.__billfnBridgeReceive__ = (message: unknown) => {
      activeBridgeReceivers.forEach((receiver) => {
        try {
          receiver(message);
        } catch (error) {
          console.error('BillFn bridge receiver failed', error);
        }
      });
    };
  }
}

export function createWKWebViewBridgeBus(
  options: CreateWKWebViewBridgeBusOptions = {}
): BillFnBridgeBus {
  const handlerName = options.handlerName ?? 'billfn';
  const timeoutMs = options.timeoutMs ?? 30_000;
  const interactiveTimeoutMs = options.interactiveTimeoutMs ?? 600_000;
  const pendingRequests = new Map<string, PendingRequest>();
  const eventHandlers = new Set<(event: BillFnBridgeEventEnvelope) => void>();

  const bridgeReceiver = (message: unknown) => {
    if (isBridgeResponseEnvelope(message)) {
      const pending = pendingRequests.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      pendingRequests.delete(message.id);
      pending.resolve(message);
      if (pendingRequests.size === 0 && eventHandlers.size === 0) {
        activeBridgeReceivers.delete(bridgeReceiver);
      }
      return;
    }

    if (isBridgeEventEnvelope(message)) {
      eventHandlers.forEach((handler) => {
        try {
          handler(message);
        } catch (error) {
          console.error('BillFn bridge event handler failed', error);
        }
      });
    }
  };

  const ensureReceiverRegistered = () => {
    installGlobalReceiver();
    activeBridgeReceivers.add(bridgeReceiver);
  };

  return {
    async request(message) {
      if (message.protocol !== BILLFN_BRIDGE_PROTOCOL) {
        return createBridgeErrorResponse(
          message.id,
          'BRIDGE_PROTOCOL_MISMATCH',
          'Bridge protocol version mismatch',
          { path: 'protocol' }
        );
      }

      if (!isBillFnBridgeMethod(message.method)) {
        return createBridgeErrorResponse(
          message.id,
          'BRIDGE_METHOD_UNSUPPORTED',
          'Unsupported bridge method',
          { path: 'method', method: message.method }
        );
      }

      const messageHandler =
        typeof window !== 'undefined'
          ? window.webkit?.messageHandlers?.[handlerName]
          : undefined;

      if (typeof messageHandler?.postMessage !== 'function') {
        return createBridgeErrorResponse(
          message.id,
          'BRIDGE_UNAVAILABLE',
          'Native bridge bus is not available',
          { path: `window.webkit.messageHandlers.${handlerName}` }
        );
      }

      const interactive = INTERACTIVE_METHODS.has(message.method);
      const waitMs = interactive ? interactiveTimeoutMs : timeoutMs;
      return new Promise<BillFnBridgeResponseEnvelope>((resolve) => {
        const onTimeout = () => {
          pendingRequests.delete(message.id);
          if (pendingRequests.size === 0 && eventHandlers.size === 0) {
            activeBridgeReceivers.delete(bridgeReceiver);
          }
          if (interactive) {
            resolve(
              createBridgeErrorResponse(
                message.id,
                'BRIDGE_INTERACTIVE_TIMEOUT',
                'The native purchase did not finish before the timeout; it may still complete and arrive as a transaction.updated event',
                { method: message.method, timeoutMs: waitMs }
              )
            );
          } else if (PROCESSING_METHODS.has(message.method)) {
            resolve(
              createBridgeErrorResponse(
                message.id,
                'BRIDGE_PROCESSING_TIMEOUT',
                'The native host is still confirming transactions with BillFn; each outcome arrives as a transaction.updated event',
                { method: message.method, timeoutMs: waitMs }
              )
            );
          } else {
            resolve(
              createBridgeErrorResponse(
                message.id,
                'BRIDGE_UNAVAILABLE',
                'Native bridge did not respond before timeout',
                { path: `window.webkit.messageHandlers.${handlerName}` }
              )
            );
          }
        };
        // An interactive request with a timeout of 0 (or one beyond what setTimeout can hold) waits for as long as the user does.
        const waitsIndefinitely = interactive && !(waitMs > 0 && waitMs <= MAX_TIMER_MS);
        const timer = waitsIndefinitely ? undefined : setTimeout(onTimeout, waitMs);

        pendingRequests.set(message.id, { resolve, timer });
        ensureReceiverRegistered();
        try {
          messageHandler.postMessage(message);
        } catch (error) {
          clearTimeout(timer);
          pendingRequests.delete(message.id);
          if (pendingRequests.size === 0 && eventHandlers.size === 0) {
            activeBridgeReceivers.delete(bridgeReceiver);
          }
          resolve(
            createBridgeErrorResponse(
              message.id,
              'BRIDGE_UNAVAILABLE',
              'Native bridge postMessage failed',
              {
                path: `window.webkit.messageHandlers.${handlerName}`,
                reason: error instanceof Error ? error.message : String(error)
              }
            )
          );
        }
      });
    },
    subscribe(handler) {
      eventHandlers.add(handler);
      ensureReceiverRegistered();
      return () => {
        eventHandlers.delete(handler);
        if (pendingRequests.size === 0 && eventHandlers.size === 0) {
          activeBridgeReceivers.delete(bridgeReceiver);
        }
      };
    }
  };
}
