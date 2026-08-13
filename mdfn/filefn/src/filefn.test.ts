import { describe, expect, it } from "vitest";
import { assetReferenceMarkdown, createAssetGateway, createAuthoringAssetHandler, createMemoryAssetProvider, resolvedAssetRenderNode } from "./index";

describe("filefn bridge", () => {
  it("stores bytes and enforces provider policy", async () => {
    const provider = createMemoryAssetProvider({ createId: () => "a", maxBytes: 1, allowedMediaTypes: ["text/plain"] });
    await provider.put({ documentId: "d", name: "a.txt", mediaType: "text/plain", bytes: new Uint8Array([1]) });
    expect(await provider.read("a")).toEqual(new Uint8Array([1]));
    await expect(provider.put({ id: "large", documentId: "d", name: "large.txt", mediaType: "text/plain", bytes: new Uint8Array([1, 2]) })).rejects.toThrow("MDFN_ASSET_TOO_LARGE");
    await expect(provider.put({ id: "image", documentId: "d", name: "image.png", mediaType: "image/png", bytes: new Uint8Array([1]) })).rejects.toThrow("MDFN_ASSET_MEDIA_TYPE_FORBIDDEN");
  });

  it("authorizes upload/resolve and keeps delivery URLs out of durable references", async () => {
    const operations: string[] = [];
    const provider = createMemoryAssetProvider({
      createId: () => "asset",
      allowedMediaTypes: ["image/png"],
      authorize: async (operation) => { operations.push(operation); },
    });
    const gateway = createAssetGateway(provider);
    const context = { documentId: "document", userId: "author" };
    const file = new Blob([new Uint8Array([1])], { type: "image/png" });
    const reference = await gateway.upload(file, context);
    expect(reference).toMatchObject({ id: "asset", provider: "memory", documentId: "document" });
    expect(reference).not.toHaveProperty("url");
    const resolved = await gateway.resolve(reference, context);
    expect(resolvedAssetRenderNode(resolved)).toMatchObject({ tag: "img", attrs: { src: "/api/mdfn/assets/asset" } });
    expect(operations).toEqual(["upload", "resolve"]);
    await expect(gateway.resolve(reference, { documentId: "other" })).rejects.toThrow("MDFN_ASSET_DOCUMENT_MISMATCH");
  });

  it("emits a durable document- and version-bound asset identifier", () => {
    expect(assetReferenceMarkdown({ id: "asset", provider: "filefn", documentId: "document", versionId: "v1", mediaType: "image/png" }, "Image"))
      .toBe("![Image](mdfn-asset:filefn/asset?document=document&version=v1)");
  });

  it("adapts an asset provider to the shared authoring file callback", async () => {
    const handler = createAuthoringAssetHandler({
      provider: createMemoryAssetProvider({ createId: () => "inserted" }),
      context: { documentId: "document" },
    });
    const markdown = await handler([new Blob(["image"], { type: "image/png" })]);
    expect(markdown).toBe("![asset](mdfn-asset:memory/inserted?document=document)");
  });
});
