import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse, delay } from 'msw';
import { server } from '../test/server.js';
import Login from './Login.jsx';
import { API, renderRoute } from '../test/utils.jsx';

const signIn = async (user, email = 'admin@hotel.local', password = 'ChangeMe123!') => {
  await user.type(screen.getByLabelText(/email/i), email);
  await user.type(screen.getByLabelText(/password/i), password);
  await user.click(screen.getByRole('button', { name: /sign in/i }));
};

describe('Login', () => {
  it('stores the session and lands on the dashboard', async () => {
    server.use(
      http.post(`${API}/api/auth/login`, async ({ request }) => {
        const body = await request.json();
        expect(body).toEqual({ email: 'admin@hotel.local', password: 'ChangeMe123!' });
        return HttpResponse.json({
          token: 'issued-token',
          staff: { id: 'staff_1', email: body.email, name: 'Front Desk Admin' },
        });
      })
    );

    const { user } = renderRoute(<Login />, { path: '/login', route: '/login' });
    await signIn(user);

    expect(await screen.findByText('dashboard page')).toBeInTheDocument();
    expect(localStorage.getItem('staffToken')).toBe('issued-token');
    expect(localStorage.getItem('staffName')).toBe('Front Desk Admin');
  });

  it('shows the server error and keeps the staff member on the page', async () => {
    server.use(
      http.post(`${API}/api/auth/login`, () =>
        HttpResponse.json({ error: 'Invalid credentials' }, { status: 401 })
      )
    );

    const { user } = renderRoute(<Login />, { path: '/login', route: '/login' });
    await signIn(user, 'admin@hotel.local', 'wrong');

    expect(await screen.findByText('Invalid credentials')).toBeInTheDocument();
    expect(localStorage.getItem('staffToken')).toBeNull();
    expect(screen.queryByText('dashboard page')).not.toBeInTheDocument();
  });

  it('falls back to a generic message when the server is unreachable', async () => {
    server.use(http.post(`${API}/api/auth/login`, () => HttpResponse.error()));

    const { user } = renderRoute(<Login />, { path: '/login', route: '/login' });
    await signIn(user);

    expect(await screen.findByText(/could not reach the server/i)).toBeInTheDocument();
  });

  it('disables the submit button while the request is in flight', async () => {
    server.use(
      http.post(`${API}/api/auth/login`, async () => {
        await delay(60);
        return HttpResponse.json({ token: 't', staff: { name: 'A' } });
      })
    );

    const { user } = renderRoute(<Login />, { path: '/login', route: '/login' });
    await signIn(user);

    const button = screen.getByRole('button', { name: /signing in/i });
    expect(button).toBeDisabled();
    await waitFor(() => expect(localStorage.getItem('staffToken')).toBe('t'));
  });
});
