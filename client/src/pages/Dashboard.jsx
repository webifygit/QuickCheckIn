import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api, { clearSession, describeError } from '../api/client';
import AppShell from '../components/AppShell';
import StatusBadge from '../components/StatusBadge';
import Alert from '../components/Alert';
import EmptyState from '../components/EmptyState';
import useMediaQuery from '../hooks/useMediaQuery';

const FILTERS = [
  { value: 'ALL', label: 'All' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'CHECKED_IN', label: 'Checked in' },
  { value: 'REJECTED', label: 'Rejected' },
];

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [registrations, setRegistrations] = useState([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState('ALL');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  // A six-column table is unreadable on a phone, so narrow screens get the same
  // rows as cards. Only one of the two is ever in the DOM.
  const isCompact = useMediaQuery('(max-width: 720px)');

  // Typing should not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const signOut = useCallback(() => {
    clearSession();
    navigate('/login', { replace: true });
  }, [navigate]);

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setLoading(true);
      setError('');
      try {
        const params = {};
        if (status !== 'ALL') params.status = status;
        if (debouncedSearch) params.search = debouncedSearch;

        const { data } = await api.get('/api/registrations', {
          params,
          signal: controller.signal,
        });
        setRegistrations(data.registrations || []);
        setTotal(data.total ?? 0);
      } catch (err) {
        const described = describeError(err, 'Could not load registrations.');
        // A superseded load - a newer filter is already in flight, so this
        // older answer must not be allowed to land on top of it.
        if (described.cancelled) return;
        if (described.status === 401) {
          signOut();
          return;
        }
        setError(described.message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    load();
    return () => controller.abort();
  }, [status, debouncedSearch, signOut]);

  const registerLink = `${window.location.origin}/register`;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(registerLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused; the link is on screen to copy by hand.
      setCopied(false);
    }
  }

  return (
    <AppShell>
      <div className="stack stack--loose">
        <header className="stack stack--tight">
          <h1>Guest registrations</h1>
          <p className="page-intro">
            Review what guests have submitted, correct anything the scan got wrong, and approve.
          </p>
        </header>

        <div className="share-link">
          <span className="section-label">Guest link</span>
          <span className="share-link__url">{registerLink}</span>
          <button type="button" className="btn btn--secondary btn--sm" onClick={copyLink}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>

        <div className="toolbar">
          <div className="filters" role="group" aria-label="Filter by status">
            {FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                className="chip"
                aria-pressed={filter.value === status}
                onClick={() => setStatus(filter.value)}
              >
                {filter.label}
              </button>
            ))}
          </div>

          <div className="search">
            <span className="search__icon" aria-hidden="true">
              ⌕
            </span>
            <input
              type="search"
              className="input"
              placeholder="Search name, phone or email"
              aria-label="Search registrations"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {error && <Alert tone="error">{error}</Alert>}

        <div aria-live="polite" aria-busy={loading}>
          {loading ? (
            <div className="card stack" aria-hidden="true">
              {[0, 1, 2, 3].map((row) => (
                <div key={row} className="skeleton" style={{ width: `${90 - row * 12}%` }} />
              ))}
              <span className="visually-hidden">Loading registrations…</span>
            </div>
          ) : registrations.length === 0 ? (
            <EmptyState
              icon="◔"
              title={
                debouncedSearch || status !== 'ALL'
                  ? 'Nothing matches those filters'
                  : 'No registrations yet'
              }
            >
              {debouncedSearch || status !== 'ALL'
                ? 'Try a different status or search term.'
                : 'Share the guest link above and submissions will appear here.'}
            </EmptyState>
          ) : (
            <div className="stack">
              <p className="result-count">
                {total} registration{total === 1 ? '' : 's'}
              </p>

              {isCompact ? (
                <div className="cards">
                  {registrations.map((r) => (
                    <Link key={r.id} to={`/dashboard/${r.id}`} className="record-card">
                      <div className="record-card__top">
                        <span className="record-card__name">{r.fullName}</span>
                        <StatusBadge status={r.status} />
                      </div>
                      <div className="record-card__meta">
                        <span>{r.phone}</span>
                        <span>
                          {formatDate(r.checkInDate)} → {formatDate(r.checkOutDate)}
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              ) : (
                <div className="table-wrap">
                <table className="table">
                  <caption className="visually-hidden">
                    Guest registrations, newest first
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Guest</th>
                      <th scope="col">Phone</th>
                      <th scope="col">Check-in</th>
                      <th scope="col">Check-out</th>
                      <th scope="col">Status</th>
                      <th scope="col">
                        <span className="visually-hidden">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {registrations.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <span className="table__name">{r.fullName}</span>
                          {r.email && <div className="table__meta">{r.email}</div>}
                        </td>
                        <td className="table__numeric">{r.phone}</td>
                        <td className="table__numeric">{formatDate(r.checkInDate)}</td>
                        <td className="table__numeric">{formatDate(r.checkOutDate)}</td>
                        <td>
                          <StatusBadge status={r.status} />
                        </td>
                        <td>
                          {/* Every row's link says "Review", so the guest's name
                              goes in the accessible name - otherwise a screen
                              reader hears a list of identical links. */}
                          <Link to={`/dashboard/${r.id}`} aria-label={`Review ${r.fullName}`}>
                            Review
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
