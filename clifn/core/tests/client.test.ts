import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiClient, HttpFailureError, HttpRequestError } from "../src/client.js";
import { createCredentialStore, MissingProfileError } from "../src/credentials.js";

describe("client", () => {
  it("uses credential profile and sends auth headers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clifn-client-"));
    const store = createCredentialStore(join(dir, "credentials.ini"));
    store.setProfile("default", {
      backend: "https://api.conduct.sh",
      key: "sk_live_abc",
    });

    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      expect(String(input)).toContain("/health");
      expect(auth).toBe("Bearer sk_live_abc");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const client = createApiClient({
      credentials: store,
      profile: "default",
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });

    const response = await client.get<{ ok: boolean }>("/health");
    expect(response.data).toEqual({ ok: true });
  });

  it("throws typed error for missing profile", () => {
    const dir = mkdtempSync(join(tmpdir(), "clifn-client-missing-"));
    const store = createCredentialStore(join(dir, "credentials.ini"));

    expect(() =>
      createApiClient({
        credentials: store,
        profile: "missing",
      }),
    ).toThrow(MissingProfileError);
  });

  it("throws typed error for http failure", async () => {
    const client = createApiClient({
      baseUrl: "https://api.conduct.sh",
      apiKey: "sk_live_abc",
      retries: 0,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "boom" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });

    await expect(client.get("/fail")).rejects.toBeInstanceOf(HttpFailureError);
  });

  it("throws typed error for request failure", async () => {
    const client = createApiClient({
      baseUrl: "https://api.conduct.sh",
      apiKey: "sk_live_abc",
      retries: 0,
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    });

    await expect(client.get("/network")).rejects.toBeInstanceOf(HttpRequestError);
  });
});
