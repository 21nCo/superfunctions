/**
 * Export types: AuditorPack.
 */

import type { Control } from "./control.js";
import type { Framework } from "./framework.js";
import type { Evidence } from "./evidence.js";

export interface AuditorPack {
  exportedAt: number;
  frameworkId?: string;
  controls: Control[];
  frameworks: Framework[];
  evidence: Evidence[];
  mapping: Array<{ requirementId: string; controlIds: string[] }>;
}
