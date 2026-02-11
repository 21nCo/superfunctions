/**
 * Publish / Unpublish actions; call CmsFn server (role + workflow gated).
 */

import { useState } from "react";
import { publishDoc, unpublishDoc } from "./cmsfnClient.js";

export interface PublishButtonProps {
  cmsfnApiUrl: string;
  dataset: string;
  docId: string;
  isPublished?: boolean;
  onPublished?: () => void;
  onUnpublished?: () => void;
  disabled?: boolean;
}

export function PublishButton({
  cmsfnApiUrl,
  dataset,
  docId,
  isPublished = false,
  onPublished,
  onUnpublished,
  disabled,
}: PublishButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePublish = async () => {
    setError(null);
    setLoading(true);
    const res = await publishDoc({ apiUrl: cmsfnApiUrl }, dataset, docId);
    setLoading(false);
    if (res.ok) {
      onPublished?.();
    } else {
      setError(res.error.message);
    }
  };

  const handleUnpublish = async () => {
    setError(null);
    setLoading(true);
    const res = await unpublishDoc({ apiUrl: cmsfnApiUrl }, dataset, docId);
    setLoading(false);
    if (res.ok) {
      onUnpublished?.();
    } else {
      setError(res.error.message);
    }
  };

  return (
    <div data-publish-controls>
      {error && <p data-publish-error role="alert">{error}</p>}
      {!isPublished ? (
        <button
          type="button"
          data-publish-button
          disabled={disabled || loading}
          onClick={handlePublish}
        >
          {loading ? "Publishing…" : "Publish"}
        </button>
      ) : (
        <button
          type="button"
          data-unpublish-button
          disabled={disabled || loading}
          onClick={handleUnpublish}
        >
          {loading ? "Unpublishing…" : "Unpublish"}
        </button>
      )}
    </div>
  );
}
