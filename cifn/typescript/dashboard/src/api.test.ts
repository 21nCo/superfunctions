/**
 * TV-DASH-001: Dashboard shows run list and detail; auth required.
 * - Unauthenticated: run list fails or prompts (401 or redirect to login).
 * - Authenticated: run list loads; run detail shows jobs, steps, logs link, artifact list.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  listRuns,
  getRun,
  getJobLogs,
  getArtifacts,
  apiRequest,
} from './api';

describe('Dashboard API client', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.stubGlobal('fetch', originalFetch);
  });

  it('sends Authorization header when getToken returns a value', async () => {
    const getToken = () => 'secret-key';
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true, data: { runs: [], nextCursor: null } }),
    });
    await listRuns(getToken);
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.any(Headers),
      })
    );
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const headers = call[1].headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer secret-key');
    expect(headers.get('X-API-Key')).toBe('secret-key');
  });

  it('calls GET /api/v1/runs for listRuns', async () => {
    const getToken = () => 'key';
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () =>
        Promise.resolve({
          ok: true,
          data: { runs: [{ runId: 'r1', status: 'success', createdAt: '', updatedAt: '', jobs: [], trigger: { type: 'workflow_dispatch' }, pipelineRef: { repo: '', ref: '' } }], nextCursor: null },
        }),
    });
    const res = await listRuns(getToken);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.runs).toHaveLength(1);
      expect(res.data.runs[0].runId).toBe('r1');
    }
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/runs'),
      expect.any(Object)
    );
  });

  it('TV-DASH-001: run list uses runId from API (no id)', async () => {
    const getToken = () => 'key';
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () =>
        Promise.resolve({
          ok: true,
          data: { runs: [{ runId: 'run_abc123', status: 'queued', createdAt: '', updatedAt: '', jobs: [], trigger: { type: 'workflow_dispatch' }, pipelineRef: { repo: '', ref: '' } }], nextCursor: null },
        }),
    });
    const res = await listRuns(getToken);
    expect(res.ok).toBe(true);
    if (res.ok) {
      const run = res.data.runs[0];
      expect(run.runId).toBe('run_abc123');
      expect((run as { id?: string }).id).toBeUndefined();
    }
  });

  it('TV-DASH-001N: run list renders without id (API returns runId only)', async () => {
    const getToken = () => 'key';
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () =>
        Promise.resolve({
          ok: true,
          data: { runs: [{ runId: 'r_xyz', status: 'success', createdAt: '2026-01-01T00:00:00Z', updatedAt: '', jobs: [], trigger: { type: 'workflow_dispatch' }, pipelineRef: { repo: '', ref: '' } }], nextCursor: null },
        }),
    });
    const res = await listRuns(getToken);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.runs[0].runId).toBe('r_xyz');
    }
  });

  it('calls GET /api/v1/runs/:runId for getRun', async () => {
    const getToken = () => 'key';
    const run = {
      runId: 'run-1',
      status: 'success' as const,
      createdAt: '',
      updatedAt: '',
      jobs: [],
      trigger: { type: 'workflow_dispatch' as const },
      pipelineRef: { repo: '', ref: '' },
    };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true, data: run }),
    });
    const res = await getRun('run-1', getToken);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.runId).toBe('run-1');
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/v1\/runs\/run-1$/),
      expect.any(Object)
    );
  });

  it('TV-DASH-001: getRun returns run with runId for navigation', async () => {
    const getToken = () => 'key';
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () =>
        Promise.resolve({
          ok: true,
          data: { runId: 'r_abc', status: 'running', createdAt: '', updatedAt: '', jobs: [{ id: 'j1', jobKey: 'build', status: 'running', steps: [] }], trigger: { type: 'workflow_dispatch' }, pipelineRef: { repo: '', ref: '' } },
        }),
    });
    const res = await getRun('r_abc', getToken);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.runId).toBe('r_abc');
    }
  });

  it('calls GET .../jobs/:jobKey/logs for getJobLogs', async () => {
    const getToken = () => 'key';
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true, data: { lines: [{ line: 'log line', timestamp: '', stepKey: 'step-0' }] } }),
    });
    const res = await getJobLogs('run-1', 'build', getToken);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.lines).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/v1\/runs\/run-1\/jobs\/build\/logs$/),
      expect.any(Object)
    );
  });

  it('calls GET .../artifacts for getArtifacts', async () => {
    const getToken = () => 'key';
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true, data: { artifacts: [{ name: 'dist', url: 'https://example.com/f' }] } }),
    });
    const res = await getArtifacts('run-1', getToken);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.artifacts).toHaveLength(1);
      expect(res.data.artifacts[0].name).toBe('dist');
      expect(res.data.artifacts[0].url).toBe('https://example.com/f');
    }
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/v1\/runs\/run-1\/artifacts$/),
      expect.any(Object)
    );
  });

  it('returns ok: false and status 401 when response is 401', async () => {
    const getToken = () => 'bad-key';
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token' } }),
    });
    const res = await apiRequest<{ runs: unknown[] }>('/api/v1/runs', getToken);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(401);
      expect(res.error.code).toBe('UNAUTHORIZED');
    }
  });
});
