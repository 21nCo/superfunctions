/**
 * Bundle loader utilities for loading framework bundles into compfn.
 * Bundles contain framework definitions and optional control definitions.
 */

import { validateCreateControlInput, validateCreateFrameworkInput } from "../validation.js";
import type { CompFnAPI } from "../api.js";
import type { CreateFrameworkInput } from "../framework.js";
import type { CreateControlInput } from "../control.js";
import type { CompfnEnvelope } from "../types.js";

export interface FrameworkBundle {
  framework: CreateFrameworkInput;
  controls?: Array<CreateControlInput & { /** Bundle-local reference, not a database ID. */ id?: string }>;
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
    /** @deprecated Mapping now always resolves explicit bundle IDs or legacy name slugs.
     * Every load creates a new framework and new controls with service-generated IDs. */
    useStableControlIds?: boolean;
  }
): Promise<CompfnEnvelope<BundleLoadResult>> {
  if (!bundle || typeof bundle !== "object" || (bundle.controls !== undefined && !Array.isArray(bundle.controls))) {
    return { ok: false, error: { code: "VALIDATION_FAILED", message: "Invalid framework bundle", details: {} } };
  }
  const frameworkValidation = validateCreateFrameworkInput(bundle.framework);
  if (!frameworkValidation.ok) return frameworkValidation;
  const localIds = new Set<string>();
  for (const control of bundle.controls ?? []) {
    const validated = validateCreateControlInput(control);
    if (!validated.ok) return validated;
    const id = control.id ?? generateStableControlId(control.name);
    if (typeof id !== "string" || !id.trim() || localIds.has(id)) {
      return { ok: false, error: { code: "VALIDATION_FAILED", message: "Invalid or duplicate bundle control reference", details: { id } } };
    }
    localIds.add(id);
  }
  const createdControls: Array<{ id: string; name: string }> = [];
  const controlIdMap = new Map<string, string>(); // bundle id -> created id

  // Step 1: Create controls from bundle (if any)
  if (bundle.controls && bundle.controls.length > 0) {
    for (const controlInput of bundle.controls) {
      const stableId = controlInput.id ?? generateStableControlId(controlInput.name);
      if (controlIdMap.has(stableId)) {
        return { ok: false, error: { code: "VALIDATION_FAILED", message: "Duplicate bundle control reference", details: { id: stableId } } };
      }

      // Create the control
      const { id: _bundleId, ...input } = controlInput;
      const controlResult = await api.controls.create(input);
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
  if (controlIdMap.size > 0) {
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
