import { expect } from '@playwright/test';
import { E2E_MARKER, E2E_STAFF } from './constants.js';

// Unique per submission, so parallel or repeated runs never collide and the
// teardown can find exactly what this suite created.
export function marker(label) {
  return `${E2E_MARKER}-${label}-${Date.now()}`;
}

export async function fillGuestForm(page, { fullName, phone, purpose }) {
  await page.getByLabel('Full name *').fill(fullName);
  await page.getByLabel('Phone *').fill(phone);
  await page.getByLabel('Purpose of visit').fill(purpose);
  await page.getByLabel(/I confirm the above details/).check();
}

export async function submitGuestForm(page) {
  await page.getByRole('button', { name: 'Submit registration' }).click();
  await expect(page.getByRole('heading', { name: 'Thank you!' })).toBeVisible();
}

export async function staffLogin(page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_STAFF.email);
  await page.getByLabel('Password').fill(E2E_STAFF.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Guest Registrations' })).toBeVisible();
}

export function guestRow(page, fullName) {
  return page.getByRole('row').filter({ hasText: fullName });
}
