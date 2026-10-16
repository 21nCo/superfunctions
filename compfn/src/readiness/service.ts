/**
 * Readiness service: forControl, forFramework.
 *
 * Policy (deterministic; same evidence set + config → same status):
 * - not_applicable: when the latest scoping_decision evidence (by evidence.timestamp) for the control
 *   has payload.status === "not_applicable". Latest = highest timestamp; tie-break by createdAt then id.
 * - compliant: when applicable and there is at least one evidence record with outcome "pass"
 *   (excluding type scoping_decision) and evidence.timestamp within the policy window
 *   (readinessWindowDays days from now; config.readinessWindowDays ?? 90).
 * - not_compliant: when applicable and no such pass evidence exists within the window.
 *
 * All timestamps in ms (Unix). Window: now - (readinessWindowDays * 24 * 60 * 60 * 1000).
 */

import type { CompfnEnvelope } from "../errors.js";
import type { ControlReadiness, FrameworkReadiness, ReadinessStatus } from "../readiness.js";
import type { Evidence } from "../evidence.js";
import type { Framework } from "../framework.js";
import { READINESS_WINDOW_DAYS_DEFAULT } from "../constants.js";

export interface ReadinessServiceConfig {
  /** Get control by id; returns envelope (CONTROL_NOT_FOUND when missing). */
  getControl: (id: string) => Promise<CompfnEnvelope<{ id: string }>>;
  /** Get framework by id; returns envelope (FRAMEWORK_NOT_FOUND when missing). */
  getFramework: (id: string) => Promise<CompfnEnvelope<Framework>>;
  /** List evidence for a control (no since filter; we apply window in logic). */
  listEvidence: (controlId: string) => Promise<CompfnEnvelope<Evidence[]>>;
  /** Policy window in days. Evidence with timestamp within this many days from now counts for compliant. */
  readinessWindowDays?: number;
}

function now(): number {
  return Date.now();
}

/**
 * Latest scoping_decision for control: the one with greatest timestamp; tie-break by createdAt, then id.
 * Returns undefined if no scoping_decision evidence.
 */
function latestScopingDecision(evidence: Evidence[]): Evidence | undefined {
  const scoping = evidence.filter((e) => e.type === "scoping_decision");
  if (scoping.length === 0) return undefined;
  scoping.sort((a, b) => {
    if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return b.id.localeCompare(a.id);
  });
  return scoping[0];
}

/**
 * Evidence that counts for pass-within-window: type !== scoping_decision, outcome === "pass", timestamp >= windowStart.
 */
function hasPassInWindow(
  evidence: Evidence[],
  windowStartMs: number
): { compliant: boolean; lastEvidenceAt?: number; lastEvidenceId?: string } {
  let maxTs = -1;
  let lastEvidenceId: string | undefined;
  let foundPassInWindow = false;
  for (const e of evidence) {
    if (e.timestamp > maxTs) {
      maxTs = e.timestamp;
      lastEvidenceId = e.id;
    }
    if (e.type === "scoping_decision") continue;
    if (e.outcome === "pass" && e.timestamp >= windowStartMs) {
      foundPassInWindow = true;
    }
  }
  return {
    compliant: foundPassInWindow,
    lastEvidenceAt: maxTs >= 0 ? maxTs : undefined,
    lastEvidenceId,
  };
}

/**
 * Requirement IDs (from the given framework) that map to this controlId.
 */
function requirementIdsForControl(framework: Framework, controlId: string): string[] {
  const ids: string[] = [];
  for (const req of framework.requirements) {
    if (req.controlIds.includes(controlId)) {
      ids.push(req.requirementId);
    }
  }
  return ids;
}

export function createReadinessService(config: ReadinessServiceConfig) {
  const windowDays = config.readinessWindowDays ?? READINESS_WINDOW_DAYS_DEFAULT;
  const windowMs = windowDays * 24 * 60 * 60 * 1000;

  async function computeControlReadiness(
    controlId: string,
    frameworkId?: string
  ): Promise<CompfnEnvelope<ControlReadiness>> {
    const controlRes = await config.getControl(controlId);
    if (!controlRes.ok) {
      return controlRes;
    }

    const evidenceRes = await config.listEvidence(controlId);
    if (!evidenceRes.ok) {
      return evidenceRes;
    }
    const evidence = evidenceRes.result;

    const latestScoping = latestScopingDecision(evidence);
    if (
      latestScoping &&
      (latestScoping.payload?.status as string) === "not_applicable"
    ) {
      const byTs = [...evidence].sort((a, b) => b.timestamp - a.timestamp);
      const last = byTs[0];
      const result: ControlReadiness = {
        controlId,
        status: "not_applicable",
        lastEvidenceAt: last ? last.timestamp : undefined,
        lastEvidenceId: last ? last.id : undefined,
      };
      if (frameworkId) {
        const fwRes = await config.getFramework(frameworkId);
        if (!fwRes.ok) return fwRes;
        if (fwRes.ok) {
          result.requirementIds = requirementIdsForControl(fwRes.result, controlId);
        }
      }
      return { ok: true, result };
    }

    const windowStart = now() - windowMs;
    const { compliant, lastEvidenceAt, lastEvidenceId } = hasPassInWindow(
      evidence,
      windowStart
    );
    const status: ReadinessStatus = compliant ? "compliant" : "not_compliant";
    const result: ControlReadiness = {
      controlId,
      status,
      lastEvidenceAt,
      lastEvidenceId,
    };
    if (frameworkId) {
      const fwRes = await config.getFramework(frameworkId);
      if (!fwRes.ok) return fwRes;
        if (fwRes.ok) {
        result.requirementIds = requirementIdsForControl(fwRes.result, controlId);
      }
    }
    return { ok: true, result };
  }

  return {
    async forControl(
      controlId: string,
      frameworkId?: string
    ): Promise<CompfnEnvelope<ControlReadiness>> {
      return computeControlReadiness(controlId, frameworkId);
    },

    async forFramework(
      frameworkId: string
    ): Promise<CompfnEnvelope<FrameworkReadiness>> {
      const fwRes = await config.getFramework(frameworkId);
      if (!fwRes.ok) {
        return fwRes;
      }
      const framework = fwRes.result;

      const controlIds = new Set<string>();
      for (const req of framework.requirements) {
        for (const cid of req.controlIds) {
          controlIds.add(cid);
        }
      }

      const controlReadiness: ControlReadiness[] = [];
      let frameworkStatus: ReadinessStatus = "compliant";
      for (const cid of controlIds) {
        const cr = await computeControlReadiness(cid, frameworkId);
        if (!cr.ok) {
          return cr;
        }
        controlReadiness.push(cr.result);
        if (cr.result.status === "not_compliant") {
          frameworkStatus = "not_compliant";
        }
      }

      return {
        ok: true,
        result: {
          frameworkId,
          status: frameworkStatus,
          controlReadiness,
          lastUpdated: now(),
        },
      };
    },
  };
}
