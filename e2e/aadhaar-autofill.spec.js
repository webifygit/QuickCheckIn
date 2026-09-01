import { expect, test } from '@playwright/test';
import { EXPECTED, writeAadhaarCardImage } from './support/aadhaarFixture.js';
import { marker, submitGuestForm } from './support/pages.js';

test.describe('Aadhaar auto-fill', () => {
  test('reading a card fills the form and masks the Aadhaar number', async ({ page }) => {
    const cardImage = await writeAadhaarCardImage();
    await page.goto('/register');

    await page.getByLabel(/Upload a photo of your Aadhaar card/).setInputFiles(cardImage);

    await expect(page.getByLabel('Full name *')).toHaveValue(EXPECTED.fullName);
    await expect(page.getByLabel('Date of birth')).toHaveValue(EXPECTED.dob);
    await expect(page.getByLabel('Gender')).toHaveValue(EXPECTED.gender);
    await expect(page.getByLabel('ID number')).toHaveValue(EXPECTED.maskedId);
    await expect(page.getByLabel('Address')).toHaveValue(/Baner Road/);
    await expect(page.getByText(/please check them and correct anything/i)).toBeVisible();

    // Nothing on the page may carry a full Aadhaar number.
    expect(await page.content()).not.toMatch(/\b\d{12}\b/);
  });

  test('auto-filled details stay editable before submitting', async ({ page }) => {
    const cardImage = await writeAadhaarCardImage();
    await page.goto('/register');

    await page.getByLabel(/Upload a photo of your Aadhaar card/).setInputFiles(cardImage);
    await expect(page.getByLabel('Full name *')).toHaveValue(EXPECTED.fullName);

    await page.getByLabel('Full name *').fill('Priya S Deshmukh');
    await page.getByLabel('Phone *').fill('9876500011');
    await page.getByLabel('Purpose of visit').fill(marker('autofill'));
    await page.getByLabel(/I confirm the above details/).check();
    await submitGuestForm(page);
  });

  test('an unreadable image falls back to filling the form by hand', async ({ page }) => {
    await page.goto('/register');

    await page.getByLabel(/Upload a photo of your Aadhaar card/).setInputFiles({
      name: 'blurry.png',
      mimeType: 'image/png',
      // A valid 1x1 PNG with no QR code in it.
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64'
      ),
    });

    await expect(page.getByText(/fill the form in yourself/i)).toBeVisible();
    await page.getByLabel('Full name *').fill('Hand Filled Guest');
    await page.getByLabel('Phone *').fill('9876500012');
    await page.getByLabel('Purpose of visit').fill(marker('fallback'));
    await page.getByLabel(/I confirm the above details/).check();
    await submitGuestForm(page);
  });
});
