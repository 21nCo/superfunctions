/**
 * Media library: upload asset, browse (deterministic order), select to insert ref.
 */

import { useState, useEffect, useCallback } from "react";
import { uploadAssetWithLimit } from "../../media/upload.js";
import { browseAssets } from "../../media/browse.js";
import { buildAssetRef } from "../../media/insertAssetRef.js";
import type { CanonicalAssetRef } from "../../media/insertAssetRef.js";
import type { AssetListItem } from "../../contentfn/client.js";

export interface MediaLibraryPaneProps {
  baseUrl: string;
  dataset: string;
  maxUploadBytes?: number;
  /** When user selects an asset, call with canonical asset ref. */
  onSelectAsset?: (ref: CanonicalAssetRef) => void;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
      resolve(base64 ?? "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function MediaLibraryPane({
  baseUrl,
  dataset,
  maxUploadBytes,
  onSelectAsset,
}: MediaLibraryPaneProps) {
  const [assets, setAssets] = useState<AssetListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const loadAssets = useCallback(async () => {
    if (!dataset) return;
    setLoading(true);
    setError(null);
    const result = await browseAssets({ baseUrl, dataset });
    setLoading(false);
    if (result.ok) {
      setAssets(result.assets);
    } else {
      setError(result.message);
    }
  }, [baseUrl, dataset]);

  useEffect(() => {
    loadAssets();
  }, [loadAssets]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !dataset) return;
    e.target.value = "";
    setUploading(true);
    setUploadError(null);
    const base64 = await fileToBase64(file);
    const result = await uploadAssetWithLimit(
      { baseUrl, maxUploadBytes },
      {
        dataset,
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        bytesBase64: base64,
      }
    );
    setUploading(false);
    if (result.ok) {
      await loadAssets();
    } else {
      setUploadError(result.message);
    }
  };

  const handleSelect = (asset: AssetListItem) => {
    const ref = buildAssetRef(asset.assetId, asset.contentType);
    onSelectAsset?.(ref);
  };

  return (
    <div data-media-library-pane>
      <div data-media-upload>
        <input
          type="file"
          data-media-upload-input
          disabled={uploading || !dataset}
          onChange={handleFileChange}
          aria-label="Upload file"
        />
        {uploadError && (
          <p data-media-upload-error role="alert">
            {uploadError}
          </p>
        )}
      </div>
      {error && (
        <p data-media-browse-error role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p data-media-loading>Loading…</p>
      ) : (
        <ul data-media-list role="list">
          {assets.map((asset) => (
            <li key={asset.assetId} data-media-item data-asset-id={asset.assetId}>
              <button
                type="button"
                data-media-select
                onClick={() => handleSelect(asset)}
                disabled={!onSelectAsset}
              >
                <span data-media-filename>{asset.filename}</span>
                <span data-media-id>{asset.assetId}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
