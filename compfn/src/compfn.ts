/**
 * compFn(config) factory: returns CompFnAPI with controls, frameworks, evidence, checks, readiness, and export.
 */

import type { CompFnAPI, CompFnConfig } from "./api.js";
import { createControlsService } from "./controls/service.js";
import { createFrameworksService } from "./frameworks/service.js";
import { createEvidenceService } from "./evidence/service.js";
import { createChecksService } from "./checks/service.js";
import { createReadinessService } from "./readiness/service.js";
import { createExportService } from "./export/service.js";

/**
 * Create CompFn API instance. Returns API with controls.*, frameworks.*, and evidence.* (create, get, list) implemented.
 */
export function compFn(config: CompFnConfig): CompFnAPI {
  const controls = createControlsService({
    database: config.database,
    namespace: config.namespace,
  });

  const frameworks = createFrameworksService({
    database: config.database,
    namespace: config.namespace,
    existsControl: (controlId) => controls.get(controlId).then((r) => r.ok),
  });

  const evidence = createEvidenceService({
    database: config.database,
    namespace: config.namespace,
    evidencePayloadMaxBytes: config.evidencePayloadMaxBytes,
    existsControl: (controlId) => controls.get(controlId).then((r) => r.ok),
    getFramework: async (frameworkId) => {
      const r = await frameworks.get(frameworkId);
      return r.ok ? r.result : null;
    },
    logger: config.logger,
  });

  const checks = createChecksService({
    database: config.database,
    namespace: config.namespace,
    existsControl: (controlId) => controls.get(controlId).then((r) => r.ok),
    getAdapter: (adapterName) => config.adapters?.[adapterName],
    systemActorId: config.systemActorId,
    evidenceCreate: (input) => evidence.create(input),
    logger: config.logger,
  });

  const readiness = createReadinessService({
    getControl: (id) => controls.get(id),
    getFramework: (id) => frameworks.get(id),
    listEvidence: (controlId) => evidence.list({ controlId }),
    readinessWindowDays: config.readinessWindowDays,
  });

  const exportService = createExportService({
    getFramework: (id) => frameworks.get(id),
    listFrameworks: () => frameworks.list(),
    getControl: (id) => controls.get(id),
    listControls: (filters) => controls.list(filters),
    listEvidence: (filters) => evidence.list(filters ?? {}),
    exportMaxBytes: config.exportMaxBytes,
    logger: config.logger,
  });

  return {
    controls: {
      create: (input) => controls.create(input),
      get: (id) => controls.get(id),
      list: (filters) => controls.list(filters),
      update: (id, input) => controls.update(id, input),
      delete: (id) => controls.delete(id),
    },
    frameworks: {
      create: (input) => frameworks.create(input),
      get: (id) => frameworks.get(id),
      list: () => frameworks.list(),
      update: (id, input) => frameworks.update(id, input),
      delete: (id) => frameworks.delete(id),
    },
    evidence: {
      create: (input) => evidence.create(input),
      get: (id) => evidence.get(id),
      list: (filters) => evidence.list(filters ?? {}),
    },
    checks: {
      create: (definition) => checks.create(definition),
      get: (id) => checks.get(id),
      list: () => checks.list(),
      run: (id) => checks.run(id),
      delete: (id) => checks.delete(id),
    },
    readiness: {
      forControl: (controlId, frameworkId) =>
        readiness.forControl(controlId, frameworkId),
      forFramework: (frameworkId) => readiness.forFramework(frameworkId),
    },
    export: {
      auditorPack: (options) => exportService.auditorPack(options ?? {}),
    },
  };
}
