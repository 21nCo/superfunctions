import { useState, useEffect, useRef } from "react";
/**
 * Workflow state selector: set draft / in_review / approved and persist _cms via patch.
 */

import type { CmsfnWorkflowState, CmsfnWorkflowMetadata } from "cmsfn";
import { CMS_RESERVED_FIELD } from "cmsfn";
import { writeCmsMetadata } from "./writeCmsMetadata.js";
import { patchDoc } from "../contentfn/client.js";

const WORKFLOW_STATES: CmsfnWorkflowState[] = ["draft", "in_review", "approved"];

export interface WorkflowControlsProps {
  baseUrl: string;
  dataset: string;
  docId: string;
  currentRev: string;
  currentCms?: CmsfnWorkflowMetadata | null;
  onStateSaved?: (newCms: CmsfnWorkflowMetadata) => void;
  disabled?: boolean;
}

export function WorkflowControls({
  baseUrl,
  dataset,
  docId,
  currentRev,
  currentCms,
  onStateSaved,
  disabled,
}: WorkflowControlsProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => { setPending(false); setError(null); return () => { generation.current++; }; }, [baseUrl, dataset, docId, currentRev]);
  const currentState = currentCms?.state ?? "draft";

  const handleStateChange = async (state: CmsfnWorkflowState) => {
    if (state === currentState || pending || disabled) return;
    const requestGeneration = generation.current;
    setPending(true); setError(null);
    const meta = writeCmsMetadata(state);
    const res = await patchDoc(
      { baseUrl },
      {
        dataset,
        id: docId,
        ifRev: currentRev,
        ops: [{ op: "set", path: CMS_RESERVED_FIELD, value: meta }],
      }
    );
    if (requestGeneration !== generation.current) return;
    setPending(false);
    if (res.ok) {
      onStateSaved?.(meta);
    } else setError(res.error.message);
  };

  return (
    <div data-workflow-controls data-current-state={currentState}>
      {error && <p role="alert" data-workflow-error>{error}</p>}
      <span data-workflow-label>Workflow</span>
      {WORKFLOW_STATES.map((state) => (
        <button
          key={state}
          type="button"
          data-workflow-state={state}
          data-workflow-active={state === currentState ? "true" : undefined}
          disabled={disabled || pending}
          onClick={() => handleStateChange(state)}
        >
          {state === "draft"
            ? "Draft"
            : state === "in_review"
              ? "In review"
              : "Approved"}
        </button>
      ))}
    </div>
  );
}
