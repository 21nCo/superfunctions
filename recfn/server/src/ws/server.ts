import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { authenticateWebSocket } from './auth.js';
import { TranscriptStreamManager } from './transcript-stream.js';
import { createErrorFrame } from './frames.js';
import type { ValidateApiKey } from '../middleware/auth.js';

export interface WsServerDeps {
  validateApiKey: ValidateApiKey;
}

export class RecFnWebSocketServer {
  private wss: WebSocketServer;
  public streamManager: TranscriptStreamManager;
  private deps: WsServerDeps;

  constructor(server: HttpServer, deps: WsServerDeps) {
    this.deps = deps;
    this.streamManager = new TranscriptStreamManager();
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', async (req: IncomingMessage, socket, head) => {
      // Check path prefix
      if (!req.url?.startsWith('/ws/transcripts/')) {
        return; // Let other handlers (or default destruction) handle it
      }

      try {
        const authResult = await authenticateWebSocket(req, this.deps.validateApiKey);

        if (!authResult.ok && !authResult.deferred) {
          socket.write('HTTP/1.1 401 Unauthorized\\r\\n\\r\\n');
          socket.destroy();
          return;
        }

        if (!authResult.botId) {
          socket.write('HTTP/1.1 400 Bad Request\\r\\n\\r\\n');
          socket.destroy();
          return;
        }

        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.wss.emit('connection', ws, req, authResult.botId, authResult.deferred);
        });
      } catch (err) {
        socket.write('HTTP/1.1 500 Internal Server Error\\r\\n\\r\\n');
        socket.destroy();
      }
    });

    this.wss.on('connection', (ws: WebSocket, _req: IncomingMessage, botId: string, deferred: boolean) => {
      if (deferred) {
        // Wait for first message to authenticate
        const authTimeout = setTimeout(() => {
          ws.send(createErrorFrame('UNAUTHORIZED', 'Authentication timeout.'));
          ws.close(1008, 'Unauthorized');
        }, 5000);

        ws.once('message', async (message: string | Buffer) => {
          try {
            const data = JSON.parse(message.toString());
            if (data.type === 'auth' && data.token) {
              const res = await this.deps.validateApiKey(data.token);
              if (res) {
                clearTimeout(authTimeout);
                this.streamManager.addConnection(botId, ws);
                
                // If it was a ping masked as auth, we should handle it properly, but we only expect auth
              } else {
                ws.send(createErrorFrame('UNAUTHORIZED', 'Invalid token.'));
                ws.close(1008, 'Unauthorized');
              }
            } else {
              ws.send(createErrorFrame('UNAUTHORIZED', 'Expected auth frame.'));
              ws.close(1008, 'Unauthorized');
            }
          } catch (e) {
            ws.send(createErrorFrame('UNAUTHORIZED', 'Invalid auth payload.'));
            ws.close(1008, 'Unauthorized');
          }
        });
      } else {
        this.streamManager.addConnection(botId, ws);
      }
    });
  }

  close() {
    this.wss.close();
  }
}
