import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';

const STATUS_OPTIONS = ['ALL', 'PENDING', 'APPROVED', 'CHECKED_IN', 'REJECTED'];

export default function Dashboard() {
  const navigate = useNavigate();
  const [registrations, setRegistrations] = useState([]);
  const [status, setStatus] = useState('ALL');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function load(signal) {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/api/registrations', {
        params: status === 'ALL' ? {} : { status },
        signal,
      });
      if (signal.aborted) return;
      setRegistrations(data);
    } catch (err) {
      // A superseded load - a newer filter is already in flight, so this
      // older answer must not be allowed to land on top of it.
      if (signal.aborted) return;
      if (err.response?.status === 401) {
        handleLogout();
        return;
      }
      setError('Failed to load registrations');
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }

  function handleLogout() {
    localStorage.removeItem('staffToken');
    localStorage.removeItem('staffName');
    navigate('/login');
  }

  const registerLink = `${window.location.origin}/register`;

  return (
    <div className="page">
      <header className="dashboard-header">
        <h1>Guest Registrations</h1>
        <button onClick={handleLogout} className="secondary">
          Log out
        </button>
      </header>

      <div className="card">
        <p>
          Share this link with guests: <a href="/register">{registerLink}</a>
        </p>
      </div>

      <div className="filters">
        {STATUS_OPTIONS.map((s) => (
          <button
            key={s}
            className={s === status ? 'chip active' : 'chip'}
            onClick={() => setStatus(s)}
          >
            {s}
          </button>
        ))}
      </div>

      {error && <p className="error">{error}</p>}
      {loading ? (
        <p>Loading…</p>
      ) : registrations.length === 0 ? (
        <p>No registrations yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Phone</th>
              <th>Check-in</th>
              <th>Check-out</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {registrations.map((r) => (
              <tr key={r.id}>
                <td>{r.fullName}</td>
                <td>{r.phone}</td>
                <td>{r.checkInDate ? new Date(r.checkInDate).toLocaleDateString() : '—'}</td>
                <td>{r.checkOutDate ? new Date(r.checkOutDate).toLocaleDateString() : '—'}</td>
                <td>
                  <span className={`status status-${r.status.toLowerCase()}`}>{r.status}</span>
                </td>
                <td>
                  <Link to={`/dashboard/${r.id}`}>View</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
