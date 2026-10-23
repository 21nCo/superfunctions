import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { getJobLogs } from '../api';

export function LogsView() {
  const { runId, jobKey } = useParams<{ runId: string; jobKey: string }>();
  const { getToken } = useAuth();
  const navigate = useNavigate();
  const [lines, setLines] = useState<Array<{ line: string; timestamp?: string; stepKey?: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!getToken()) {
      navigate('/login?message=Authentication+required');
      return;
    }
    if (!runId || !jobKey) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getJobLogs(runId, jobKey, getToken)
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setLines(res.data.lines ?? []);
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
  }, [runId, jobKey, getToken, navigate]);

  if (loading) return <p className="loading">Loading logs…</p>;
  if (error) return <p className="error">Error: {error}</p>;

  return (
    <div className="page logs-view">
      <nav>
        <Link to={`/runs/${runId}`}>← Run {runId?.slice(0, 8)}…</Link>
      </nav>
      <h1>Logs: {jobKey}</h1>
      <pre className="log-viewer">
        {lines.length === 0
          ? '(no log lines)'
          : lines.map((l, i) => (
              <span key={i}>
                {l.timestamp ? `[${l.timestamp}] ` : ''}
                {l.line}
                {'\n'}
              </span>
            ))}
      </pre>
    </div>
  );
}
