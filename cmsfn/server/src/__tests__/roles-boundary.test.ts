import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { handleRolesList, handleRolesUpsert, handleRolesDelete, ROLE_BODY_MAX_BYTES } from "../http/roles.js";
import type { RolesHandlerConfig } from "../http/roles.js";

const handlers = [handleRolesList, handleRolesUpsert, handleRolesDelete];
function request(chunks: string[], length?: number) {
  const readable = Readable.from(chunks.map(chunk => Buffer.from(chunk)));
  Object.assign(readable, { headers: length === undefined ? {} : { "content-length": String(length) } });
  const originalIterator = readable.iterator.bind(readable);
  const next = vi.fn();
  const iterator = vi.spyOn(readable, "iterator").mockImplementation(options => {
    const value = originalIterator(options);
    const originalNext = value.next.bind(value);
    value.next = (...args) => { next(); return originalNext(...args); };
    return value;
  });
  return { req: readable as unknown as IncomingMessage, iterator, next, readable };
}
function config(authorizeRoles: RolesHandlerConfig["authorizeRoles"] = async () => true) {
  const db = memoryAdapter();
  const query = vi.spyOn(db, "findMany");
  return { config: { db, authorizeRoles } as RolesHandlerConfig, query };
}

describe("role authorization and JSON boundary", () => {
  for (const handler of handlers) {
    for (const denial of ["missing", "false", "throw", "truthy"] as const) {
      it(`${handler.name} denies ${denial} authorization without touching the body or database`, async () => {
        const { config: options, query } = config();
        options.authorizeRoles = denial === "missing" ? undefined : async () => {
          if (denial === "throw") throw new Error("secret authorization detail");
          return denial === "truthy" ? "yes" as unknown as boolean : false;
        };
        const { req, iterator, readable } = request(["invalid"]);
        const result = await handler(options, req);
        expect(result).toEqual({ ok: false, error: { code: "PERMISSION_DENIED", message: "Permission denied", details: {} } });
        expect(iterator).not.toHaveBeenCalled();
        expect(query).not.toHaveBeenCalled();
        readable.destroy();
      });
    }
    it(`${handler.name} rejects oversized declared and streamed bodies`, async () => {
      for (const declared of [true, false]) {
        const { config: options, query } = config();
        const { req, readable, next } = request(["x".repeat(ROLE_BODY_MAX_BYTES + 1)], declared ? ROLE_BODY_MAX_BYTES + 1 : undefined);
        const result = await handler(options, req);
        expect(result).toMatchObject({ ok: false, error: { code: "PAYLOAD_TOO_LARGE" } });
        expect(query).not.toHaveBeenCalled();
        expect(readable.destroyed).toBe(false);
        if (declared) expect(next).not.toHaveBeenCalled();
        readable.destroy();
      }
    });
  }
  it("waits for authorization before reading any bytes", async () => {
    let authorize!: (allowed: boolean) => void;
    const decision = new Promise<boolean>(resolve => { authorize = resolve; });
    const { config: options } = config(async () => decision);
    const { req, iterator } = request(['{"dataset":"prod"}']);
    const pending = handleRolesList(options, req);
    await Promise.resolve();
    expect(iterator).not.toHaveBeenCalled();
    authorize(true);
    expect(await pending).toEqual({ ok: true, result: { roles: [] } });
  });
  it.each(["", "{", "null", "[]", "42", '"value"'])("rejects invalid object body %s", async body => {
    const { config: options, query } = config();
    const { req } = request([body]);
    expect(await handleRolesList(options, req)).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(query).not.toHaveBeenCalled();
  });
  it("uses UTF-8 bytes and accepts an object exactly at the byte limit", async () => {
    const { config: options } = config();
    const prefix = '{"dataset":"prod","padding":"';
    const exact = prefix + "x".repeat(ROLE_BODY_MAX_BYTES - Buffer.byteLength(prefix) - 2) + '"}';
    expect(Buffer.byteLength(exact)).toBe(ROLE_BODY_MAX_BYTES);
    expect(await handleRolesList(options, request([exact]).req)).toEqual({ ok: true, result: { roles: [] } });
    const oversize = prefix + "é".repeat(ROLE_BODY_MAX_BYTES / 2) + '"}';
    expect(await handleRolesList(options, request([oversize]).req)).toMatchObject({ ok: false, error: { code: "PAYLOAD_TOO_LARGE" } });
  });
});
