import { describe, expect, it } from "vitest";
import {
  createDatafnExtfnAuthority,
  createDatafnExtfnRoutes,
} from "../src/index.js";

const schema = {
  resources: [
    {
      name: "clip",
      version: 1,
      fields: [
        { name: "title", type: "string", required: false },
        { name: "site", type: "string", required: false },
      ],
    },
  ],
} as const;

describe("@datafn/extfn authority", () => {
  it("starts authority mode in background and exposes all DataFn routes", () => {
    const authority = createDatafnExtfnAuthority({
      schema,
      clientId: "authority:demo",
      namespace: "tenant:demo",
    });

    const routes = createDatafnExtfnRoutes(authority).map((route) => route.method);
    expect(authority.address.context).toBe("background");
    expect(routes).toEqual([
      "query",
      "mutation",
      "transact",
      "seed",
      "clone",
      "pull",
      "push",
      "reconcile",
      "subscribe",
      "unsubscribe",
    ]);
  });

  it("rejects authority mode outside the background context", () => {
    expect(() =>
      createDatafnExtfnAuthority(
        {
          schema,
          clientId: "content:demo",
          namespace: "tenant:demo",
        },
        {
          address: {
            context: "content",
            contentScriptId: "clipper",
          },
        },
      ),
    ).toThrowError();

    try {
      createDatafnExtfnAuthority(
        {
          schema,
          clientId: "content:demo",
          namespace: "tenant:demo",
        },
        {
          address: {
            context: "content",
            contentScriptId: "clipper",
          },
        },
      );
    } catch (error) {
      expect(error).toMatchObject({
        code: "E_CONTEXT_UNAVAILABLE",
        message: "DataFn authority mode is only available in background context.",
      });
    }
  });
});
