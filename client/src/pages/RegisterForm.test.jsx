import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../test/server.js';
import RegisterForm from './RegisterForm.jsx';
import { API, renderRoute } from '../test/utils.jsx';

const AADHAAR_FIELDS = {
  fullName: 'Asha Ramesh Kulkarni',
  dob: '14/08/1991',
  gender: 'FEMALE',
  idNumber: 'XXXX XXXX 1234',
  address: 'Flat 402, Paud Road, Pune, Maharashtra, 411038',
};

// A key in the shape the server mints them; the API refuses anything else.
const DOCUMENT_KEY = '1788245002600-7a5fbbc0520ff8dd7a5fbbc0520ff8dd.png';

const cardPhoto = () =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'aadhaar.png', { type: 'image/png' });

function mockScan(response) {
  server.use(http.post(`${API}/api/document/scan`, () => HttpResponse.json(response)));
}

function captureSubmission() {
  const submissions = [];
  server.use(
    http.post(`${API}/api/registrations`, async ({ request }) => {
      const body = await request.json();
      submissions.push(body);
      return HttpResponse.json({ id: 'reg_1', ...body }, { status: 201 });
    })
  );
  return submissions;
}

const renderForm = () => renderRoute(<RegisterForm />, { path: '/register', route: '/register' });

// The front of the ID is what the hotel's record is built on, so the form will
// not submit without one. Tests about anything else still have to get past it.
async function uploadFront(user, response = { documentKey: DOCUMENT_KEY, fields: null, message: '' }) {
  mockScan(response);
  await user.upload(screen.getByLabelText(/front of your ID/i), cardPhoto());
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /submit registration/i })).toBeEnabled()
  );
}

