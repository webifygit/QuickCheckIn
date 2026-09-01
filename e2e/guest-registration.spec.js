import { expect, test } from '@playwright/test';
import { fillGuestForm, marker, submitGuestForm } from './support/pages.js';

test.describe('guest registration', () => {
  test('a guest can register without uploading anything', async ({ page }) => {
    await page.goto('/register');

    await fillGuestForm(page, {
      fullName: 'Manual Entry Guest',
      phone: '9876500001',
      purpose: marker('manual'),
    });
    await submitGuestForm(page);

    await expect(page.getByText(/front desk staff will confirm/i)).toBeVisible();
  });

  test('the root url sends guests to the registration form', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveURL(/\/register$/);
    await expect(page.getByRole('heading', { name: 'Guest Registration' })).toBeVisible();
  });

  test('the form refuses to submit without the consent declaration', async ({ page }) => {
    await page.goto('/register');

    await page.getByLabel('Full name *').fill('No Consent Guest');
    await page.getByLabel('Phone *').fill('9876500002');
    await page.getByRole('button', { name: 'Submit registration' }).click();

    await expect(page.getByText(/confirm the declaration/i)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Thank you!' })).toBeHidden();
  });

  test('the browser blocks a submission with no name or phone', async ({ page }) => {
    await page.goto('/register');

    await page.getByLabel(/I confirm the above details/).check();
    await page.getByRole('button', { name: 'Submit registration' }).click();

    await expect(page.getByRole('heading', { name: 'Thank you!' })).toBeHidden();
    await expect(page.getByLabel('Full name *')).toBeFocused();
  });
});
