import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../test/server.js';
import Dashboard from './Dashboard.jsx';
import { API, loginAsStaff, renderRoute } from '../test/utils.jsx';

const rows = [
  {
    id: 'reg_1',
    fullName: 'Asha Kulkarni',
    phone: '9876543210',
    checkInDate: '2026-09-01T00:00:00.000Z',
    checkOutDate: null,
    status: 'PENDING',
  },
  {
    id: 'reg_2',
    fullName: 'Ramesh Kulkarni',
    phone: '9000000000',
    checkInDate: null,
    checkOutDate: null,
    status: 'APPROVED',
  },
];

function mockList(handler) {
  const calls = [];
  server.use(
    http.get(`${API}/api/registrations`, ({ request }) => {
      calls.push(new URL(request.url).searchParams.get('status'));
      return handler ? handler() : HttpResponse.json(rows);
    })
  );
  return calls;
}

const renderDashboard = () => renderRoute(<Dashboard />, { path: '/dashboard', route: '/dashboard' });

describe('Dashboard', () => {
  it('lists the registrations it loads', async () => {
    loginAsStaff();
    mockList();

    renderDashboard();

    expect(await screen.findByText('Asha Kulkarni')).toBeInTheDocument();
    expect(screen.getByText('Ramesh Kulkarni')).toBeInTheDocument();
    const row = screen.getByText('Asha Kulkarni').closest('tr');
    expect(within(row).getByText('PENDING')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: /view/i })).toHaveAttribute(
      'href',
      '/dashboard/reg_1'
    );
  });

  it('shows an em dash where a date is missing', async () => {
    loginAsStaff();
    mockList();

    renderDashboard();

    const row = (await screen.findByText('Ramesh Kulkarni')).closest('tr');
    expect(within(row).getAllByText('—')).toHaveLength(2);
  });

  it('asks the server for one status when a filter chip is clicked', async () => {
    loginAsStaff();
    const calls = mockList();

    const { user } = renderDashboard();
    await screen.findByText('Asha Kulkarni');
    await user.click(screen.getByRole('button', { name: 'PENDING' }));

    await screen.findByText('Asha Kulkarni');
    expect(calls).toEqual([null, 'PENDING']);
  });

  it('shows an empty state when there is nothing to review', async () => {
    loginAsStaff();
    mockList(() => HttpResponse.json([]));

    renderDashboard();

    expect(await screen.findByText(/no registrations yet/i)).toBeInTheDocument();
  });

  it('signs the staff member out when the token is no longer accepted', async () => {
    loginAsStaff('expired-token');
    mockList(() => HttpResponse.json({ error: 'Invalid or expired token' }, { status: 401 }));

    renderDashboard();

    expect(await screen.findByText('login page')).toBeInTheDocument();
    expect(localStorage.getItem('staffToken')).toBeNull();
    expect(localStorage.getItem('staffName')).toBeNull();
  });

  it('reports a server failure without signing the staff member out', async () => {
    loginAsStaff();
    mockList(() => HttpResponse.json({ error: 'boom' }, { status: 500 }));

    renderDashboard();

    expect(await screen.findByText(/failed to load registrations/i)).toBeInTheDocument();
    expect(localStorage.getItem('staffToken')).toBe('staff-token');
  });

  it('logs the staff member out on demand', async () => {
    loginAsStaff();
    mockList();

    const { user } = renderDashboard();
    await screen.findByText('Asha Kulkarni');
    await user.click(screen.getByRole('button', { name: /log out/i }));

    expect(await screen.findByText('login page')).toBeInTheDocument();
    expect(localStorage.getItem('staffToken')).toBeNull();
  });
});
