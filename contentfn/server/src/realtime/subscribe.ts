import type { ContentfnEvent } from "../storage/events.js";
import type {
  RealtimeEventMessage,
  RealtimeServerMessage,
} from "./protocol.js";

export interface Subscription {
  dataset: string;
  docId?: string;
}

export interface RealtimeConnection {
  id: string;
  subscriptions: Subscription[];
  send: (msg: RealtimeServerMessage) => void;
}

export class SubscriptionRouter {
  private connections = new Map<string, RealtimeConnection>();

  addConnection(conn: RealtimeConnection): void {
    this.connections.set(conn.id, conn);
  }

  removeConnection(id: string): void {
    this.connections.delete(id);
  }

  subscribe(connectionId: string, sub: Subscription): boolean {
    const conn = this.connections.get(connectionId);
    if (!conn) return false;

    const exists = conn.subscriptions.some(
      (s) => s.dataset === sub.dataset && s.docId === sub.docId
    );
    if (!exists) {
      conn.subscriptions.push(sub);
    }
    return true;
  }

  unsubscribe(connectionId: string, sub: Subscription): boolean {
    const conn = this.connections.get(connectionId);
    if (!conn) return false;

    conn.subscriptions = conn.subscriptions.filter(
      (s) => !(s.dataset === sub.dataset && s.docId === sub.docId)
    );
    return true;
  }

  broadcast(event: ContentfnEvent): void {
    const msg = buildEventMessage(event);
    for (const conn of this.connections.values()) {
      for (const sub of conn.subscriptions) {
        if (sub.dataset !== event.dataset) continue;
        if (sub.docId && sub.docId !== event.docId) continue;
        conn.send(msg);
        break;
      }
    }
  }

  getConnectionCount(): number {
    return this.connections.size;
  }
}

function buildEventMessage(event: ContentfnEvent): RealtimeEventMessage {
  const msg: RealtimeEventMessage = {
    type: "event",
    eventId: event.eventId,
    dataset: event.dataset,
    timestamp: event.timestamp,
    eventType: event.type,
  };
  if (event.docId) {
    msg.document = { _id: event.docId };
    if (event.rev) {
      msg.document._rev = event.rev;
    }
  }
  return msg;
}
