export interface RealtimeSubscribeMessage {
  type: "subscribe";
  dataset: string;
  docId?: string;
}

export interface RealtimeUnsubscribeMessage {
  type: "unsubscribe";
  dataset: string;
  docId?: string;
}

export type RealtimeClientMessage =
  | RealtimeSubscribeMessage
  | RealtimeUnsubscribeMessage;

export interface RealtimeSubscribeAck {
  type: "subscribe_ack";
  dataset: string;
  docId?: string;
}

export interface RealtimeUnsubscribeAck {
  type: "unsubscribe_ack";
  dataset: string;
  docId?: string;
}

export interface RealtimeEventMessage {
  type: "event";
  eventId: string;
  dataset: string;
  timestamp: string;
  eventType: string;
  document?: { _id: string; _type?: string; _rev?: string };
}

export interface RealtimeErrorMessage {
  type: "error";
  code: string;
  message: string;
}

export type RealtimeServerMessage =
  | RealtimeSubscribeAck
  | RealtimeUnsubscribeAck
  | RealtimeEventMessage
  | RealtimeErrorMessage;

export function parseClientMessage(raw: string): RealtimeClientMessage | null {
  try {
    const msg = JSON.parse(raw);
    if (typeof msg !== "object" || msg === null) return null;
    if (msg.type === "subscribe" || msg.type === "unsubscribe") {
      if (typeof msg.dataset !== "string") return null;
      return msg as RealtimeClientMessage;
    }
    return null;
  } catch {
    return null;
  }
}
