import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { listRuns, type Run } from '../api';

export function RunList() {
  const { getToken } = useAuth();
  const navigate = useNavigate();
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getToken()) {
      navigate('/login?message=Authentication+required');
      return;
    }
  }, [getToken, navigate]);

  useEffect(() => {
    if (!getToken()) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    listRuns(getToken, { limit: 50 })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setRuns(res.data.runs);
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
  }, [getToken, navigate]);

  if (loading) return <p className="loading">Loading runs…</p>;
  if (error) return <p className="error">Error: {error}</p>;

  return (
    <div className="page run-list">
      <h1>Runs</h1>
      <table>
        <thead>
          <tr>
            <th>Run ID</th>
            <th>Status</th>
            <th>Trigger</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {runs.length === 0 ? (
            <tr>
              <td colSpan={5}>No runs yet.</td>
            </tr>
          ) : (
            runs.map((run) => (
              <tr key={run.runId}>
                <td className="mono">{run.runId.slice(0, 8)}…</td>
                <td>
                  <span className={`status status-${run.status}`}>{run.status}</span>
                </td>
                <td>{run.trigger?.type ?? '—'}</td>
                <td>{run.createdAt ? new Date(run.createdAt).toLocaleString() : '—'}</td>
                <td>
                  <Link to={`/runs/${run.runId}`}>View</Link>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
