/**
 * Validation for CompFn create/update inputs.
 * CreateControlInput: name, description, category required; tags optional array.
 * UpdateControlInput: all optional (partial update).
 * CreateFrameworkInput: name required; requirements array with requirementId, controlIds; limits (LIMIT-001).
 */

import type { CreateControlInput, UpdateControlInput } from "./control.js";
import type { CreateFrameworkInput, FrameworkRequirement } from "./framework.js";
import type { CreateEvidenceInput, EvidenceType } from "./evidence.js";
import { EVIDENCE_TYPES } from "./evidence.js";
import type { CompfnError } from "./errors.js";
import { MAX_REQUIREMENTS_PER_FRAMEWORK, MAX_CONTROL_IDS_PER_REQUIREMENT } from "./constants.js";
import type { CheckDefinition } from "./check.js";

export interface ValidationResult<T> {
  ok: true;
  value: T;
}

export interface ValidationFailure {
  ok: false;
  error: CompfnError;
}

export type ValidationOutcome<T> = ValidationResult<T> | ValidationFailure;

/**
 * Validate CreateControlInput. Required: name, description, category (non-empty strings).
 * Optional: tags (array of strings).
 */
export function validateCreateControlInput(
  input: unknown,
  path: string = "input"
): ValidationOutcome<CreateControlInput> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "CreateControlInput must be an object",
        details: { path },
      },
    };
  }
  const obj = input as Record<string, unknown>;
  const name = obj.name;
  const description = obj.description;
  const category = obj.category;
  const tags = obj.tags;

  if (typeof name !== "string" || name.trim() === "") {
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "name is required and must be a non-empty string",
        details: { path: `${path}.name` },
      },
    };
  }
  if (typeof description !== "string" || description.trim() === "") {
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "description is required and must be a non-empty string",
        details: { path: `${path}.description` },
      },
    };
  }
  if (typeof category !== "string" || category.trim() === "") {
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "category is required and must be a non-empty string",
        details: { path: `${path}.category` },
      },
    };
  }
  if (tags !== undefined) {
    if (!Array.isArray(tags)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_FAILED",
          message: "tags must be an array of strings",
          details: { path: `${path}.tags` },
        },
      };
    }
    const invalid = tags.some((t) => typeof t !== "string");
    if (invalid) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_FAILED",
          message: "tags must be an array of strings",
          details: { path: `${path}.tags` },
        },
      };
    }
  }

  const result: CreateControlInput = {
    name: name.trim(),
    description: description.trim(),
    category: category.trim(),
  };
  if (tags !== undefined) {
    result.tags = (tags as string[]).map((t) => String(t).trim()).filter(Boolean);
  }
  return { ok: true, value: result };
}

/**
 * Validate UpdateControlInput. All fields optional; if present must be correct type.
 * name, description, category: non-empty string if provided. tags: array of strings if provided.
 */
export function validateUpdateControlInput(
  input: unknown,
  path: string = "input"
): ValidationOutcome<UpdateControlInput> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "UpdateControlInput must be an object",
        details: { path },
      },
    };
  }
  const obj = input as Record<string, unknown>;
  const result: UpdateControlInput = {};

  if (Object.prototype.hasOwnProperty.call(obj, "name")) {
    const name = obj.name;
    if (typeof name !== "string" || name.trim() === "") {
      return {
        ok: false,
        error: {
          code: "VALIDATION_FAILED",
          message: "name must be a non-empty string",
          details: { path: `${path}.name` },
        },
      };
    }
    result.name = name.trim();
  }
  if (Object.prototype.hasOwnProperty.call(obj, "description")) {
    const description = obj.description;
    if (typeof description !== "string" || description.trim() === "") {
      return {
        ok: false,
        error: {
          code: "VALIDATION_FAILED",
          message: "description must be a non-empty string",
          details: { path: `${path}.description` },
        },
      };
    }
    result.description = description.trim();
  }
  if (Object.prototype.hasOwnProperty.call(obj, "category")) {
    const category = obj.category;
    if (typeof category !== "string" || category.trim() === "") {
      return {
        ok: false,
        error: {
          code: "VALIDATION_FAILED",
          message: "category must be a non-empty string",
          details: { path: `${path}.category` },
        },
      };
    }
    result.category = category.trim();
  }
  if (Object.prototype.hasOwnProperty.call(obj, "tags")) {
    const tags = obj.tags;
    if (!Array.isArray(tags)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_FAILED",
          message: "tags must be an array of strings",
          details: { path: `${path}.tags` },
        },
      };
    }
    const invalid = tags.some((t) => typeof t !== "string");
    if (invalid) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_FAILED",
          message: "tags must be an array of strings",
          details: { path: `${path}.tags` },
        },
      };
    }
    result.tags = (tags as string[]).map((t) => String(t).trim()).filter(Boolean);
  }

  return { ok: true, value: result };
}

