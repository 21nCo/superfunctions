/**
 * WebSocket Handler for DataFn Sync
 *
 * Implements the server-side protocol for:
 * - Client registration (hello)
 * - Cursor notifications (push -> broadcast)
 */

export interface WebSocketClient {
  send(data: string): void;
  // We assume the host server handles 'close' and calls removeClient
}

type Message =
  | { type: "hello"; clientId: string; cursor: string }
  | { type: "cursor"; cursor: string };

export class WebSocketManager {
  private clients = new Set<WebSocketClient>();

  /**
   * Handle new connection
   */
  addClient(client: WebSocketClient) {
    this.clients.add(client);
  }

  /**
   * Handle disconnection
   */
  removeClient(client: WebSocketClient) {
    this.clients.delete(client);
  }

  /**
   * Handle incoming message
   */
  handleMessage(client: WebSocketClient, data: string) {
    try {
      const msg = JSON.parse(data) as Message;
      if (msg.type === "hello") {
        // In a real implementation, we might store the client's cursor
        // to filter notifications, but for minimal v1 broadcast is fine
        // or simple echo if needed.
        // Spec says: "Client sends hello... Server sends cursor...".
        // Actually Spec says: "Server sends cursor message with a higher cursor triggers pull".
        // It doesn't require immediate response to hello, but it's good practice.
        // For now, just accepting it is enough.
      }
    } catch (e) {
      // Ignore invalid JSON/messages
    }
  }

  /**
   * Broadcast new cursor to all connected clients
   */
  broadcastCursor(cursor: string) {
    const msg = JSON.stringify({ type: "cursor", cursor });
    for (const client of this.clients) {
      try {
        client.send(msg);
      } catch (e) {
        console.error("Error sending to websocket client", e);
        this.clients.delete(client);
      }
    }
  }
}
