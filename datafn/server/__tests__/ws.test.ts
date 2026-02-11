/**
 * WebSocket Manager Tests
 */

import { describe, it, expect, vi } from "vitest";
import { WebSocketManager, type WebSocketClient } from "../src/ws.js";

describe("WebSocketManager", () => {
  it("should broadcast cursor to all connected clients", () => {
    const manager = new WebSocketManager();
    const client1: WebSocketClient = { send: vi.fn() };
    const client2: WebSocketClient = { send: vi.fn() };

    manager.addClient(client1);
    manager.addClient(client2);

    manager.broadcastCursor("100");

    const expectedMsg = JSON.stringify({ type: "cursor", cursor: "100" });
    expect(client1.send).toHaveBeenCalledWith(expectedMsg);
    expect(client2.send).toHaveBeenCalledWith(expectedMsg);
  });

  it("should remove client on send error", () => {
    const manager = new WebSocketManager();
    const client1: WebSocketClient = {
      send: vi.fn().mockImplementation(() => {
        throw new Error("closed");
      }),
    };
    const client2: WebSocketClient = { send: vi.fn() };

    manager.addClient(client1);
    manager.addClient(client2);

    // First broadcast triggers error and removal
    manager.broadcastCursor("100");

    expect(client1.send).toHaveBeenCalled();
    expect(client2.send).toHaveBeenCalled();

    // Reset mocks
    vi.clearAllMocks();

    // Second broadcast should only go to client2
    manager.broadcastCursor("101");

    expect(client1.send).not.toHaveBeenCalled();
    expect(client2.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "cursor", cursor: "101" }),
    );
  });

  it("should handle hello message (no-op for now but safe)", () => {
    const manager = new WebSocketManager();
    const client: WebSocketClient = { send: vi.fn() };
    manager.addClient(client);

    // Should not throw
    manager.handleMessage(
      client,
      JSON.stringify({ type: "hello", clientId: "c1", cursor: "0" }),
    );
  });
});
