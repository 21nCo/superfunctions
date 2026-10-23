/**
 * Bundle loader utilities for loading framework bundles into compfn.
 * Bundles contain framework definitions and optional control definitions.
 */

import type { CompFnAPI } from "../api.js";
import type { CreateFrameworkInput } from "../framework.js";
import type { CreateControlInput } from "../control.js";
import type { CompfnEnvelope } from "../types.js";

export interface FrameworkBundle {
  framework: CreateFrameworkInput;
  controls?: CreateControlInput[];
}

export interface BundleLoadResult {
  framework: { id: string; name: string };
  controls: Array<{ id: string; name: string }>;
}

/**
 * Load a framework bundle into compfn.
 * Creates all controls first (if present in bundle), then creates the framework.
 * 
 * @param api - The compfn API instance
 * @param bundle - The framework bundle to load
 * @param options - Optional configuration
 * @returns Envelope with load result (framework id/name and control ids/names)
 */
export async function loadBundle(
  api: CompFnAPI,
  bundle: FrameworkBundle,
  options?: {
    /**
     * If true, use control IDs from bundle as-is when creating controls.
     * If false or undefined, let compfn generate IDs.
     */
    useStableControlIds?: boolean;
  }
): Promise<CompfnEnvelope<BundleLoadResult>> {
  const createdControls: Array<{ id: string; name: string }> = [];
  const controlIdMap = new Map<string, string>(); // bundle id -> created id

  // Step 1: Create controls from bundle (if any)
  if (bundle.controls && bundle.controls.length > 0) {
    for (const controlInput of bundle.controls) {
      // Generate stable ID from control name if needed
      const stableId = options?.useStableControlIds
        ? generateStableControlId(controlInput.name)
        : undefined;

      // Check if control already exists (by stable ID if provided)
      let existingControl;
      if (stableId) {
        existingControl = await api.controls.get(stableId);
        if (existingControl.ok) {
          controlIdMap.set(stableId, stableId);
          createdControls.push({ id: stableId, name: existingControl.result.name });
          continue; // Skip creating if exists
        }
      }

      // Create the control
      const controlResult = await api.controls.create(controlInput);
      if (!controlResult.ok) {
        return controlResult as CompfnEnvelope<BundleLoadResult>;
      }

      const createdControl = controlResult.result;
      if (stableId) {
        controlIdMap.set(stableId, createdControl.id);
      }
      createdControls.push({ id: createdControl.id, name: createdControl.name });
    }
  }

  // Step 2: Update framework requirements with created control IDs if needed
  let frameworkInput = bundle.framework;
  if (options?.useStableControlIds && controlIdMap.size > 0) {
    frameworkInput = {
      ...bundle.framework,
      requirements: bundle.framework.requirements.map((req) => ({
        ...req,
        controlIds: req.controlIds.map((cid) => controlIdMap.get(cid) ?? cid),
      })),
    };
  }

  // Step 3: Create the framework
  const frameworkResult = await api.frameworks.create(frameworkInput);
  if (!frameworkResult.ok) {
    return frameworkResult as CompfnEnvelope<BundleLoadResult>;
  }

  return {
    ok: true,
    result: {
      framework: { id: frameworkResult.result.id, name: frameworkResult.result.name },
      controls: createdControls,
    },
  };
}

/**
 * Generate a stable control ID from a control name.
 * Uses kebab-case conversion.
 */
function generateStableControlId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
