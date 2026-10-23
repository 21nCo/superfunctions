/**
 * CiFn control plane API client.
 * Auth: CIFN_API_KEY from env, or token from login; sent as Bearer or X-API-Key on every request.
 */

const API_BASE = import.meta.env.VITE_CIFN_API_URL || '';

export type RunStatus = 'queued' | 'running' | 'success' | 'failure' | 'cancelled';
export type JobStatus = 'pending' | 'running' | 'success' | 'failure' | 'skipped';
export type StepStatus = 'pending' | 'running' | 'success' | 'failure' | 'skipped';

export interface Step {
  id: string;
  jobId: string;
  stepKey: string;
  status: StepStatus;
  logRef?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface Job {
  id: string;
  runId: string;
  jobKey: string;
  status: JobStatus;
  steps: Step[];
  startedAt?: string;
  completedAt?: string;
}

export interface Run {
  runId: string;
  pipelineRef: { repo: string; ref: string; configPath?: string };
  trigger: { type: string; payload?: Record<string, unknown> };
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  jobs: Job[];
}

export interface ListRunsResponse {
  runs: Run[];
  nextCursor?: string | null;
}

export interface LogLine {
  line: string;
  timestamp: string;
  stepKey: string;
}

export interface LogsResponse {
  lines: LogLine[];
}

export interface Artifact {
  name: string;
  fileId?: string;
  url?: string;
}

export interface ArtifactsResponse {
  artifacts: Artifact[];
}

export interface ApiError {
  ok: false;
  error: { code: string; message: string; details?: Record<string, unknown> };
}

function isApiError(r: unknown): r is ApiError {
  return typeof r === 'object' && r !== null && 'ok' in r && (r as { ok: unknown }).ok === false;
}

export type GetToken = () => string | null;

function buildUrl(path: string): string {
  const base = API_BASE.replace(/\/$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return base ? `${base}${p}` : p;
}

export async function apiRequest<T>(
  path: string,
  getToken: GetToken,
  options: RequestInit = {}
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: ApiError['error'] }> {
  const token = getToken();
  const headers = new Headers(options.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
    headers.set('X-API-Key', token);
  }
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const url = buildUrl(path);
  const res = await fetch(url, { ...options, headers });
  const contentType = res.headers.get('content-type');
  let data: unknown;
  if (contentType?.includes('application/json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }
  if (!res.ok) {
    const err = typeof data === 'object' && data !== null && 'error' in (data as object)
      ? (data as ApiError).error
      : { code: 'HTTP_ERROR', message: `HTTP ${res.status}` };
    return { ok: false, status: res.status, error: err };
  }
  if (isApiError(data)) {
    return { ok: false, status: res.status, error: data.error };
  }
  const out = typeof data === 'object' && data !== null && 'data' in (data as object)
    ? (data as { data: T }).data
    : data;
  return { ok: true, data: out as T };
}

export async function listRuns(
  getToken: GetToken,
  params?: { limit?: number; cursor?: string; status?: string }
): Promise<{ ok: true; data: ListRunsResponse } | { ok: false; status: number; error: ApiError['error'] }> {
  const sp = new URLSearchParams();
  if (params?.limit != null) sp.set('limit', String(params.limit));
  if (params?.cursor) sp.set('cursor', params.cursor);
  if (params?.status) sp.set('status', params.status);
  const q = sp.toString();
  return apiRequest<ListRunsResponse>(`/api/v1/runs${q ? `?${q}` : ''}`, getToken);
}

export async function getRun(
  runId: string,
  getToken: GetToken
): Promise<{ ok: true; data: Run } | { ok: false; status: number; error: ApiError['error'] }> {
  return apiRequest<Run>(`/api/v1/runs/${encodeURIComponent(runId)}`, getToken);
}

export async function getJobLogs(
  runId: string,
  jobKey: string,
  getToken: GetToken
): Promise<{ ok: true; data: LogsResponse } | { ok: false; status: number; error: ApiError['error'] }> {
  return apiRequest<LogsResponse>(
    `/api/v1/runs/${encodeURIComponent(runId)}/jobs/${encodeURIComponent(jobKey)}/logs`,
    getToken
  );
}

export async function getArtifacts(
  runId: string,
  getToken: GetToken
): Promise<{ ok: true; data: ArtifactsResponse } | { ok: false; status: number; error: ApiError['error'] }> {
  return apiRequest<ArtifactsResponse>(`/api/v1/runs/${encodeURIComponent(runId)}/artifacts`, getToken);
}
