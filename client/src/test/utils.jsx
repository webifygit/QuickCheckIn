import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

export const API = 'http://localhost:4000';

export function loginAsStaff(token = 'staff-token') {
  localStorage.setItem('staffToken', token);
  localStorage.setItem('staffName', 'Front Desk Admin');
}

// Renders a page inside a router, with a stand-in for every other route so
// redirects are observable.
export function renderRoute(ui, { path = '/', route = '/', extraRoutes = [] } = {}) {
  const user = userEvent.setup();
  const view = render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path={path} element={ui} />
        <Route path="/login" element={<div>login page</div>} />
        <Route path="/dashboard" element={<div>dashboard page</div>} />
        {extraRoutes.map((r) => (
          <Route key={r.path} path={r.path} element={r.element} />
        ))}
      </Routes>
    </MemoryRouter>
  );
  return { user, ...view };
}
