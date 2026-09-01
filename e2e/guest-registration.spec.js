import { expect, test } from '@playwright/test';
import { fillGuestForm, label, marker, submitGuestForm } from './support/pages.js';

test.describe('guest registration', () => {
  test('a guest can register without uploading anything', async ({ page }) => {
    await page.goto('/register');

    await fillGuestForm(page, {
      fullName: 'Manual Entry Guest',
      phone: '9876500001',
      purpose: marker('manual'),
    });
    await submitGuestForm(page);

    await expect(page.getByText(/confirm your check-in shortly/i)).toBeVisible();
  });

  test('the root url sends guests to the registration form', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveURL(/\/register$/);
    await expect(page.getByRole('heading', { name: 'Guest registration' })).toBeVisible();
  });

  test('the form refuses to submit without the consent declaration', async ({ page }) => {
    await page.goto('/register');

    await page.getByLabel(label.fullName).fill('No Consent Guest');
    await page.getByLabel(label.phone).fill('9876500002');
    await page.getByRole('button', { name: 'Submit registration' }).click();

    await expect(page.getByText(/confirm the declaration/i)).toBeVisible();
    await expect(page.getByRole('heading', { name: /you're all set/i })).toBeHidden();
  });

  test('an empty submission is refused and focus lands on the first problem', async ({ page }) => {
    await page.goto('/register');

    await page.getByLabel(label.consent).check();
    await page.getByRole('button', { name: 'Submit registration' }).click();

    await expect(page.getByRole('heading', { name: /you're all set/i })).toBeHidden();
    await expect(page.getByLabel(label.fullName)).toBeFocused();
  });
});
