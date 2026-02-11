/**
 * Reference picker dialog: list candidates via CFQL (type-scoped, deterministic), bounded preview, select → canonical ref.
 * When role lacks doc.read for candidate type, shows deterministic "no access" (data-ref-picker-denied).
 */

import { useState, useEffect, useCallback } from "react";
import type { ContentfnDocument } from "@contentfn/core";
import { queryCandidates } from "../../../references/queryCandidates.js";

export interface ReferencePickerDialogProps {
  baseUrl: string;
  dataset: string;
  /** Allowed document types (reference field's `to`). */
  allowedTypes: string[];
  /** When false, show "no access" state (deterministic for TV-REF-PICKER-002). */
  hasDocRead?: boolean;
  onSelect: (ref: { _type: "reference"; _ref: string }) => void;
  onClose: () => void;
}

const PREVIEW_PROJECTION = { fields: ["_id", "_type", "title", "name"] };
const PAGE_LIMIT = 20;

export function ReferencePickerDialog({
  baseUrl,
  dataset,
  allowedTypes,
  hasDocRead = true,
  onSelect,
  onClose,
}: ReferencePickerDialogProps) {
  const [candidates, setCandidates] = useState<ContentfnDocument[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(
    async (cursor?: string | null) => {
      if (!dataset || allowedTypes.length === 0) return;
      setLoading(true);
      setError(null);
      const envelope = await queryCandidates({
        baseUrl,
        dataset,
        types: allowedTypes,
        projection: PREVIEW_PROJECTION,
        limit: PAGE_LIMIT,
        cursor: cursor ?? null,
      });
      setLoading(false);
      if (envelope.ok) {
        if (cursor) {
          setCandidates((prev) => [...prev, ...envelope.result.data]);
        } else {
          setCandidates(envelope.result.data);
        }
        setNextCursor(envelope.result.nextCursor);
      } else {
        setError(envelope.error.message);
        if (cursor == null) {
          setCandidates([]);
          setNextCursor(null);
        }
      }
    },
    [baseUrl, dataset, allowedTypes]
  );

  useEffect(() => {
    if (hasDocRead) loadPage();
  }, [hasDocRead, loadPage]);

  const handleSelect = (doc: ContentfnDocument) => {
    const id = (doc as { _id?: string })._id;
    if (id) onSelect({ _type: "reference", _ref: id });
    onClose();
  };

  if (!hasDocRead) {
    return (
      <div role="dialog" aria-modal="true" data-ref-picker data-ref-picker-denied>
        <p data-ref-picker-denied-message>No access</p>
        <button type="button" onClick={onClose} data-ref-picker-close>
          Close
        </button>
      </div>
    );
  }

  return (
    <div role="dialog" aria-modal="true" data-ref-picker>
      <div data-ref-picker-header>
        <h2 data-ref-picker-title>Choose reference</h2>
        <button type="button" onClick={onClose} data-ref-picker-close aria-label="Close">
          Close
        </button>
      </div>
      {error && <p data-ref-picker-error>{error}</p>}
      {loading && candidates.length === 0 && <p data-ref-picker-loading>Loading…</p>}
      <ul data-ref-picker-list>
        {candidates.map((doc) => {
          const d = doc as Record<string, unknown>;
          const id = (d._id as string) ?? "";
          const label = (d.title as string) ?? (d.name as string) ?? id ?? "(no id)";
          return (
            <li key={id} data-ref-picker-item data-ref-picker-item-id={id}>
              <button type="button" onClick={() => handleSelect(doc)} data-ref-picker-select>
                {label}
              </button>
            </li>
          );
        })}
      </ul>
      {nextCursor && (
        <button
          type="button"
          onClick={() => loadPage(nextCursor)}
          disabled={loading}
          data-ref-picker-load-more
        >
          Load more
        </button>
      )}
    </div>
  );
}
