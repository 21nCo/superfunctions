/**
 * Minimal ops pane: trigger export and import for a dataset.
 */

import { useState, useCallback } from "react";

export interface OpsPaneProps {
  cmsfnApiUrl: string;
  dataset: string;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export function OpsPane({ cmsfnApiUrl, dataset }: OpsPaneProps) {
  const [exportLoading, setExportLoading] = useState(false);
  const [exportResult, setExportResult] = useState<unknown>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importArtifact, setImportArtifact] = useState("");
  const [importError, setImportError] = useState<string | null>(null);

  const handleExport = useCallback(async () => {
    if (!dataset) return;
    setExportLoading(true);
    setExportError(null);
    setExportResult(null);
    const base = normalizeBaseUrl(cmsfnApiUrl);
    const res = await fetch(`${base}/cmsfn/ops/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset }),
    });
    const data = await res.json();
    setExportLoading(false);
    if (data.ok && data.result?.artifact) {
      setExportResult(data.result.artifact);
    } else {
      setExportError(data?.error?.message ?? "Export failed");
    }
  }, [cmsfnApiUrl, dataset]);

  const handleImport = useCallback(async () => {
    if (!dataset || !importArtifact.trim()) return;
    let artifact: unknown;
    try {
      artifact = JSON.parse(importArtifact);
    } catch {
      setImportError("Invalid JSON");
      return;
    }
    setImportLoading(true);
    setImportError(null);
    const base = normalizeBaseUrl(cmsfnApiUrl);
    const res = await fetch(`${base}/cmsfn/ops/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataset, artifact }),
    });
    const data = await res.json();
    setImportLoading(false);
    if (!data.ok) {
      setImportError(data?.error?.message ?? "Import failed");
    }
  }, [cmsfnApiUrl, dataset, importArtifact]);

  return (
    <div data-ops-pane data-dataset={dataset}>
      <h2 data-ops-title>Ops</h2>
      <section data-ops-export>
        <h3>Export</h3>
        <button type="button" onClick={handleExport} disabled={exportLoading || !dataset} data-ops-export-trigger>
          {exportLoading ? "Exporting…" : "Export dataset"}
        </button>
        {exportError && <p data-ops-export-error>{exportError}</p>}
        {exportResult != null && <pre data-ops-export-result>{JSON.stringify(exportResult, null, 2).slice(0, 500)}…</pre>}
      </section>
      <section data-ops-import>
        <h3>Import</h3>
        <textarea
          placeholder="Paste artifact JSON"
          value={importArtifact}
          onChange={(e) => setImportArtifact(e.target.value)}
          data-ops-import-artifact
          rows={6}
        />
        <button type="button" onClick={handleImport} disabled={importLoading || !importArtifact.trim()} data-ops-import-trigger>
          {importLoading ? "Importing…" : "Import to dataset"}
        </button>
        {importError && <p data-ops-import-error>{importError}</p>}
      </section>
    </div>
  );
}
