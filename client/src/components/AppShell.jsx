import { Link, useNavigate } from 'react-router-dom';
import { clearSession, getStaffName } from '../api/client';

// The staff-facing frame. The guest form deliberately does not use it: guests
// should see a single-purpose page, with no navigation into the back office.
export default function AppShell({ children }) {
  const navigate = useNavigate();
  const staffName = getStaffName();

  function handleSignOut() {
    clearSession();
    navigate('/login', { replace: true });
  }

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>

      <header className="app-header">
        <div className="app-header__inner">
          <Link to="/dashboard" className="brand">
            <span className="brand__mark" aria-hidden="true">
              QC
            </span>
            <span className="brand__text">
              QuickCheckIn
              <span className="brand__sub">Front desk</span>
            </span>
          </Link>

          <div className="app-header__user">
            {staffName && <span>{staffName}</span>}
            <button type="button" className="btn btn--secondary btn--sm" onClick={handleSignOut}>
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main id="main" className="page">
        {children}
      </main>
    </>
  );
}
