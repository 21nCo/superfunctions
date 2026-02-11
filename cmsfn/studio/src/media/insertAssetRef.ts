/**
 * Canonical asset reference shape for inserting into documents.
 * SPEC: { _type: "asset", _ref: "<id>", assetType: "image" | "file" }.
 */

export type AssetRefAssetType = "image" | "file";

export interface CanonicalAssetRef {
  _type: "asset";
  _ref: string;
  assetType: AssetRefAssetType;
}

/**
 * Build canonical asset ref from assetId and contentType (image/* -> image, else file).
 */
export function buildAssetRef(assetId: string, contentType: string): CanonicalAssetRef {
  const assetType: AssetRefAssetType =
    contentType.startsWith("image/") ? "image" : "file";
  return {
    _type: "asset",
    _ref: assetId,
    assetType,
  };
}
