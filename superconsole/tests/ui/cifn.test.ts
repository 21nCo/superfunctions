import { describe, expect, it } from 'vitest';
import { ciRunListAdminHref, normalizeCiRun } from '../../src/lib/components/cifn';

describe('CiFn console transport', () => {
  it('maps the visible status into the canonical JSON filter while preserving scope', () => {
    const href = ciRunListAdminHref(new URLSearchParams({
      status: 'failure',
      cursor: 'next-1',
      organizationId: 'org-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      environmentId: 'production',
    }));
    const url = new URL(href, 'http://superconsole.local');
    expect(url.pathname).toBe('/api/admin/v1/modules/cifn/runs');
    expect(url.searchParams.has('status')).toBe(false);
    expect(JSON.parse(url.searchParams.get('filter') ?? 'null')).toEqual({ status: 'failure' });
    expect(url.searchParams.get('cursor')).toBe('next-1');
    expect(Object.fromEntries(
      ['organizationId', 'workspaceId', 'projectId', 'environmentId']
        .map((key) => [key, url.searchParams.get(key)])
    )).toEqual({
      organizationId: 'org-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      environmentId: 'production',
    });
  });

  it('normalizes sparse and malformed function-owned run records without unsafe dereferences', () => {
    expect(normalizeCiRun({
      pipelineRef: null,
      trigger: 'manual',
      jobs: [null, { steps: [null, {}] }],
    }, 'run-from-route')).toEqual({
      runId: 'run-from-route',
      pipelineRef: { repo: 'Repository unavailable', ref: 'Ref unavailable', configPath: undefined },
      trigger: { type: 'Trigger unavailable' },
      status: 'unknown',
      createdAt: undefined,
      updatedAt: undefined,
      jobs: [{
        id: 'run-from-route:job:2',
        jobKey: 'Job 2',
        status: 'unknown',
        startedAt: undefined,
        steps: [{
          id: 'Job 2:step:2',
          stepKey: 'Step 2',
          status: 'unknown',
          completedAt: undefined,
        }],
      }],
    });
    expect(normalizeCiRun(null, 'run-from-route')).toBeUndefined();
  });
});