describe('RegisterForm - Aadhaar auto-fill', () => {
  it('fills the form from a scanned card', async () => {
    mockScan({ documentKey: DOCUMENT_KEY, fields: AADHAAR_FIELDS });
    const { user } = renderForm();

    await user.upload(screen.getByLabelText(/front of your ID/i), cardPhoto());

    expect(await screen.findByDisplayValue('Asha Ramesh Kulkarni')).toBeInTheDocument();
    expect(screen.getByDisplayValue('14/08/1991')).toBeInTheDocument();
    expect(screen.getByDisplayValue('XXXX XXXX 1234')).toBeInTheDocument();
    expect(screen.getByLabelText(/gender/i)).toHaveValue('FEMALE');
    expect(screen.getByText(/please check them and correct anything/i)).toBeInTheDocument();
  });

  it('leaves auto-filled values editable', async () => {
    mockScan({ documentKey: DOCUMENT_KEY, fields: AADHAAR_FIELDS });
    const { user } = renderForm();

    await user.upload(screen.getByLabelText(/front of your ID/i), cardPhoto());
    const name = await screen.findByDisplayValue('Asha Ramesh Kulkarni');
    await user.clear(name);
    await user.type(name, 'Asha R Kulkarni');

    expect(name).toHaveValue('Asha R Kulkarni');
  });

  it('shows the fallback message and keeps the form usable when the QR is unreadable', async () => {
    mockScan({
      documentKey: DOCUMENT_KEY,
      fields: null,
      message: "Couldn't read the QR code on this image.",
    });
    const { user } = renderForm();

    await user.upload(screen.getByLabelText(/front of your ID/i), cardPhoto());

    expect(await screen.findByText(/couldn't read the qr code/i)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/full name/i), 'Manual Entry');
    expect(screen.getByLabelText(/full name/i)).toHaveValue('Manual Entry');
  });

  it('recovers when the scan request itself fails', async () => {
    server.use(http.post(`${API}/api/document/scan`, () => HttpResponse.error()));
    const { user } = renderForm();

    await user.upload(screen.getByLabelText(/front of your ID/i), cardPhoto());

    expect(await screen.findByText(/you can fill the form in yourself/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /submit registration/i })).toBeEnabled();
  });
});

describe('RegisterForm - submission', () => {
  it('refuses to submit without a photo of the front of the ID', async () => {
    const submissions = captureSubmission();
    const { user } = renderForm();

    await user.type(screen.getByLabelText(/full name/i), 'Asha Kulkarni');
    await user.type(screen.getByLabelText(/phone/i), '9876543210');
    await user.click(screen.getByLabelText(/i confirm the above details/i));
    await user.click(screen.getByRole('button', { name: /submit registration/i }));

    expect(await screen.findByText(/photo of the front of your ID/i)).toBeInTheDocument();
    expect(submissions).toHaveLength(0);
  });

  it('refuses to submit without the consent declaration', async () => {
    const submissions = captureSubmission();
    const { user } = renderForm();

    await uploadFront(user);
    await user.type(screen.getByLabelText(/full name/i), 'Asha Kulkarni');
    await user.type(screen.getByLabelText(/phone/i), '9876543210');
    await user.click(screen.getByRole('button', { name: /submit registration/i }));

    expect(await screen.findByText(/confirm the declaration/i)).toBeInTheDocument();
    expect(submissions).toHaveLength(0);
  });

  it('submits the form and thanks the guest', async () => {
    const submissions = captureSubmission();
    const { user } = renderForm();

    await uploadFront(user);
    await user.type(screen.getByLabelText(/full name/i), 'Asha Kulkarni');
    await user.type(screen.getByLabelText(/phone/i), '9876543210');
    await user.click(screen.getByLabelText(/i confirm the above details/i));
    await user.click(screen.getByRole('button', { name: /submit registration/i }));

    expect(await screen.findByText(/you're all set/i)).toBeInTheDocument();
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      fullName: 'Asha Kulkarni',
      phone: '9876543210',
      consentGiven: true,
      idType: 'AADHAAR',
    });
  });

  it('sends the uploaded document key alongside the details', async () => {
    mockScan({ documentKey: DOCUMENT_KEY, fields: AADHAAR_FIELDS });
    const submissions = captureSubmission();
    const { user } = renderForm();

    await user.upload(screen.getByLabelText(/front of your ID/i), cardPhoto());
    await screen.findByDisplayValue('Asha Ramesh Kulkarni');
    await user.type(screen.getByLabelText(/phone/i), '9876543210');
    await user.click(screen.getByLabelText(/i confirm the above details/i));
    await user.click(screen.getByRole('button', { name: /submit registration/i }));

    await waitFor(() => expect(submissions).toHaveLength(1));
    expect(submissions[0].idDocumentKey).toBe(DOCUMENT_KEY);
    expect(submissions[0].idNumber).toBe('XXXX XXXX 1234');
  });

  // The back carries the address, which the front does not, so a reviewer needs
  // it as its own image rather than as half of a combined one.
  it('sends both sides when the guest uploads front and back', async () => {
    const BACK_KEY = '1788245002601-9c5fbbc0520ff8dd7a5fbbc0520ff8dd.png';
    const submissions = captureSubmission();
    const { user } = renderForm();

    await uploadFront(user);
    mockScan({ documentKey: BACK_KEY, fields: null, message: '' });
    await user.upload(screen.getByLabelText(/back of your ID/i), cardPhoto());

    await user.type(screen.getByLabelText(/full name/i), 'Asha Kulkarni');
    await user.type(screen.getByLabelText(/phone/i), '9876543210');
    await user.click(screen.getByLabelText(/i confirm the above details/i));
    await user.click(screen.getByRole('button', { name: /submit registration/i }));

    await waitFor(() => expect(submissions).toHaveLength(1));
    expect(submissions[0].idDocumentKey).toBe(DOCUMENT_KEY);
    expect(submissions[0].idDocumentBackKey).toBe(BACK_KEY);
  });

  it('surfaces a server-side rejection instead of a thank-you', async () => {
    server.use(
      http.post(`${API}/api/registrations`, () =>
        HttpResponse.json({ error: 'fullName and phone are required' }, { status: 400 })
      )
    );
    const { user } = renderForm();

    await uploadFront(user);
    await user.type(screen.getByLabelText(/full name/i), 'Asha Kulkarni');
    await user.type(screen.getByLabelText(/phone/i), '9876543210');
    await user.click(screen.getByLabelText(/i confirm the above details/i));
    await user.click(screen.getByRole('button', { name: /submit registration/i }));

    expect(await screen.findByText(/fullname and phone are required/i)).toBeInTheDocument();
    expect(screen.queryByText(/you're all set/i)).not.toBeInTheDocument();
  });
});
