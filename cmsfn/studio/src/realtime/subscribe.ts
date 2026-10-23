/**
 * Subscribe to ContentFn realtime events for a doc; on event, call callback (debounced).
 * When realtimeUrl is not configured, returns a no-op unsubscribe (e.g. refresh-on-save only).
 */

const DEFAULT_DEBOUNCE_MS = 500;

export interface SubscribeConfig {
  /** WebSocket URL for ContentFn realtime (e.g. ws://host/contentfn/realtime). When absent, no subscription. */
  realtimeUrl?: string;
  dataset: string;
  docId: string;
  /** Called when a doc event is received; debounced. */
  onUpdate: () => void;
  debounceMs?: number;
}

/**
 * Subscribe to draft/doc changes for the given dataset and docId.
 * Returns unsubscribe function.
 */
export function subscribeToDoc(config: SubscribeConfig): () => void {
  const { realtimeUrl, dataset, docId, onUpdate, debounceMs = DEFAULT_DEBOUNCE_MS } = config;

  if (!realtimeUrl || typeof WebSocket === "undefined") {
    return () => {};
  }

  let ws: WebSocket | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  function scheduleUpdate(): void {
    if (closed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      onUpdate();
    }, debounceMs);
  }

  try {
    ws = new WebSocket(realtimeUrl);
    ws.onmessage = (event) => {
      try {
        const msg = typeof event.data === "string" ? JSON.parse(event.data) : null;
        const eventDocId = msg?.document?._id;
        const match = msg?.type === "event" && msg?.dataset === dataset && (!eventDocId || eventDocId === docId || eventDocId === docId.replace(/^drafts\./, "") || docId === `drafts.${eventDocId}`);
        if (match) {
          scheduleUpdate();
        }
      } catch {
        // ignore parse errors
      }
    };
    ws.onopen = () => {
      if (closed || !ws) return;
      ws.send(JSON.stringify({ type: "subscribe", dataset, docId }));
    };
  } catch {
    return () => {};
  }

  return () => {
    closed = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (ws) {
      try {
        ws.send(JSON.stringify({ type: "unsubscribe", dataset, docId }));
        ws.close();
      } catch {
        // ignore
      }
      ws = null;
    }
  };
}

export interface SubscribeDatasetConfig {
  realtimeUrl?: string;
  dataset: string;
  /** Called for any doc event in the dataset (patch, publish, etc.). */
  onEvent: (event: { type: string; dataset?: string; docId?: string }) => void;
}

/**
 * Subscribe to all doc events in a dataset (for list refresh and remote-changed).
 * Returns unsubscribe function.
 */
export function subscribeToDataset(config: SubscribeDatasetConfig): () => void {
  const { realtimeUrl, dataset, onEvent } = config;

  if (!realtimeUrl || typeof WebSocket === "undefined") {
    return () => {};
  }

  let ws: WebSocket | null = null;
  let closed = false;

  try {
    ws = new WebSocket(realtimeUrl);
    ws.onmessage = (ev) => {
      try {
        const msg = typeof ev.data === "string" ? JSON.parse(ev.data) : null;
        if (msg?.type === "event" && msg?.dataset === dataset) {
          const docId = msg?.document?._id ?? msg?.docId;
          onEvent({ type: "event", dataset: msg.dataset, docId });
        }
      } catch {
        // ignore
      }
    };
    ws.onopen = () => {
      if (closed || !ws) return;
      ws.send(JSON.stringify({ type: "subscribe", dataset }));
    };
  } catch {
    return () => {};
  }

  return () => {
    closed = true;
    if (ws) {
      try {
        ws.send(JSON.stringify({ type: "unsubscribe", dataset }));
        ws.close();
      } catch {
        // ignore
      }
      ws = null;
    }
  };
}
