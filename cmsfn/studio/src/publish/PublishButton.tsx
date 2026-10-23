/**
 * Publish / Unpublish actions; call CmsFn server (role + workflow gated).
 */

import { useState, useEffect, useRef } from "react";
import { publishDoc, unpublishDoc } from "./cmsfnClient.js";

export interface PublishButtonProps {
  cmsfnApiUrl: string;
  dataset: string;
  docId: string;
  isPublished?: boolean;
  /** Published read-only views expose only unpublish. */
  allowPublish?: boolean;
  onPublished?: () => void;
  onUnpublished?: () => void;
  disabled?: boolean;
}

export function PublishButton({
  cmsfnApiUrl,
  dataset,
  docId,
  isPublished = false,
  allowPublish = true,
  onPublished,
  onUnpublished,
  disabled,
}: PublishButtonProps) {
  const generation = useRef(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setLoading(false); setError(null); return () => { generation.current++; }; }, [cmsfnApiUrl, dataset, docId]);

  const mutate = async (operation: "publish" | "unpublish") => {
    if (loading || disabled) return;
    const requestGeneration = generation.current;
    setError(null); setLoading(true);
    try {
      const res = await (operation === "publish" ? publishDoc : unpublishDoc)({ apiUrl: cmsfnApiUrl }, dataset, docId);
      if (requestGeneration !== generation.current) return;
      setLoading(false);
      if (res.ok) (operation === "publish" ? onPublished : onUnpublished)?.();
      else setError(res.error.message);
    } catch {
      if (requestGeneration !== generation.current) return;
      setLoading(false); setError("Publication request could not be completed; refresh to verify its outcome");
    }
  };

  return (
    <div data-publish-controls>
      {error && <p data-publish-error role="alert">{error}</p>}
      {allowPublish && (
        <button
          type="button"
          data-publish-button
          disabled={disabled || loading}
          onClick={() => void mutate("publish")}
        >
          {loading ? "Publishing…" : isPublished ? "Publish changes" : "Publish"}
        </button>
      )}
      {isPublished && (
        <button
          type="button"
          data-unpublish-button
          disabled={disabled || loading}
          onClick={() => void mutate("unpublish")}
        >
          {loading ? "Unpublishing…" : "Unpublish"}
        </button>
      )}
    </div>
  );
}
