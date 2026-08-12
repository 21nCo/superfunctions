import { describe, expect, it } from "vitest";
import { createMemoryAssetProvider } from "./index";

describe("filefn bridge", () => {
  it("stores bytes and enforces provider policy", async () => {
    const provider = createMemoryAssetProvider({ createId: () => "a", maxBytes: 1, allowedMediaTypes: ["text/plain"] });
    await provider.put({ documentId: "d", name: "a.txt", mediaType: "text/plain", bytes: new Uint8Array([1]) });
    expect(await provider.read("a")).toEqual(new Uint8Array([1]));
    await expect(provider.put({ id: "large", documentId: "d", name: "large.txt", mediaType: "text/plain", bytes: new Uint8Array([1, 2]) })).rejects.toThrow("MDFN_ASSET_TOO_LARGE");
    await expect(provider.put({ id: "image", documentId: "d", name: "image.png", mediaType: "image/png", bytes: new Uint8Array([1]) })).rejects.toThrow("MDFN_ASSET_MEDIA_TYPE_FORBIDDEN");
  });
});
