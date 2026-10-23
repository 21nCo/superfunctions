import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { getArtifacts, type Artifact } from '../api';

export function ArtifactsList() {
  const { runId } = useParams<{ runId: string }>();
  const { getToken } = useAuth();
  const navigate = useNavigate();
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
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
    getArtifacts(runId, getToken)
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setArtifacts(res.data.artifacts ?? []);
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

  if (loading) return <p className="loading">Loading artifacts…</p>;
  if (error) return <p className="error">Error: {error}</p>;

  return (
    <div className="page artifacts-list">
      <nav>
        <Link to={`/runs/${runId}`}>← Run {runId?.slice(0, 8)}…</Link>
      </nav>
      <h1>Artifacts</h1>
      {artifacts.length === 0 ? (
        <p>No artifacts for this run.</p>
      ) : (
        <ul>
          {artifacts.map((a) => (
            <li key={a.name}>
              {a.url ? (
                <a href={a.url} target="_blank" rel="noreferrer">
                  {a.name}
                </a>
              ) : (
                <span>{a.name}</span>
              )}
              {a.fileId && !a.url && <span className="muted"> (fileId: {a.fileId})</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