function validateRequirementsArray(
  requirements: unknown,
  path: string
): ValidationOutcome<FrameworkRequirement[]> {
  if (!Array.isArray(requirements)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "requirements must be an array",
        details: { path: `${path}.requirements` },
      },
    };
  }
  if (requirements.length > MAX_REQUIREMENTS_PER_FRAMEWORK) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: `requirements must not exceed ${MAX_REQUIREMENTS_PER_FRAMEWORK} items`,
        details: { path: `${path}.requirements`, count: requirements.length },
      },
    };
  }
  const out: FrameworkRequirement[] = [];
  for (let i = 0; i < requirements.length; i++) {
    const item = requirements[i];
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_FAILED",
          message: "each requirement must be an object with requirementId and controlIds",
          details: { path: `${path}.requirements[${i}]` },
        },
      };
    }
    const obj = item as Record<string, unknown>;
    const requirementId = obj.requirementId;
    const controlIds = obj.controlIds;
    if (typeof requirementId !== "string" || requirementId.trim() === "") {
      return {
        ok: false,
        error: {
          code: "VALIDATION_FAILED",
          message: "requirementId is required and must be a non-empty string",
          details: { path: `${path}.requirements[${i}].requirementId` },
        },
      };
    }
    if (!Array.isArray(controlIds)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_FAILED",
          message: "controlIds must be an array of strings",
          details: { path: `${path}.requirements[${i}].controlIds` },
        },
      };
    }
    if (controlIds.length > MAX_CONTROL_IDS_PER_REQUIREMENT) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_FAILED",
          message: `controlIds per requirement must not exceed ${MAX_CONTROL_IDS_PER_REQUIREMENT}`,
          details: { path: `${path}.requirements[${i}].controlIds`, count: controlIds.length },
        },
      };
    }
    const invalid = controlIds.some((c) => typeof c !== "string");
    if (invalid) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_FAILED",
          message: "controlIds must be an array of strings",
          details: { path: `${path}.requirements[${i}].controlIds` },
        },
      };
    }
    const req: FrameworkRequirement = {
      requirementId: requirementId.trim(),
      controlIds: (controlIds as string[]).map((c) => String(c)),
    };
    if (typeof obj.name === "string" && obj.name.trim() !== "") {
      req.name = obj.name.trim();
    }
    out.push(req);
  }
  return { ok: true, value: out };
}

/**
 * Validate CreateFrameworkInput. Required: name (non-empty), requirements (array; each requirementId + controlIds; limits).
 */
export function validateCreateFrameworkInput(
  input: unknown,
  path: string = "input"
): ValidationOutcome<CreateFrameworkInput> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "CreateFrameworkInput must be an object",
        details: { path },
      },
    };
  }
  const obj = input as Record<string, unknown>;
  const name = obj.name;
  if (typeof name !== "string" || name.trim() === "") {
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "name is required and must be a non-empty string",
        details: { path: `${path}.name` },
      },
    };
  }
  const requirementsOut = validateRequirementsArray(obj.requirements, path);
  if (!requirementsOut.ok) return requirementsOut;
  const result: CreateFrameworkInput = {
    name: name.trim(),
    requirements: requirementsOut.value,
  };
  if (typeof obj.version === "string") result.version = obj.version.trim() || undefined;
  if (typeof obj.description === "string") result.description = obj.description.trim() || undefined;
  return { ok: true, value: result };
}

