/**
 * Export service: auditorPack() builds AuditorPack with optional frameworkId/since filters
 * and enforces exportMaxBytes (EXPORT-001, LIMIT-001).
 */

import type { CompfnEnvelope } from "../errors.js";
import type { Control } from "../control.js";
import type { Framework } from "../framework.js";
import type { Evidence } from "../evidence.js";
import type { AuditorPack } from "../export-types.js";
import type { Logger } from "../logger.js";
import { EXPORT_MAX_BYTES_DEFAULT } from "../constants.js";
import { defaultLogger } from "../logger.js";

export interface ExportServiceConfig {
  /** Load single framework by id */
  getFramework: (id: string) => Promise<CompfnEnvelope<Framework>>;
  /** Load all frameworks */
  listFrameworks: () => Promise<CompfnEnvelope<Framework[]>>;
  /** Load single control by id */
  getControl: (id: string) => Promise<CompfnEnvelope<Control>>;
  /** Load all controls (no filter) or with optional filters */
  listControls: (filters?: { category?: string; tags?: string[] }) => Promise<CompfnEnvelope<Control[]>>;
  /** List evidence with optional controlId, frameworkId, type, since */
  listEvidence: (filters: {
    controlId?: string;
    frameworkId?: string;
    type?: string;
    since?: number;
  }) => Promise<CompfnEnvelope<Evidence[]>>;
  exportMaxBytes?: number;
  logger?: Logger;
}

/**
 * Build set of control IDs from framework(s) requirements.
 */
function controlIdsFromFrameworks(frameworks: Framework[]): Set<string> {
  const set = new Set<string>();
  for (const fw of frameworks) {
    for (const req of fw.requirements) {
      for (const cid of req.controlIds) {
        set.add(cid);
      }
    }
  }
  return set;
}

export function createExportService(config: ExportServiceConfig) {
  const exportMaxBytes = config.exportMaxBytes ?? EXPORT_MAX_BYTES_DEFAULT;
  const logger = config.logger ?? defaultLogger;

  return {
    async auditorPack(options: {
      frameworkId?: string;
      since?: number;
    }): Promise<CompfnEnvelope<AuditorPack>> {
      logger.info("export.requested", {
        event: "export.requested",
        frameworkId: options.frameworkId,
      });

      // 1) Load frameworks: one by id or all
      let frameworks: Framework[];
      if (options.frameworkId != null && options.frameworkId !== "") {
        const r = await config.getFramework(options.frameworkId);
        if (!r.ok) return r;
        frameworks = [r.result];
      } else {
        const r = await config.listFrameworks();
        if (!r.ok) return r;
        frameworks = r.result;
      }

      const controlIdSet = controlIdsFromFrameworks(frameworks);

      // 2) Load controls: scoped to framework controlIds or all
      let controls: Control[];
      if (options.frameworkId != null && options.frameworkId !== "") {
        controls = [];
        for (const cid of controlIdSet) {
          const r = await config.getControl(cid);
          if (r.ok) controls.push(r.result);
        }
      } else {
        const r = await config.listControls();
        if (!r.ok) return r;
        controls = r.result;
      }

      // 3) Load evidence: optional frameworkId and since
      const evidenceFilters: { frameworkId?: string; since?: number } = {};
      if (options.frameworkId != null && options.frameworkId !== "") {
        evidenceFilters.frameworkId = options.frameworkId;
      }
      if (options.since != null && Number.isFinite(options.since)) {
        evidenceFilters.since = options.since;
      }
      const evRes = await config.listEvidence(evidenceFilters);
      if (!evRes.ok) return evRes;
      const evidence = evRes.result;

      // 4) Build mapping from framework.requirements
      const mapping: Array<{ requirementId: string; controlIds: string[] }> = frameworks.flatMap((fw) =>
        fw.requirements.map((req) => ({
          requirementId: req.requirementId,
          controlIds: [...req.controlIds],
        }))
      );

      const result: AuditorPack = {
        exportedAt: Date.now(),
        frameworkId: options.frameworkId,
        controls,
        frameworks,
        evidence,
        mapping,
      };

      // 5) Size check
      const serialized = JSON.stringify(result);
      const size = new TextEncoder().encode(serialized).length;
      if (size > exportMaxBytes) {
        return {
          ok: false,
          error: {
            code: "EXPORT_FAILED",
            message: `Export size ${size} exceeds limit ${exportMaxBytes}`,
            details: { size, limit: exportMaxBytes },
          },
        };
      }

      logger.info("export.completed", {
        event: "export.completed",
        frameworkId: options.frameworkId,
        sizeBytes: size,
      });

      return { ok: true, result };
    },
  };
}
