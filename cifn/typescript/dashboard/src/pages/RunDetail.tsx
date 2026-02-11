import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { getRun, type Run } from '../api';

export function RunDetail() {
  const { runId } = useParams<{ runId: string }>();
  const { getToken } = useAuth();
  const navigate = useNavigate();
  const [run, setRun] = useState<Run | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getToken()) {
      navigate('/login?message=Authentication+required');
      return;
    }
    if (!runId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getRun(runId, getToken)
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setRun(res.data);
        } else {
          if (res.status === 401) {
            navigate('/login?message=Authentication+required');
            return;
          }
          setError(res.error?.message ?? `HTTP ${res.status}`);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(String(err?.message ?? err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, getToken, navigate]);

  if (loading) return <p className="loading">Loading run…</p>;
  if (error) return <p className="error">Error: {error}</p>;
  if (!run) return <p className="error">Run not found.</p>;

  return (
    <div className="page run-detail">
      <nav>
        <Link to="/">← Runs</Link>
      </nav>
      <h1>Run {run.runId.slice(0, 8)}…</h1>
      <p>
        <span className={`status status-${run.status}`}>{run.status}</span>
        {' · '}
        Trigger: {run.trigger?.type ?? '—'}
        {' · '}
        Created: {run.createdAt ? new Date(run.createdAt).toLocaleString() : '—'}
      </p>

      <h2>Jobs</h2>
      <table>
        <thead>
          <tr>
            <th>Job</th>
            <th>Status</th>
            <th>Steps</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {run.jobs?.map((job) => (
            <tr key={job.id}>
              <td className="mono">{job.jobKey}</td>
              <td>
                <span className={`status status-${job.status}`}>{job.status}</span>
              </td>
              <td>
                {job.steps?.length ?? 0} steps (
                {job.steps?.map((s) => s.status).join(', ') ?? '—'})
              </td>
              <td>
                <Link to={`/runs/${run.runId}/jobs/${job.jobKey}/logs`}>Logs</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p>
        <Link to={`/runs/${run.runId}/artifacts`}>View artifacts</Link>
      </p>
    </div>
  );
}