/**
 * Validate partial framework input for update. Same rules for name/requirements when provided.
 */
export function validateUpdateFrameworkInput(
  input: unknown,
  path: string = "input"
): ValidationOutcome<Partial<CreateFrameworkInput>> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "UpdateFrameworkInput must be an object",
        details: { path },
      },
    };
  }
  const obj = input as Record<string, unknown>;
  const result: Partial<CreateFrameworkInput> = {};
  if (Object.prototype.hasOwnProperty.call(obj, "name")) {
    const name = obj.name;
    if (typeof name !== "string" || name.trim() === "") {
      return {
        ok: false,
        error: {
          code: "VALIDATION_FAILED",
          message: "name must be a non-empty string",
          details: { path: `${path}.name` },
        },
      };
    }
    result.name = name.trim();
  }
  if (Object.prototype.hasOwnProperty.call(obj, "requirements")) {
    const requirementsOut = validateRequirementsArray(obj.requirements, path);
    if (!requirementsOut.ok) return requirementsOut;
    result.requirements = requirementsOut.value;
  }
  if (Object.prototype.hasOwnProperty.call(obj, "version")) {
    result.version = typeof obj.version === "string" ? obj.version.trim() || undefined : undefined;
  }
  if (Object.prototype.hasOwnProperty.call(obj, "description")) {
    result.description =
      typeof obj.description === "string" ? obj.description.trim() || undefined : undefined;
  }
  return { ok: true, value: result };
}

const VALID_OUTCOMES = ["pass", "fail", "unknown"] as const;
const SCOPING_STATUSES = ["applicable", "not_applicable"] as const;

/**
 * Validate CreateEvidenceInput. Required: controlId, type (EvidenceType), actorId, outcome.
 * Optional: sourceId, frameworkRequirementId, timestamp, payload, artifactRef.
 * For type "scoping_decision": outcome MUST be "unknown"; payload.status MUST be "applicable" or "not_applicable".
 */
export function validateCreateEvidenceInput(
  input: unknown,
  path: string = "input"
): ValidationOutcome<CreateEvidenceInput> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "CreateEvidenceInput must be an object",
        details: { path },
      },
    };
  }
  const obj = input as Record<string, unknown>;
  const controlId = obj.controlId;
  const type = obj.type;
  const actorId = obj.actorId;
  const outcome = obj.outcome;

  if (typeof controlId !== "string" || controlId.trim() === "") {
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "controlId is required and must be a non-empty string",
        details: { path: `${path}.controlId`, controlId: typeof controlId === "string" ? controlId : undefined },
      },
    };
  }
  if (typeof type !== "string" || !EVIDENCE_TYPES.includes(type)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "type must be a valid EvidenceType",
        details: { path: `${path}.type`, type: type ?? undefined },
      },
    };
  }
  if (typeof actorId !== "string" || actorId.trim() === "") {
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "actorId is required and must be a non-empty string",
        details: { path: `${path}.actorId` },
      },
    };
  }
  if (!VALID_OUTCOMES.includes(outcome as (typeof VALID_OUTCOMES)[number])) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "outcome must be one of pass, fail, unknown",
        details: { path: `${path}.outcome`, outcome: outcome ?? undefined },
      },
    };
  }

  if (type === "scoping_decision") {
    if (outcome !== "unknown") {
      return {
        ok: false,
        error: {
          code: "VALIDATION_FAILED",
          message: "scoping_decision evidence must have outcome 'unknown'",
          details: { path: `${path}.outcome` },
        },
      };
    }
    const payload = obj.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_FAILED",
          message: "scoping_decision requires payload with status",
          details: { path: `${path}.payload` },
        },
      };
    }
    const status = (payload as Record<string, unknown>).status;
    if (
      typeof status !== "string" ||
      !SCOPING_STATUSES.includes(status as (typeof SCOPING_STATUSES)[number])
    ) {
      return {
        ok: false,
        error: {
          code: "VALIDATION_FAILED",
          message: "scoping_decision payload.status must be 'applicable' or 'not_applicable'",
          details: { path: `${path}.payload.status`, status: status ?? undefined },
        },
      };
    }
  }

  const result: CreateEvidenceInput = {
    controlId: controlId.trim(),
    type: type as EvidenceType,
    actorId: actorId.trim(),
    outcome: outcome as "pass" | "fail" | "unknown",
  };
  if (typeof obj.sourceId === "string" && obj.sourceId.trim() !== "") {
    result.sourceId = obj.sourceId.trim();
  }
  if (typeof obj.frameworkRequirementId === "string" && obj.frameworkRequirementId.trim() !== "") {
    result.frameworkRequirementId = obj.frameworkRequirementId.trim();
  }
  if (typeof obj.timestamp === "number" && Number.isFinite(obj.timestamp)) {
    result.timestamp = obj.timestamp;
  }
  if (obj.payload !== undefined && obj.payload !== null && typeof obj.payload === "object" && !Array.isArray(obj.payload)) {
    result.payload = obj.payload as Record<string, unknown>;
  }
  if (typeof obj.artifactRef === "string" && obj.artifactRef.trim() !== "") {
    result.artifactRef = obj.artifactRef.trim();
  }
  return { ok: true, value: result };
}

