import { expect, test } from '@playwright/test';
import { EXPECTED, writeAadhaarCardImage } from './support/aadhaarFixture.js';
import { API_URL } from './support/constants.js';
import {
  decide,
  fillGuestForm,
  guestRow,
  label,
  marker,
  staffLogin,
  submitGuestForm,
} from './support/pages.js';

test.describe('staff review', () => {
  test('a submission travels from the guest form to an approved booking', async ({ page }) => {
    const guestName = `Review Flow Guest ${Date.now()}`;

    // 1. The guest registers, scanning their card.
    const cardImage = await writeAadhaarCardImage();
    await page.goto('/register');
    await page.getByLabel(label.upload).setInputFiles(cardImage);
    await expect(page.getByLabel(label.idNumber)).toHaveValue(EXPECTED.maskedId);
    await page.getByLabel(label.fullName).fill(guestName);
    await page.getByLabel(label.phone).fill('9876500021');
    await page.getByLabel(label.purpose).fill(marker('review'));
    await page.getByLabel(label.consent).check();
    await submitGuestForm(page);

    // 2. Staff sign in and find it waiting.
    await staffLogin(page);
    await expect(guestRow(page, guestName)).toContainText('Pending');

    // 3. They open it and see the scanned details, still masked. The ID image is
    // fetched through the authenticated route - there is no public URL for it.
    await guestRow(page, guestName).getByRole('link', { name: `Review ${guestName}` }).click();
    await expect(page.getByRole('heading', { name: guestName })).toBeVisible();
    await expect(page.getByLabel(label.idNumber)).toHaveValue(EXPECTED.maskedId);
    await expect(page.getByAltText('Uploaded identity document')).toBeVisible();

    // 4. They correct a detail and save it. Wait for the save to round-trip -
    // the page sends the whole record on every save, so firing the next one
    // before this lands would be a last-write-wins race.
    await page.getByLabel('Phone', { exact: true }).fill('9876500099');
    const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.ok());
    await page.getByRole('button', { name: 'Save changes' }).click();
    await saved;
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    await expect(page.getByLabel('Phone', { exact: true })).toHaveValue('9876500099');

    // 5. They approve the guest, confirming the ID photo deletion.
    await decide(page, 'Approved');
    await expect(page.getByRole('button', { name: 'Approved', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    // 6. The ID photo is gone, and the page says so rather than showing a gap.
    await expect(page.getByAltText('Uploaded identity document')).toBeHidden();
    await expect(page.getByText(/once this registration was reviewed/i)).toBeVisible();

    // 7. The dashboard reflects both changes.
    await page.getByRole('link', { name: /Back to dashboard/ }).click();
    await expect(guestRow(page, guestName)).toContainText('Approved');
    await expect(guestRow(page, guestName)).toContainText('9876500099');

    // 8. The status filter finds it, and the pending filter does not.
    await page.getByRole('button', { name: 'Approved', exact: true }).click();
    await expect(guestRow(page, guestName)).toBeVisible();
    await page.getByRole('button', { name: 'Pending', exact: true }).click();
    await expect(guestRow(page, guestName)).toBeHidden();
  });

  test('the ID image is never reachable without a staff token', async ({ page, request }) => {
    const guestName = `Doc Guard Guest ${Date.now()}`;

    const cardImage = await writeAadhaarCardImage();
    await page.goto('/register');
    await page.getByLabel(label.upload).setInputFiles(cardImage);
    await expect(page.getByLabel(label.idNumber)).toHaveValue(EXPECTED.maskedId);
    await page.getByLabel(label.fullName).fill(guestName);
    await page.getByLabel(label.phone).fill('9876500023');
    await page.getByLabel(label.purpose).fill(marker('doc-guard'));
    await page.getByLabel(label.consent).check();
    await submitGuestForm(page);

    await staffLogin(page);
    await guestRow(page, guestName).getByRole('link', { name: `Review ${guestName}` }).click();
    await expect(page.getByAltText('Uploaded identity document')).toBeVisible();

    // The old static path is gone entirely.
    const legacy = await request.get(`${API_URL}/uploads/`);
    expect(legacy.status()).toBe(404);

    // And the authenticated route refuses an anonymous caller.
    const id = page.url().split('/').pop();
    const anonymous = await request.get(`${API_URL}/api/registrations/${id}/document`);
    expect(anonymous.status()).toBe(401);
  });

  test('a guest who skips the optional dates still reaches the dashboard', async ({ page }) => {
    const guestName = `No Dates Guest ${Date.now()}`;

    await page.goto('/register');
    await fillGuestForm(page, {
      fullName: guestName,
      phone: '9876500022',
      purpose: marker('no-dates'),
    });
    await submitGuestForm(page);

    await staffLogin(page);
    await expect(guestRow(page, guestName)).toContainText('Pending');
    await expect(guestRow(page, guestName)).toContainText('—');
  });
});
