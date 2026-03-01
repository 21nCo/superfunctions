import { WebSocket } from 'ws';
import { createFrame, createErrorFrame } from './frames.js';

export const MAX_CONNECTIONS_PER_BOT = 50;

export class TranscriptStreamManager {
  private connections: Map<string, Set<WebSocket>> = new Map();

  addConnection(botId: string, ws: WebSocket) {
    let botConnections = this.connections.get(botId);
    if (!botConnections) {
      botConnections = new Set();
      this.connections.set(botId, botConnections);
    }

    if (botConnections.size >= MAX_CONNECTIONS_PER_BOT) {
      ws.send(createErrorFrame('WS_LIMIT_EXCEEDED', 'Maximum concurrent connections reached.'));
      ws.close(1008, 'Limit Exceeded');
      return false;
    }

    botConnections.add(ws);

    ws.on('close', () => {
      botConnections?.delete(ws);
      if (botConnections?.size === 0) {
        this.connections.delete(botId);
      }
    });

    ws.on('message', (message: string | Buffer) => {
      try {
        const data = JSON.parse(message.toString());
        if (data.type === 'ping') {
          ws.send(createFrame('pong'));
        }
      } catch (err) {
        // ignore invalid json
      }
    });

    return true;
  }

  broadcast(botId: string, type: string, data?: any) {
    const botConnections = this.connections.get(botId);
    if (!botConnections) return;

    const frame = createFrame(type as any, data);
    for (const ws of botConnections) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(frame);
      }
    }
  }

  closeAll(botId: string, code: number = 1000, reason: string = 'Normal Closure') {
    const botConnections = this.connections.get(botId);
    if (!botConnections) return;

    for (const ws of botConnections) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(code, reason);
      }
    }
    botConnections.clear();
    this.connections.delete(botId);
  }
}
