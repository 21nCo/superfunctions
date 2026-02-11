/**
 * Workflow state selector: set draft / in_review / approved and persist _cms via patch.
 */

import type { CmsfnWorkflowState, CmsfnWorkflowMetadata } from "@cmsfn/core";
import { CMS_RESERVED_FIELD } from "@cmsfn/core";
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
  const currentState = currentCms?.state ?? "draft";

  const handleStateChange = async (state: CmsfnWorkflowState) => {
    if (state === currentState) return;
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
    if (res.ok) {
      onStateSaved?.(meta);
    }
  };

  return (
    <div data-workflow-controls data-current-state={currentState}>
      <span data-workflow-label>Workflow</span>
      {WORKFLOW_STATES.map((state) => (
        <button
          key={state}
          type="button"
          data-workflow-state={state}
          data-workflow-active={state === currentState ? "true" : undefined}
          disabled={disabled}
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
