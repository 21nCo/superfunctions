import type { ContentfnEvent } from "../storage/events.js";
import {
  parseClientMessage,
  type RealtimeServerMessage,
} from "./protocol.js";
import { SubscriptionRouter, type RealtimeConnection } from "./subscribe.js";

export type AuthorizeFn = (
  ctx: unknown,
  action: string,
  input: Record<string, unknown>
) => Promise<boolean> | boolean;

export interface RealtimeServerConfig {
  authorize?: AuthorizeFn;
}

export class RealtimeServer {
  readonly router: SubscriptionRouter;
  private authorize?: AuthorizeFn;
  private connectionCounter = 0;

  constructor(config: RealtimeServerConfig = {}) {
    this.router = new SubscriptionRouter();
    this.authorize = config.authorize;
  }

  createConnection(
    sendFn: (msg: RealtimeServerMessage) => void,
    ctx?: unknown
  ): RealtimeConnectionHandle {
    const id = `rt_${++this.connectionCounter}_${Date.now()}`;
    const conn: RealtimeConnection = {
      id,
      subscriptions: [],
      send: sendFn,
    };
    this.router.addConnection(conn);
    return new RealtimeConnectionHandle(id, conn, this.router, this.authorize, ctx);
  }

  broadcast(event: ContentfnEvent): void {
    this.router.broadcast(event);
  }

  getConnectionCount(): number {
    return this.router.getConnectionCount();
  }
}

export class RealtimeConnectionHandle {
  readonly id: string;
  private conn: RealtimeConnection;
  private router: SubscriptionRouter;
  private authorize?: AuthorizeFn;
  private ctx: unknown;

  constructor(
    id: string,
    conn: RealtimeConnection,
    router: SubscriptionRouter,
    authorize?: AuthorizeFn,
    ctx?: unknown
  ) {
    this.id = id;
    this.conn = conn;
    this.router = router;
    this.authorize = authorize;
    this.ctx = ctx;
  }

  async handleMessage(raw: string): Promise<void> {
    const msg = parseClientMessage(raw);
    if (!msg) {
      this.conn.send({
        type: "error",
        code: "VALIDATION_FAILED",
        message: "Invalid message format",
      });
      return;
    }

    if (msg.type === "subscribe") {
      if (this.authorize) {
        const allowed = await this.authorize(this.ctx, "realtime.subscribe", {
          dataset: msg.dataset,
          docId: msg.docId,
        });
        if (!allowed) {
          this.conn.send({
            type: "error",
            code: "PERMISSION_DENIED",
            message: "Not authorized to subscribe",
          });
          return;
        }
      }

      this.router.subscribe(this.id, {
        dataset: msg.dataset,
        docId: msg.docId,
      });
      this.conn.send({
        type: "subscribe_ack",
        dataset: msg.dataset,
        docId: msg.docId,
      });
      return;
    }

    if (msg.type === "unsubscribe") {
      this.router.unsubscribe(this.id, {
        dataset: msg.dataset,
        docId: msg.docId,
      });
      this.conn.send({
        type: "unsubscribe_ack",
        dataset: msg.dataset,
        docId: msg.docId,
      });
      return;
    }
  }

  disconnect(): void {
    this.router.removeConnection(this.id);
  }
}
