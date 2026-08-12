import { describe, expect, it } from "vitest";
import { createMdfnClient } from "./index";
describe("client", () => { it("encodes document identifiers", async () => { let url = ""; const client = createMdfnClient({ baseUrl: "https://example.test/api/mdfn", fetch: async (input) => { url = String(input); return Response.json({ id: "a/b", markdown: "", ownerId: "u", sourceHash: "h", schemaHash: "s", version: 1, createdAt: "", updatedAt: "" }); } }); await client.getDocument("a/b"); expect(url.endsWith("/documents/a%2Fb")).toBe(true); }); });
