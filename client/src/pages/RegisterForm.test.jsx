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

describe('RegisterForm - Aadhaar auto-fill', () => {
  it('fills the form from a scanned card', async () => {
    mockScan({ imagePath: 'uploads/abc.png', fields: AADHAAR_FIELDS });
    const { user } = renderForm();

    await user.upload(screen.getByLabelText(/upload a photo/i), cardPhoto());

    expect(await screen.findByDisplayValue('Asha Ramesh Kulkarni')).toBeInTheDocument();
    expect(screen.getByDisplayValue('14/08/1991')).toBeInTheDocument();
    expect(screen.getByDisplayValue('XXXX XXXX 1234')).toBeInTheDocument();
    expect(screen.getByLabelText(/gender/i)).toHaveValue('FEMALE');
    expect(screen.getByText(/please check them and correct anything/i)).toBeInTheDocument();
  });

  it('leaves auto-filled values editable', async () => {
    mockScan({ imagePath: 'uploads/abc.png', fields: AADHAAR_FIELDS });
    const { user } = renderForm();

    await user.upload(screen.getByLabelText(/upload a photo/i), cardPhoto());
    const name = await screen.findByDisplayValue('Asha Ramesh Kulkarni');
    await user.clear(name);
    await user.type(name, 'Asha R Kulkarni');

    expect(name).toHaveValue('Asha R Kulkarni');
  });

  it('shows the fallback message and keeps the form usable when the QR is unreadable', async () => {
    mockScan({
      imagePath: 'uploads/blurry.png',
      fields: null,
      message: "Couldn't read the QR code on this image.",
    });
    const { user } = renderForm();

    await user.upload(screen.getByLabelText(/upload a photo/i), cardPhoto());

    expect(await screen.findByText(/couldn't read the qr code/i)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/full name/i), 'Manual Entry');
    expect(screen.getByLabelText(/full name/i)).toHaveValue('Manual Entry');
  });

  it('recovers when the scan request itself fails', async () => {
    server.use(http.post(`${API}/api/document/scan`, () => HttpResponse.error()));
    const { user } = renderForm();

    await user.upload(screen.getByLabelText(/upload a photo/i), cardPhoto());

    expect(await screen.findByText(/couldn't read this image/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /submit registration/i })).toBeEnabled();
  });
});

describe('RegisterForm - submission', () => {
  it('refuses to submit without the consent declaration', async () => {
    const submissions = captureSubmission();
    const { user } = renderForm();

    await user.type(screen.getByLabelText(/full name/i), 'Asha Kulkarni');
    await user.type(screen.getByLabelText(/phone/i), '9876543210');
    await user.click(screen.getByRole('button', { name: /submit registration/i }));

    expect(await screen.findByText(/confirm the declaration/i)).toBeInTheDocument();
    expect(submissions).toHaveLength(0);
  });

  it('submits the form and thanks the guest', async () => {
    const submissions = captureSubmission();
    const { user } = renderForm();

    await user.type(screen.getByLabelText(/full name/i), 'Asha Kulkarni');
    await user.type(screen.getByLabelText(/phone/i), '9876543210');
    await user.click(screen.getByLabelText(/i confirm the above details/i));
    await user.click(screen.getByRole('button', { name: /submit registration/i }));

    expect(await screen.findByText(/thank you/i)).toBeInTheDocument();
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      fullName: 'Asha Kulkarni',
      phone: '9876543210',
      consentGiven: true,
      idType: 'AADHAAR',
    });
  });

  it('sends the uploaded image path alongside the details', async () => {
    mockScan({ imagePath: 'uploads/abc.png', fields: AADHAAR_FIELDS });
    const submissions = captureSubmission();
    const { user } = renderForm();

    await user.upload(screen.getByLabelText(/upload a photo/i), cardPhoto());
    await screen.findByDisplayValue('Asha Ramesh Kulkarni');
    await user.type(screen.getByLabelText(/phone/i), '9876543210');
    await user.click(screen.getByLabelText(/i confirm the above details/i));
    await user.click(screen.getByRole('button', { name: /submit registration/i }));

    await waitFor(() => expect(submissions).toHaveLength(1));
    expect(submissions[0].idDocumentImagePath).toBe('uploads/abc.png');
    expect(submissions[0].idNumber).toBe('XXXX XXXX 1234');
  });

  it('surfaces a server-side rejection instead of a thank-you', async () => {
    server.use(
      http.post(`${API}/api/registrations`, () =>
        HttpResponse.json({ error: 'fullName and phone are required' }, { status: 400 })
      )
    );
    const { user } = renderForm();

    await user.type(screen.getByLabelText(/full name/i), 'Asha Kulkarni');
    await user.type(screen.getByLabelText(/phone/i), '9876543210');
    await user.click(screen.getByLabelText(/i confirm the above details/i));
    await user.click(screen.getByRole('button', { name: /submit registration/i }));

    expect(await screen.findByText(/fullname and phone are required/i)).toBeInTheDocument();
    expect(screen.queryByText(/thank you/i)).not.toBeInTheDocument();
  });
});
