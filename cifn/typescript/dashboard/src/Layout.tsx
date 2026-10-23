import { Link } from 'react-router-dom';
import { useAuth } from './auth';

export function Layout({ children }: { children: React.ReactNode }) {
  const { token, setToken } = useAuth();

  return (
    <div className="layout">
      <header>
        <Link to="/" className="brand">CiFn</Link>
        <nav>
          <Link to="/">Runs</Link>
          {token && (
            <button
              type="button"
              className="logout"
              onClick={() => setToken(null)}
              aria-label="Sign out"
            >
              Sign out
            </button>
          )}
        </nav>
      </header>
      <main>{children}</main>
    </div>
  );
}