/** Create check input: Omit<CheckDefinition, "id" | "createdAt" | "updatedAt"> */
export type CreateCheckInput = Omit<CheckDefinition, "id" | "createdAt" | "updatedAt">;

/**
 * Validate CreateCheckInput. Required: name, controlId (non-empty).
 * At least one of: schedule, trigger, (adapterName and adapterMethod), or customConfig must be present.
 */
export function validateCreateCheckInput(
  input: unknown,
  path: string = "input"
): ValidationOutcome<CreateCheckInput> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "Check definition must be an object",
        details: { path },
      },
    };
  }
  const obj = input as Record<string, unknown>;
  const name = obj.name;
  const controlId = obj.controlId;

  if (typeof name !== "string" || name.trim() === "") {
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "name is required and must be a non-empty string",
        details: { path: `${path}.name` },
      },
    };
  }
  if (typeof controlId !== "string" || controlId.trim() === "") {
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: "controlId is required and must be a non-empty string",
        details: { path: `${path}.controlId` },
      },
    };
  }

  const schedule = obj.schedule;
  const trigger = obj.trigger;
  const adapterName = obj.adapterName;
  const adapterMethod = obj.adapterMethod;
  const customConfig = obj.customConfig;

  const hasSchedule = typeof schedule === "string" && schedule.trim() !== "";
  const hasTrigger = typeof trigger === "string" && trigger.trim() !== "";
  const hasAdapter =
    typeof adapterName === "string" &&
    adapterName.trim() !== "" &&
    typeof adapterMethod === "string" &&
    adapterMethod.trim() !== "";
  const hasCustomConfig =
    customConfig !== null && typeof customConfig === "object" && !Array.isArray(customConfig);

  if (!hasSchedule && !hasTrigger && !hasAdapter && !hasCustomConfig) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message:
          "At least one of schedule, trigger, (adapterName and adapterMethod), or customConfig is required",
        details: { path },
      },
    };
  }

  const result: CreateCheckInput = {
    name: name.trim(),
    controlId: controlId.trim(),
  };
  if (hasSchedule) result.schedule = (schedule as string).trim();
  if (hasTrigger) result.trigger = (trigger as string).trim();
  if (typeof adapterName === "string" && adapterName.trim() !== "") {
    result.adapterName = (adapterName as string).trim();
  }
  if (typeof adapterMethod === "string" && adapterMethod.trim() !== "") {
    result.adapterMethod = (adapterMethod as string).trim();
  }
  if (hasCustomConfig) result.customConfig = customConfig as Record<string, unknown>;
  return { ok: true, value: result };
}
