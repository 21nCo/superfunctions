/**
 * CompFn config, EvidenceAdapter, and CompFnAPI interface (method signatures only).
 */

import type { Adapter } from "@superfunctions/db";
import type { CompfnEnvelope } from "./errors.js";
import type { Control, CreateControlInput, UpdateControlInput } from "./control.js";
import type { Framework, CreateFrameworkInput } from "./framework.js";
import type { Evidence, EvidenceType, CreateEvidenceInput } from "./evidence.js";
import type { CheckDefinition, RunCheckResult } from "./check.js";
import type { ControlReadiness, FrameworkReadiness } from "./readiness.js";
import type { AuditorPack } from "./export-types.js";
import type { AdapterCheckInput, AdapterEvidence, EvidenceAdapter } from "./adapters/types.js";
import type { Logger } from "./logger.js";

export type { AdapterCheckInput, AdapterEvidence, EvidenceAdapter };

export interface CompFnConfig {
  database: Adapter;
  namespace?: string;
  systemActorId?: string;
  readinessWindowDays?: number;
  evidencePayloadMaxBytes?: number;
  retentionDays?: number;
  exportMaxBytes?: number;
  adapters?: Record<string, EvidenceAdapter>;
  logger?: Logger;
}

export interface CompFnAPI {
  controls: {
    create(input: CreateControlInput): Promise<CompfnEnvelope<Control>>;
    get(id: string): Promise<CompfnEnvelope<Control>>;
    list(filters?: { category?: string; tags?: string[] }): Promise<CompfnEnvelope<Control[]>>;
    update(id: string, input: UpdateControlInput): Promise<CompfnEnvelope<Control>>;
    delete(id: string): Promise<CompfnEnvelope<void>>;
  };
  frameworks: {
    create(input: CreateFrameworkInput): Promise<CompfnEnvelope<Framework>>;
    get(id: string): Promise<CompfnEnvelope<Framework>>;
    list(): Promise<CompfnEnvelope<Framework[]>>;
    update(id: string, input: Partial<CreateFrameworkInput>): Promise<CompfnEnvelope<Framework>>;
    delete(id: string): Promise<CompfnEnvelope<void>>;
  };
  evidence: {
    create(input: CreateEvidenceInput): Promise<CompfnEnvelope<Evidence>>;
    get(id: string): Promise<CompfnEnvelope<Evidence>>;
    list(filters: {
      controlId?: string;
      frameworkId?: string;
      type?: EvidenceType;
      since?: number;
    }): Promise<CompfnEnvelope<Evidence[]>>;
  };
  checks: {
    create(
      definition: Omit<CheckDefinition, "id" | "createdAt" | "updatedAt">
    ): Promise<CompfnEnvelope<CheckDefinition>>;
    get(id: string): Promise<CompfnEnvelope<CheckDefinition>>;
    list(): Promise<CompfnEnvelope<CheckDefinition[]>>;
    run(id: string): Promise<CompfnEnvelope<RunCheckResult>>;
    delete(id: string): Promise<CompfnEnvelope<void>>;
  };
  readiness: {
    forControl(controlId: string, frameworkId?: string): Promise<CompfnEnvelope<ControlReadiness>>;
    forFramework(frameworkId: string): Promise<CompfnEnvelope<FrameworkReadiness>>;
  };
  export: {
    auditorPack(options: {
      frameworkId?: string;
      since?: number;
    }): Promise<CompfnEnvelope<AuditorPack>>;
  };
}
