import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import api, { describeError, saveSession } from '../api/client';
import Field from '../components/Field';
import Alert from '../components/Alert';
import Spinner from '../components/Spinner';

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Where the visitor was headed before ProtectedRoute intercepted them.
  const destination = location.state?.from || '/dashboard';

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post('/api/auth/login', { email, password });
      saveSession(data);
      navigate(destination, { replace: true });
    } catch (err) {
      setError(describeError(err, 'Sign-in failed. Please try again.').message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main id="main" className="page page--form" style={{ maxWidth: 420 }}>
      <div className="stack stack--loose" style={{ marginTop: 'var(--space-6)' }}>
        <header className="stack stack--tight" style={{ textAlign: 'center' }}>
          <div className="brand" style={{ justifyContent: 'center' }}>
            <span className="brand__mark" aria-hidden="true">
              QC
            </span>
          </div>
          <h1 style={{ marginTop: 'var(--space-3)' }}>Staff sign in</h1>
          <p className="page-intro" style={{ margin: '0 auto' }}>
            For hotel front-desk staff. Guests do not need an account.
          </p>
        </header>

        <form onSubmit={handleSubmit} className="card stack" noValidate>
          <Field
            label="Email"
            type="email"
            required
            value={email}
            autoComplete="username"
            onChange={(e) => setEmail(e.target.value)}
          />
          <Field
            label="Password"
            type="password"
            required
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
          />

          {error && <Alert tone="error">{error}</Alert>}

          <button type="submit" className="btn btn--block" disabled={loading}>
            {loading ? (
              <>
                <Spinner label="Signing in" />
                Signing in…
              </>
            ) : (
              'Sign in'
            )}
          </button>
        </form>
      </div>
    </main>
  );
}
