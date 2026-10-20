import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { createExpressMiddleware } from "../../src/adapters/express";
import type { WatchFn } from "../../src/core/watch-fn";

function fixture() {
  const track = vi.fn();
  const req = { method: "GET", path: "/sample", get: () => "test", ip: "127.0.0.1" } as unknown as Request;
  const response = Object.assign(new EventEmitter(), {
    statusCode: 200, writableFinished: false, json: vi.fn(),
  });
  const next = vi.fn();
  const json = response.json;
  createExpressMiddleware({ track } as unknown as WatchFn)(req, response as unknown as Response, next);
  return { track, response, next, json };
}

describe("Express request completion", () => {
  it("leaves response methods intact and records JSON responses only on completion", () => {
    const { track, response, next, json } = fixture();
    expect(next).toHaveBeenCalledOnce();
    expect(response.json).toBe(json);
    response.json({ ok: true });
    expect(track).not.toHaveBeenCalled();
    response.writableFinished = true;
    response.emit("finish");
    response.emit("close");
    expect(track).toHaveBeenCalledOnce();
    expect(track).toHaveBeenCalledWith("http.request", expect.objectContaining({ path: "/sample", aborted: false, statusCode: 200 }));
    expect(response.listenerCount("finish")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
  });

  it("records premature disconnects once even if a late finish arrives", () => {
    const { track, response } = fixture();
    response.emit("close");
    response.emit("finish");
    expect(track).toHaveBeenCalledOnce();
    expect(track).toHaveBeenCalledWith("http.request", expect.objectContaining({ aborted: true }));
    expect(response.listenerCount("finish")).toBe(0);
  });

  it("recognizes a finished response when close is observed first", () => {
    const { track, response } = fixture();
    response.writableFinished = true;
    response.emit("close");
    expect(track).toHaveBeenCalledWith("http.request", expect.objectContaining({ aborted: false }));
  });
});
