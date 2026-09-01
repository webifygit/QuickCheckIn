import { expect } from '@playwright/test';
import { E2E_MARKER, E2E_STAFF } from './constants.js';

// Unique per submission, so parallel or repeated runs never collide and the
// teardown can find exactly what this suite created.
export function marker(label) {
  return `${E2E_MARKER}-${label}-${Date.now()}`;
}

// Required fields render their asterisk as aria-hidden, and optional fields
// append an "optional" tag, so labels are matched by prefix rather than exactly.
export const label = {
  fullName: /^Full name/,
  phone: /^Phone/,
  purpose: /^Purpose of visit/,
  dob: /^Date of birth/,
  gender: /^Gender/,
  idNumber: /^ID number/,
  address: /^Address/,
  upload: /Upload a photo of your Aadhaar card/,
  consent: /I confirm the above details/,
};

export async function fillGuestForm(page, { fullName, phone, purpose }) {
  await page.getByLabel(label.fullName).fill(fullName);
  await page.getByLabel(label.phone).fill(phone);
  await page.getByLabel(label.purpose).fill(purpose);
  await page.getByLabel(label.consent).check();
}

export async function submitGuestForm(page) {
  await page.getByRole('button', { name: 'Submit registration' }).click();
  await expect(page.getByRole('heading', { name: /you're all set/i })).toBeVisible();
}

export async function staffLogin(page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_STAFF.email);
  await page.getByLabel('Password').fill(E2E_STAFF.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Guest registrations' })).toBeVisible();
}

export function guestRow(page, fullName) {
  return page.getByRole('row').filter({ hasText: fullName });
}

// Approving, checking in or rejecting deletes the guest's ID photo, so the UI
// asks first. Accept the prompt and click through.
export async function decide(page, statusLabel) {
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: statusLabel, exact: true }).click();
}
