import { expect, test } from '@playwright/test';
import { EXPECTED, writeAadhaarCardImage } from './support/aadhaarFixture.js';
import { fillGuestForm, guestRow, marker, staffLogin, submitGuestForm } from './support/pages.js';

test.describe('staff review', () => {
  test('a submission travels from the guest form to an approved booking', async ({ page }) => {
    const guestName = `Review Flow Guest ${Date.now()}`;

    // 1. The guest registers, scanning their card.
    const cardImage = await writeAadhaarCardImage();
    await page.goto('/register');
    await page.getByLabel(/Upload a photo of your Aadhaar card/).setInputFiles(cardImage);
    await expect(page.getByLabel('ID number')).toHaveValue(EXPECTED.maskedId);
    await page.getByLabel('Full name *').fill(guestName);
    await page.getByLabel('Phone *').fill('9876500021');
    await page.getByLabel('Purpose of visit').fill(marker('review'));
    await page.getByLabel(/I confirm the above details/).check();
    await submitGuestForm(page);

    // 2. Staff sign in and find it waiting.
    await staffLogin(page);
    await expect(guestRow(page, guestName)).toContainText('PENDING');

    // 3. They open it and see the scanned details, still masked.
    await guestRow(page, guestName).getByRole('link', { name: 'View' }).click();
    await expect(page.getByRole('heading', { name: guestName })).toBeVisible();
    await expect(page.getByLabel('ID number')).toHaveValue(EXPECTED.maskedId);
    await expect(page.getByAltText('Uploaded ID document')).toBeVisible();

    // 4. They correct a detail and save it. Wait for the save to round-trip -
    // the page sends the whole record on every save, so firing the next one
    // before this lands would be a last-write-wins race.
    await page.getByLabel('Phone', { exact: true }).fill('9876500099');
    const saved = page.waitForResponse(
      (r) => r.request().method() === 'PATCH' && r.ok()
    );
    await page.getByRole('button', { name: 'Save changes' }).click();
    await saved;
    await expect(page.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    await expect(page.getByLabel('Phone', { exact: true })).toHaveValue('9876500099');

    // 5. They approve the guest.
    await page.getByRole('button', { name: 'APPROVED', exact: true }).click();
    await expect(page.getByText('Current:')).toContainText('APPROVED');

    // 6. The dashboard reflects both changes.
    await page.getByRole('link', { name: /Back to dashboard/ }).click();
    await expect(guestRow(page, guestName)).toContainText('APPROVED');
    await expect(guestRow(page, guestName)).toContainText('9876500099');

    // 7. The status filter finds it, and the pending filter does not.
    await page.getByRole('button', { name: 'APPROVED', exact: true }).click();
    await expect(guestRow(page, guestName)).toBeVisible();
    await page.getByRole('button', { name: 'PENDING', exact: true }).click();
    await expect(guestRow(page, guestName)).toBeHidden();
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
    await expect(guestRow(page, guestName)).toContainText('PENDING');
    await expect(guestRow(page, guestName)).toContainText('—');
  });
});
