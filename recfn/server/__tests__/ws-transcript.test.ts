import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TranscriptStreamManager, MAX_CONNECTIONS_PER_BOT } from '../src/ws/transcript-stream.js';
import { WebSocket } from 'ws';

describe('TranscriptStreamManager', () => {
  let manager: TranscriptStreamManager;
  
  beforeEach(() => {
    manager = new TranscriptStreamManager();
  });

  function createMockWebSocket() {
    return {
      send: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
      readyState: WebSocket.OPEN,
    } as unknown as WebSocket;
  }

  it('allows adding connections and broadcasts to them', () => {
    const ws1 = createMockWebSocket();
    const ws2 = createMockWebSocket();
    
    manager.addConnection('bot_1', ws1);
    manager.addConnection('bot_1', ws2);
    
    manager.broadcast('bot_1', 'status', { state: 'recording' });
    
    const expectedFrame = JSON.stringify({ type: 'status', data: { state: 'recording' } });
    expect(ws1.send).toHaveBeenCalledWith(expectedFrame);
    expect(ws2.send).toHaveBeenCalledWith(expectedFrame);
  });

  it('enforces maximum connections per bot limit', () => {
    for (let i = 0; i < MAX_CONNECTIONS_PER_BOT; i++) {
      manager.addConnection('bot_limit', createMockWebSocket());
    }

    const wsReJECT = createMockWebSocket();
    const result = manager.addConnection('bot_limit', wsReJECT);
    
    expect(result).toBe(false);
    expect(wsReJECT.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'error',
      data: { code: 'WS_LIMIT_EXCEEDED', message: 'Maximum concurrent connections reached.' }
    }));
    expect(wsReJECT.close).toHaveBeenCalledWith(1008, 'Limit Exceeded');
  });

  it('closes all connections for a bot', () => {
    const ws1 = createMockWebSocket();
    const ws2 = createMockWebSocket();
    
    manager.addConnection('bot_close', ws1);
    manager.addConnection('bot_close', ws2);
    
    manager.closeAll('bot_close', 1000, 'Bot Left');
    
    expect(ws1.close).toHaveBeenCalledWith(1000, 'Bot Left');
    expect(ws2.close).toHaveBeenCalledWith(1000, 'Bot Left');
  });
  
  it('handles ping messages', () => {
    const ws = createMockWebSocket();
    manager.addConnection('bot_ping', ws);
    
    const onMessage = vi.mocked(ws.on).mock.calls.find(c => c[0] === 'message')?.[1] as Function;
    expect(onMessage).toBeDefined();
    
    onMessage(Buffer.from(JSON.stringify({ type: 'ping' })));
    
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'pong' }));
  });
});
