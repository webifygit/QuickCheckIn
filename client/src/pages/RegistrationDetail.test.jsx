import { describe, it, expect, vi } from 'vitest';
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
  checkInDate: null,
  checkOutDate: null,
  consentGiven: true,
  // The storage key never reaches the browser; only whether there is one.
  hasIdDocument: true,
  idDocumentDeletedAt: null,
  status: 'PENDING',
  createdAt: '2026-09-01T09:00:00.000Z',
};

function mockDetail(overrides = {}) {
  server.use(
    http.get(`${API}/api/registrations/reg_1`, () =>
      HttpResponse.json({ ...registration, ...overrides })
    )
  );
}

// The image is streamed through an authenticated route, not a public URL.
function mockDocument() {
  const requests = [];
  server.use(
    http.get(`${API}/api/registrations/reg_1/document`, ({ request }) => {
      requests.push(request.headers.get('authorization'));
      return new HttpResponse(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]), {
        headers: { 'Content-Type': 'image/png' },
      });
    })
  );
  return requests;
}

function capturePatches(response) {
  const patches = [];
  server.use(
    http.patch(`${API}/api/registrations/reg_1`, async ({ request }) => {
      const body = await request.json();
      patches.push(body);
      return HttpResponse.json({ ...registration, ...body, ...(response || {}) });
    })
  );
  return patches;
}

const renderDetail = () =>
  renderRoute(<RegistrationDetail />, { path: '/dashboard/:id', route: '/dashboard/reg_1' });

describe('RegistrationDetail', () => {
  it('shows the guest details and fetches the document with the staff token', async () => {
    loginAsStaff();
    mockDetail();
    const documentRequests = mockDocument();

    renderDetail();

    expect(await screen.findByDisplayValue('Asha Kulkarni')).toBeInTheDocument();
    expect(screen.getByDisplayValue('XXXX XXXX 1234')).toBeInTheDocument();

    expect(await screen.findByAltText(/uploaded identity document/i)).toBeInTheDocument();
    await waitFor(() => expect(documentRequests).toHaveLength(1));
    expect(documentRequests[0]).toBe('Bearer staff-token');
  });

  it('never receives the storage key for the image', async () => {
    loginAsStaff();
    mockDetail();
    mockDocument();

    renderDetail();
    await screen.findByDisplayValue('Asha Kulkarni');

    // Whatever is on screen, the object key is not part of it.
    expect(document.body.innerHTML).not.toMatch(/[0-9a-f]{32}\.(png|jpg|webp)/);
  });

  it('says so when no document was uploaded', async () => {
    loginAsStaff();
    mockDetail({ hasIdDocument: false });

    renderDetail();

    expect(await screen.findByText(/no id photo was uploaded/i)).toBeInTheDocument();
    expect(screen.queryByAltText(/uploaded identity document/i)).not.toBeInTheDocument();
  });

  it('explains that the image was deleted after review rather than showing nothing', async () => {
    loginAsStaff();
    mockDetail({
      hasIdDocument: false,
      idDocumentDeletedAt: '2026-09-02T10:00:00.000Z',
      status: 'APPROVED',
    });

    renderDetail();

    expect(await screen.findByText(/deleted on .*, once this registration was reviewed/i))
      .toBeInTheDocument();
  });

  it('saves staff corrections', async () => {
    loginAsStaff();
    mockDetail();
    mockDocument();
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

  it('warns before a decision that deletes the ID photo, and honours a cancel', async () => {
    loginAsStaff();
    mockDetail();
    mockDocument();
    const patches = capturePatches();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    const { user } = renderDetail();
    await screen.findByDisplayValue('Asha Kulkarni');
    await user.click(screen.getByRole('button', { name: 'Approved' }));

    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/permanently delete/i));
    expect(patches).toHaveLength(0);
  });

  it('approves a registration and reflects the new status', async () => {
    loginAsStaff();
    mockDetail();
    mockDocument();
    const patches = capturePatches({ hasIdDocument: false, idDocumentDeletedAt: new Date().toISOString() });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const { user } = renderDetail();
    await screen.findByDisplayValue('Asha Kulkarni');
    await user.click(screen.getByRole('button', { name: 'Approved' }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].status).toBe('APPROVED');
    expect(
      await screen.findByRole('button', { name: 'Approved', pressed: true })
    ).toBeInTheDocument();
  });

  it('does not prompt for a decision that keeps the photo', async () => {
    loginAsStaff();
    mockDetail({ status: 'APPROVED', hasIdDocument: false });
    const patches = capturePatches();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    const { user } = renderDetail();
    await screen.findByDisplayValue('Asha Kulkarni');
    await user.click(screen.getByRole('button', { name: 'Pending' }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(confirm).not.toHaveBeenCalled();
  });

  it('reports a failed save and keeps the edits on screen', async () => {
    loginAsStaff();
    mockDetail();
    mockDocument();
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

    expect(await screen.findByText(/no longer exists/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue('9111111111')).toBeInTheDocument();
  });

  it('shows per-field errors from the server against the right input', async () => {
    loginAsStaff();
    mockDetail();
    mockDocument();
    server.use(
      http.patch(`${API}/api/registrations/reg_1`, () =>
        HttpResponse.json(
          {
            error: 'Enter a valid phone number',
            fieldErrors: { phone: 'Enter a valid phone number' },
          },
          { status: 400 }
        )
      )
    );

    const { user } = renderDetail();
    const phone = await screen.findByDisplayValue('9876543210');
    await user.clear(phone);
    await user.type(phone, '12');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(screen.getByDisplayValue('12')).toHaveAttribute('aria-invalid', 'true'));
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
