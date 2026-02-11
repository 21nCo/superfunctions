import Ajv2020 from 'ajv/dist/2020';
import pipelineSchema from '../../../../schemas/pipeline.schema.json';
import type { PipelineSpec, ValidationResult, JobSpec } from './types.js';
import { validateExpression, EXPR_MAX_LENGTH } from '../expressions/eval.js';

const ajv = new Ajv2020({ allErrors: true });
const schemaValidate = ajv.compile<PipelineSpec>(pipelineSchema);

/** Normalize on.schedule to array form if it is an object (single cron). */
function normalizeScheduleInPlace(spec: PipelineSpec): void {
  const on = spec.on as Record<string, unknown>;
  const schedule = on?.schedule;
  if (schedule === undefined) return;
  if (Array.isArray(schedule)) return;
  if (schedule && typeof schedule === 'object' && 'cron' in schedule) {
    on.schedule = [schedule as { cron: string }];
  }
}

/**
 * Validates cron string has 5 fields (minute hour day month day-of-week).
 * Accepts * and numeric ranges/steps; rejects obviously invalid values.
 */
function isValidCronExpression(cron: string): boolean {
  const trimmed = cron.trim();
  if (!trimmed) return false;
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return false;
  const cronField = /^(\*|(\d{1,2}(-\d{1,2})?)(\/\d+)?|(\d{1,2}(,\d{1,2})*))$/;
  for (const p of parts) {
    if (!p) return false;
    if (p === '*') continue;
    if (!/^[\d*,\-\/]+$/.test(p)) return false;
  }
  return true;
}

export function validate(input: unknown): ValidationResult {
  if (!schemaValidate(input)) {
    const errors = schemaValidate.errors ?? [];
    const messages = errors.map(e => `${e.instancePath || '/'}: ${e.message}`).join('; ');
    return {
      ok: false,
      code: 'PIPELINE_INVALID',
      message: `Schema validation failed: ${messages}`,
      details: { errors },
    };
  }

  const spec: PipelineSpec = input as PipelineSpec;
  normalizeScheduleInPlace(spec);

  if (spec.on.schedule) {
    for (let i = 0; i < spec.on.schedule.length; i++) {
      const entry = spec.on.schedule[i];
      const cron = entry?.cron;
      if (typeof cron !== 'string' || !isValidCronExpression(cron)) {
        return {
          ok: false,
          code: 'PIPELINE_INVALID',
          message: `Invalid cron expression at on.schedule[${i}]: expected 5-field cron (e.g. "0 2 * * *")`,
        };
      }
    }
  }

  const jobKeys = Object.keys(spec.jobs);
  if (jobKeys.length > 100) {
    return {
      ok: false,
      code: 'PIPELINE_INVALID',
      message: `Too many jobs: ${jobKeys.length} exceeds maximum of 100`,
    };
  }

  for (const [key, job] of Object.entries(spec.jobs)) {
    if (job.steps.length > 100) {
      return {
        ok: false,
        code: 'PIPELINE_INVALID',
        message: `Job "${key}" has ${job.steps.length} steps, exceeding maximum of 100`,
      };
    }
  }

  for (const [key, job] of Object.entries(spec.jobs)) {
    if (job.needs) {
      for (const dep of job.needs) {
        if (!spec.jobs[dep]) {
          return {
            ok: false,
            code: 'PIPELINE_INVALID',
            message: `Job "${key}" has unknown dependency "${dep}" in needs`,
          };
        }
      }
    }
  }

  const cycleResult = detectCycle(spec.jobs);
  if (cycleResult) {
    return {
      ok: false,
      code: 'PIPELINE_INVALID',
      message: `Cyclic dependency detected: ${cycleResult}`,
    };
  }

  const depthResult = checkNeedsDepth(spec.jobs);
  if (depthResult) {
    return {
      ok: false,
      code: 'PIPELINE_INVALID',
      message: depthResult,
    };
  }

  // Expression length and grammar for job/step if (PIPE-010, TV-EXPR-006, TV-EXPR-008)
  for (const [jobKey, job] of Object.entries(spec.jobs)) {
    if (job.if !== undefined && job.if !== null) {
      const s = String(job.if).trim();
      if (Buffer.byteLength(s, 'utf8') > EXPR_MAX_LENGTH) {
        return {
          ok: false,
          code: 'PIPELINE_INVALID',
          message: `Job "${jobKey}" if expression exceeds maximum length of ${EXPR_MAX_LENGTH} characters`,
        };
      }
      try {
        validateExpression(s);
      } catch (e: unknown) {
        const err = e as Error & { code?: string };
        if (err.code === 'PIPELINE_INVALID') {
          return { ok: false, code: 'PIPELINE_INVALID', message: `Job "${jobKey}" if: ${err.message}` };
        }
        throw e;
      }
    }
    for (let i = 0; i < job.steps.length; i++) {
      const step = job.steps[i];
      const ifVal = 'if' in step ? step.if : undefined;
      if (ifVal !== undefined && ifVal !== null) {
        const s = String(ifVal).trim();
        if (Buffer.byteLength(s, 'utf8') > EXPR_MAX_LENGTH) {
          return {
            ok: false,
            code: 'PIPELINE_INVALID',
            message: `Job "${jobKey}" step ${i} if expression exceeds maximum length of ${EXPR_MAX_LENGTH} characters`,
          };
        }
        try {
          validateExpression(s);
        } catch (e: unknown) {
          const err = e as Error & { code?: string };
          if (err.code === 'PIPELINE_INVALID') {
            return { ok: false, code: 'PIPELINE_INVALID', message: `Job "${jobKey}" step ${i} if: ${err.message}` };
          }
          throw e;
        }
      }
    }
  }

  return { ok: true, spec };
}

function detectCycle(jobs: Record<string, JobSpec>): string | null {
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function dfs(node: string, path: string[]): string | null {
    if (visiting.has(node)) {
      const cycleStart = path.indexOf(node);
      return path.slice(cycleStart).concat(node).join(' -> ');
    }
    if (visited.has(node)) return null;

    visiting.add(node);
    path.push(node);

    const needs = jobs[node]?.needs ?? [];
    for (const dep of needs) {
      const result = dfs(dep, path);
      if (result) return result;
    }

    path.pop();
    visiting.delete(node);
    visited.add(node);
    return null;
  }

  for (const key of Object.keys(jobs)) {
    const result = dfs(key, []);
    if (result) return result;
  }

  return null;
}

function checkNeedsDepth(jobs: Record<string, JobSpec>): string | null {
  const memo = new Map<string, number>();

  function depth(key: string): number {
    if (memo.has(key)) return memo.get(key)!;

    const needs = jobs[key]?.needs ?? [];
    if (needs.length === 0) {
      memo.set(key, 0);
      return 0;
    }

    let maxChildDepth = 0;
    for (const dep of needs) {
      const d = depth(dep);
      if (d > maxChildDepth) maxChildDepth = d;
    }

    const result = maxChildDepth + 1;
    memo.set(key, result);
    return result;
  }

  for (const key of Object.keys(jobs)) {
    const d = depth(key);
    if (d > 10) {
      return `Job "${key}" has needs depth ${d}, exceeding maximum of 10`;
    }
  }

  return null;
}
