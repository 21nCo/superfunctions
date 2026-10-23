import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth';

export function Login() {
  const [searchParams] = useSearchParams();
  const messageFromUrl = searchParams.get('message');
  const { setToken } = useAuth();
  const [value, setValue] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const t = value.trim();
    if (t) {
      setToken(t);
      setSubmitted(true);
    }
  };

  return (
    <div className="page login">
      <h1>CiFn Dashboard</h1>
      <p>Enter your API key (or Bearer token). Same as <code>CIFN_API_KEY</code> for the CLI.</p>
      {messageFromUrl && <p className="error">{decodeURIComponent(messageFromUrl)}</p>}
      <form onSubmit={handleSubmit}>
        <input
          type="password"
          placeholder="API key"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
        />
        <button type="submit">Sign in</button>
      </form>
      {submitted && <p className="success">Token saved. You can go to the run list.</p>}
    </div>
  );
}
