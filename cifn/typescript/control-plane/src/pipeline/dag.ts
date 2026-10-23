import type { PipelineSpec } from './types.js';

export interface DagResult {
  order: string[];
  rootJobs: string[];
  dependents: Map<string, string[]>;
}

export function resolveDAG(spec: PipelineSpec): DagResult {
  const jobs = spec.jobs;
  const jobKeys = Object.keys(jobs);

  const rootJobs: string[] = [];
  const dependents = new Map<string, string[]>();

  for (const key of jobKeys) {
    const needs = jobs[key].needs ?? [];
    if (needs.length === 0) {
      rootJobs.push(key);
    }
    for (const dep of needs) {
      const list = dependents.get(dep) ?? [];
      list.push(key);
      dependents.set(dep, list);
    }
  }

  const order = topologicalSort(jobs);

  return { order, rootJobs, dependents };
}

export function getReadyJobs(
  spec: PipelineSpec,
  completedJobs: Set<string>,
  enqueuedJobs: Set<string>,
): string[] {
  const ready: string[] = [];
  for (const [key, job] of Object.entries(spec.jobs)) {
    if (completedJobs.has(key) || enqueuedJobs.has(key)) continue;
    const needs = job.needs ?? [];
    if (needs.every(dep => completedJobs.has(dep))) {
      ready.push(key);
    }
  }
  return ready;
}

function topologicalSort(jobs: PipelineSpec['jobs']): string[] {
  const visited = new Set<string>();
  const result: string[] = [];

  function visit(key: string) {
    if (visited.has(key)) return;
    visited.add(key);
    const needs = jobs[key]?.needs ?? [];
    for (const dep of needs) {
      visit(dep);
    }
    result.push(key);
  }

  for (const key of Object.keys(jobs)) {
    visit(key);
  }

  return result;
}
