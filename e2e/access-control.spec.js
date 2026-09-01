import { expect, test } from '@playwright/test';
import { E2E_STAFF } from './support/constants.js';
import { staffLogin } from './support/pages.js';

test.describe('access control', () => {
  test('the dashboard is closed to visitors who are not signed in', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Staff sign in' })).toBeVisible();
  });

  test('a registration detail page is closed too', async ({ page }) => {
    await page.goto('/dashboard/some-id');

    await expect(page).toHaveURL(/\/login$/);
  });

  test('wrong credentials are refused', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(E2E_STAFF.email);
    await page.getByLabel('Password').fill('definitely-not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByText('Invalid email or password')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('a stale token drops the staff member back at the login screen', async ({ page }) => {
    await staffLogin(page);

    await page.evaluate(() => localStorage.setItem('staffToken', 'no-longer-valid'));
    await page.reload();

    await expect(page).toHaveURL(/\/login$/);
  });

  test('logging out clears the session', async ({ page }) => {
    await staffLogin(page);

    await page.getByRole('button', { name: 'Sign out' }).click();

    await expect(page).toHaveURL(/\/login$/);
    expect(await page.evaluate(() => localStorage.getItem('staffToken'))).toBeNull();

    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login$/);
  });
});
