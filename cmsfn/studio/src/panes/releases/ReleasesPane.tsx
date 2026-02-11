/**
 * Minimal releases pane: list releases, create release, publish release.
 */

import { useState, useCallback, useEffect } from "react";
import type { CmsfnRelease, CmsfnReleasePublishResult } from "@cmsfn/core";

export interface ReleasesPaneProps {
  cmsfnApiUrl: string;
  dataset: string;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export function ReleasesPane({ cmsfnApiUrl, dataset }: ReleasesPaneProps) {
  const [releases, setReleases] = useState<CmsfnRelease[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createName, setCreateName] = useState("");
  const [publishResult, setPublishResult] = useState<CmsfnReleasePublishResult | null>(null);

  const loadReleases = useCallback(async () => {
    if (!dataset) return;
    setLoading(true);
    setError(null);
    const base = normalizeBaseUrl(cmsfnApiUrl);
    const res = await fetch(`${base}/cmsfn/releases/list`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset }),
    });
    const data = await res.json();
    setLoading(false);
    if (data.ok && data.result?.releases) {
      setReleases(data.result.releases);
    } else {
      setError(data?.error?.message ?? "Failed to list releases");
    }
  }, [cmsfnApiUrl, dataset]);

  useEffect(() => {
    loadReleases();
  }, [loadReleases]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createName.trim() || !dataset) return;
    setError(null);
    const base = normalizeBaseUrl(cmsfnApiUrl);
    const res = await fetch(`${base}/cmsfn/releases/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset, name: createName.trim(), publishAt: null }),
    });
    const data = await res.json();
    if (data.ok) {
      setCreateName("");
      await loadReleases();
    } else {
      setError(data?.error?.message ?? "Failed to create release");
    }
  };

  const handlePublish = async (releaseId: string) => {
    setError(null);
    setPublishResult(null);
    const base = normalizeBaseUrl(cmsfnApiUrl);
    const res = await fetch(`${base}/cmsfn/releases/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset, releaseId }),
    });
    const data = await res.json();
    if (data.ok && data.result) {
      setPublishResult(data.result);
      await loadReleases();
    } else {
      setError(data?.error?.message ?? "Failed to publish release");
    }
  };

  return (
    <div data-releases-pane data-dataset={dataset}>
      <h2 data-releases-title>Releases</h2>
      <form onSubmit={handleCreate} data-releases-create-form>
        <input
          type="text"
          placeholder="Release name"
          value={createName}
          onChange={(e) => setCreateName(e.target.value)}
          data-releases-create-name
        />
        <button type="submit" data-releases-create-submit>
          Create release
        </button>
      </form>
      {error && <p data-releases-error>{error}</p>}
      {publishResult && (
        <div data-releases-publish-result>
          <p>Published: {publishResult.published.length}</p>
          {publishResult.failures.length > 0 && (
            <p data-releases-failures>Failures: {publishResult.failures.length}</p>
          )}
        </div>
      )}
      {loading && <p data-releases-loading>Loading…</p>}
      <ul data-releases-list>
        {releases.map((r) => (
          <li key={r.releaseId} data-releases-item data-release-id={r.releaseId}>
            <span data-releases-item-name>{r.name}</span>
            <span data-releases-item-doc-count>{r.docIds.length} docs</span>
            <button
              type="button"
              onClick={() => handlePublish(r.releaseId)}
              data-releases-publish
              data-release-id={r.releaseId}
            >
              Publish
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
