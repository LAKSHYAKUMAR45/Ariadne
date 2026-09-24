import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useAuth } from './AuthProvider';

export function LoginPage() {
  const { error, clearError, login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const errorRef = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    if (error) {
      errorRef.current?.focus();
    }
  }, [error]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    clearError();

    try {
      await login(username, password);
      setPassword('');
    } catch {
      // AuthProvider surfaces the structured failure message for the form.
    } finally {
      setSubmitting(false);
    }
  }

  function updateUsername(event: ChangeEvent<HTMLInputElement>): void {
    clearError();
    setUsername(event.target.value);
  }

  function updatePassword(event: ChangeEvent<HTMLInputElement>): void {
    clearError();
    setPassword(event.target.value);
  }

  return (
    <main className="login-shell" aria-label="Administrator sign in">
      <section className="login-story" aria-labelledby="login-title">
        <div className="brand-lockup brand-lockup--large">
          <span className="brand-mark" aria-hidden="true">A</span>
          <span>ARIADNE</span>
        </div>
        <p className="eyebrow">Operations console</p>
        <h1 id="login-title">Command your Ariadne cloud</h1>
        <p className="login-copy">
          Inspect synced work, captured files, backups, and the health of nodem2 from one focused
          control surface.
        </p>
        <div className="login-signal" aria-label="Connection details">
          <span className="signal-dot" aria-hidden="true" />
          <span>Private tunnel</span>
          <strong>127.0.0.1:14300</strong>
        </div>
      </section>

      <section className="login-panel" aria-label="Administrator login">
        <p className="eyebrow">Restricted access</p>
        <h2>Sign in as administrator</h2>
        <p className="muted">Use the credentials registered for this Ariadne server.</p>
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="username">Username</label>
          <input
            id="username"
            name="username"
            autoComplete="username"
            required
            value={username}
            onChange={updateUsername}
          />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={updatePassword}
          />
          {error ? (
            <p ref={errorRef} className="form-error" role="alert" tabIndex={-1}>
              {error}
            </p>
          ) : null}
          <button className="primary-action" type="submit" disabled={submitting}>
            {submitting ? 'Signing in...' : 'Open console'}
          </button>
        </form>
        <p className="login-footnote">Available only through the configured SSH tunnel.</p>
      </section>
    </main>
  );
}
