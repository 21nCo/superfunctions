import { afterEach, expect, it, vi } from "vitest";
import { generateKeyPairSync, verify, webcrypto } from "node:crypto";
import { getGitHubAppToken } from "./auth";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
afterEach(() => vi.unstubAllGlobals());
it.each(["pkcs1", "pkcs8", "raw"] as const)("signs a verifiable GitHub App JWT using %s keys", async type => {
  vi.stubGlobal("crypto", webcrypto);
  const privateKey = type === "raw" ? keys.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64") : keys.privateKey.export({ type, format: "pem" }).toString();
  const fetch = vi.fn(async (_url: string, options: RequestInit) => {
    const token = (options.headers as Record<string, string>).Authorization.slice(7);
    const [header, payload, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString()).iss).toBe("123");
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), keys.publicKey, Buffer.from(signature, "base64url"))).toBe(true);
    return Response.json({ token: "installation-token" });
  });
  vi.stubGlobal("fetch", fetch);
  expect(await getGitHubAppToken("123", "456", privateKey)).toBe("installation-token");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe("https://api.github.com/app/installations/456/access_tokens");
});
it.each(["-----BEGIN ENCRYPTED PRIVATE KEY-----\nYWJj\n-----END ENCRYPTED PRIVATE KEY-----", "-----BEGIN PRIVATE KEY-----\nYWJj\n-----END RSA PRIVATE KEY-----", "not a key", "x".repeat(65537)])("rejects malformed or unsupported keys before network access", async key => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  await expect(getGitHubAppToken("123", "456", key)).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
});
