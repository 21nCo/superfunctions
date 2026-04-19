import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import {
  authenticateWebSocket,
  authorizeTranscriptSubscription,
  type VerifyBotAccess,
  type WsAuthFailureCode,
} from './auth.js';
import { TranscriptStreamManager } from './transcript-stream.js';
import { createErrorFrame } from './frames.js';
import type { ValidateApiKey } from '../middleware/auth.js';
import type { Logger } from '../integrations/logfn.js';

export interface WsServerDeps {
  validateApiKey: ValidateApiKey;
  verifyBotAccess: VerifyBotAccess;
  logger?: Logger;
}

function getAuthFailureMessage(code: WsAuthFailureCode): string {
  if (code === 'WS_NAMESPACE_FORBIDDEN') {
    return 'Token does not grant access to this bot.';
  }
  return 'Invalid token.';
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
        const authResult = await authenticateWebSocket(
          req,
          this.deps.validateApiKey,
          this.deps.verifyBotAccess,
          this.deps.logger,
        );

        if (!authResult.ok && !authResult.deferred) {
          const statusLine =
            authResult.httpStatus === 403
              ? 'HTTP/1.1 403 Forbidden\\r\\n\\r\\n'
              : 'HTTP/1.1 401 Unauthorized\\r\\n\\r\\n';
          socket.write(statusLine);
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
            if (data.type === 'auth' && typeof data.token === 'string') {
              const authResult = await authorizeTranscriptSubscription(
                botId,
                data.token,
                this.deps.validateApiKey,
                this.deps.verifyBotAccess,
                this.deps.logger,
              );
              if (authResult.ok) {
                clearTimeout(authTimeout);
                this.streamManager.addConnection(botId, ws);
              } else {
                clearTimeout(authTimeout);
                ws.send(
                  createErrorFrame(
                    authResult.code ?? 'UNAUTHORIZED',
                    getAuthFailureMessage(authResult.code ?? 'UNAUTHORIZED'),
                  ),
                );
                ws.close(
                  1008,
                  authResult.code === 'WS_NAMESPACE_FORBIDDEN'
                    ? 'Namespace Forbidden'
                    : 'Unauthorized',
                );
              }
            } else {
              clearTimeout(authTimeout);
              ws.send(createErrorFrame('UNAUTHORIZED', 'Expected auth frame.'));
              ws.close(1008, 'Unauthorized');
            }
          } catch (e) {
            clearTimeout(authTimeout);
            this.deps.logger?.warn('ws.auth.failed', {
              botId,
              code: 'UNAUTHORIZED',
              reason: 'invalid_auth_payload',
            });
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
