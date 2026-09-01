import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import ProtectedRoute from './ProtectedRoute.jsx';
import { loginAsStaff, renderRoute } from '../test/utils.jsx';

describe('ProtectedRoute', () => {
  it('sends signed-out visitors to the login page', () => {
    renderRoute(
      <ProtectedRoute>
        <div>secret staff area</div>
      </ProtectedRoute>,
      { path: '/dashboard', route: '/dashboard' }
    );

    expect(screen.getByText('login page')).toBeInTheDocument();
    expect(screen.queryByText('secret staff area')).not.toBeInTheDocument();
  });

  it('renders the page for a signed-in staff member', () => {
    loginAsStaff();

    renderRoute(
      <ProtectedRoute>
        <div>secret staff area</div>
      </ProtectedRoute>,
      { path: '/dashboard', route: '/dashboard' }
    );

    expect(screen.getByText('secret staff area')).toBeInTheDocument();
  });
});
