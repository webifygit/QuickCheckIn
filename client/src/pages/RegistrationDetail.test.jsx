import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../test/server.js';
import RegistrationDetail from './RegistrationDetail.jsx';
import { API, loginAsStaff, renderRoute } from '../test/utils.jsx';

const registration = {
  id: 'reg_1',
  fullName: 'Asha Kulkarni',
  dob: '14/08/1991',
  gender: 'FEMALE',
  nationality: 'Indian',
  idType: 'AADHAAR',
  idNumber: 'XXXX XXXX 1234',
  address: 'Flat 402, Paud Road, Pune',
  phone: '9876543210',
  email: null,
  vehicleNumber: null,
  purposeOfVisit: null,
  numberOfGuests: 2,
  idDocumentImagePath: 'uploads/abc.png',
  status: 'PENDING',
};

function mockDetail(overrides = {}) {
  server.use(
    http.get(`${API}/api/registrations/reg_1`, () =>
      HttpResponse.json({ ...registration, ...overrides })
    )
  );
}

function capturePatches() {
  const patches = [];
  server.use(
    http.patch(`${API}/api/registrations/reg_1`, async ({ request }) => {
      const body = await request.json();
      patches.push(body);
      return HttpResponse.json({ ...registration, ...body });
    })
  );
  return patches;
}

const renderDetail = () =>
  renderRoute(<RegistrationDetail />, { path: '/dashboard/:id', route: '/dashboard/reg_1' });

describe('RegistrationDetail', () => {
  it('shows the guest details and the uploaded document', async () => {
    loginAsStaff();
    mockDetail();

    renderDetail();

    expect(await screen.findByDisplayValue('Asha Kulkarni')).toBeInTheDocument();
    expect(screen.getByDisplayValue('XXXX XXXX 1234')).toBeInTheDocument();
    expect(screen.getByAltText(/uploaded id document/i)).toHaveAttribute(
      'src',
      `${API}/uploads/abc.png`
    );
  });

  it('says so when no document was uploaded', async () => {
    loginAsStaff();
    mockDetail({ idDocumentImagePath: null });

    renderDetail();

    expect(await screen.findByText(/no document uploaded/i)).toBeInTheDocument();
    expect(screen.queryByAltText(/uploaded id document/i)).not.toBeInTheDocument();
  });

  it('saves staff corrections', async () => {
    loginAsStaff();
    mockDetail();
    const patches = capturePatches();

    const { user } = renderDetail();
    const phone = await screen.findByDisplayValue('9876543210');
    await user.clear(phone);
    await user.type(phone, '9111111111');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].phone).toBe('9111111111');
    expect(patches[0].fullName).toBe('Asha Kulkarni');
  });

  it('approves a registration and reflects the new status', async () => {
    loginAsStaff();
    mockDetail();
    const patches = capturePatches();

    const { user } = renderDetail();
    await screen.findByDisplayValue('Asha Kulkarni');
    await user.click(screen.getByRole('button', { name: 'APPROVED' }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].status).toBe('APPROVED');
    expect(await screen.findByText(/current:/i)).toHaveTextContent('APPROVED');
  });

  it('reports a failed save and keeps the edits on screen', async () => {
    loginAsStaff();
    mockDetail();
    server.use(
      http.patch(`${API}/api/registrations/reg_1`, () =>
        HttpResponse.json({ error: 'Not found' }, { status: 404 })
      )
    );

    const { user } = renderDetail();
    const phone = await screen.findByDisplayValue('9876543210');
    await user.clear(phone);
    await user.type(phone, '9111111111');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText(/failed to save changes/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue('9111111111')).toBeInTheDocument();
  });

  it('sends the staff member back to login when the token is rejected', async () => {
    loginAsStaff('expired-token');
    server.use(
      http.get(`${API}/api/registrations/reg_1`, () =>
        HttpResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
      )
    );

    renderDetail();

    expect(await screen.findByText('login page')).toBeInTheDocument();
  });
});
