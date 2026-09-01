import { expect, test } from '@playwright/test';
import { EXPECTED, writeAadhaarCardImage } from './support/aadhaarFixture.js';
import { label, marker, submitGuestForm } from './support/pages.js';

test.describe('Aadhaar auto-fill', () => {
  test('reading a card fills the form and masks the Aadhaar number', async ({ page }) => {
    const cardImage = await writeAadhaarCardImage();
    await page.goto('/register');

    await page.getByLabel(label.upload).setInputFiles(cardImage);

    await expect(page.getByLabel(label.fullName)).toHaveValue(EXPECTED.fullName);
    await expect(page.getByLabel(label.dob)).toHaveValue(EXPECTED.dob);
    await expect(page.getByLabel(label.gender)).toHaveValue(EXPECTED.gender);
    await expect(page.getByLabel(label.idNumber)).toHaveValue(EXPECTED.maskedId);
    await expect(page.getByLabel(label.address)).toHaveValue(/Baner Road/);
    await expect(page.getByText(/please check them and correct anything/i)).toBeVisible();

    // Nothing on the page may carry a full Aadhaar number.
    expect(await page.content()).not.toMatch(/\b\d{12}\b/);
  });

  test('auto-filled details stay editable before submitting', async ({ page }) => {
    const cardImage = await writeAadhaarCardImage();
    await page.goto('/register');

    await page.getByLabel(label.upload).setInputFiles(cardImage);
    await expect(page.getByLabel(label.fullName)).toHaveValue(EXPECTED.fullName);

    await page.getByLabel(label.fullName).fill('Priya S Deshmukh');
    await page.getByLabel(label.phone).fill('9876500011');
    await page.getByLabel(label.purpose).fill(marker('autofill'));
    await page.getByLabel(label.consent).check();
    await submitGuestForm(page);
  });

  test('an unreadable image falls back to filling the form by hand', async ({ page }) => {
    await page.goto('/register');

    await page.getByLabel(label.upload).setInputFiles({
      name: 'blurry.png',
      mimeType: 'image/png',
      // A valid 1x1 PNG with no QR code in it.
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64'
      ),
    });

    await expect(page.getByText(/fill the form in yourself/i)).toBeVisible();
    await page.getByLabel(label.fullName).fill('Hand Filled Guest');
    await page.getByLabel(label.phone).fill('9876500012');
    await page.getByLabel(label.purpose).fill(marker('fallback'));
    await page.getByLabel(label.consent).check();
    await submitGuestForm(page);
  });
});
