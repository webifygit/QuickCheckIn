import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import QRCode from 'qrcode';
import request from 'supertest';
import { loadAppWithPrismaMock } from './helpers/app.js';
import { buildSecureQr, SAMPLE_FIELDS } from './helpers/secureQr.js';

const { app } = loadAppWithPrismaMock();

let fixtureDir;

// Renders a real PNG so the whole pipeline runs: multer -> jimp -> jsQR -> parser.
async function qrPng(name, payload) {
  const file = path.join(fixtureDir, `${name}.png`);
  await QRCode.toFile(file, [{ data: payload, mode: 'byte' }], { scale: 6, margin: 4 });
  return file;
}

beforeAll(async () => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aadhaar-fixtures-'));
});

afterAll(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true });
});

describe('POST /api/document/scan', () => {
  it('rejects a request with no image', async () => {
    const res = await request(app).post('/api/document/scan');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no image/i);
  });

  it('auto-fills the form from a real secure-QR image', async () => {
    const file = await qrPng('secure', buildSecureQr(SAMPLE_FIELDS));

    const res = await request(app).post('/api/document/scan').attach('document', file);

    expect(res.status).toBe(200);
    expect(res.body.fields).toMatchObject({
      fullName: 'Asha Ramesh Kulkarni',
      dob: '14/08/1991',
      gender: 'FEMALE',
      idNumber: 'XXXX XXXX 1234',
    });
    expect(res.body.documentKey).toMatch(/\.png$/);
  }, 30000);

  it('never returns a full Aadhaar number to the browser', async () => {
    const uid = '123456789012';
    const file = await qrPng(
      'legacy',
      `<?xml version="1.0"?><PrintLetterBarcodeData uid="${uid}" name="Ramesh Kulkarni" gender="M" yob="1985" dist="Pune" state="Maharashtra" pc="411001"/>`
    );

    const res = await request(app).post('/api/document/scan').attach('document', file);

    expect(res.body.fields.idNumber).toBe('XXXX XXXX 9012');
    expect(JSON.stringify(res.body)).not.toContain(uid);
  }, 30000);

  it('falls back to manual entry when the image carries no QR code', async () => {
    const blank = path.join(fixtureDir, 'blank.png');
    // 1x1 transparent PNG - a valid image with nothing to decode.
    fs.writeFileSync(
      blank,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        'base64'
      )
    );

    const res = await request(app).post('/api/document/scan').attach('document', blank);

    expect(res.status).toBe(200);
    expect(res.body.fields).toBeNull();
    expect(res.body.message).toMatch(/fill the form in yourself/i);
    // The upload is still kept, so the guest does not have to re-photograph it.
    expect(res.body.documentKey).toMatch(/\.png$/);
  }, 30000);

  it('falls back to manual entry for a QR that is not an Aadhaar card', async () => {
    const file = await qrPng('other', 'https://example.com/not-an-aadhaar');

    const res = await request(app).post('/api/document/scan').attach('document', file);

    expect(res.status).toBe(200);
    expect(res.body.fields).toBeNull();
    expect(res.body.message).toMatch(/fill the form in yourself/i);
  }, 30000);

  it('falls back to manual entry when the payload looks secure but is corrupt', async () => {
    // Numeric, so the parser takes the secure-QR path, but it is not gzip -
    // this must degrade gracefully rather than 500.
    const file = await qrPng('corrupt', '9999999999999999999999999999');

    const res = await request(app).post('/api/document/scan').attach('document', file);

    expect(res.status).toBe(200);
    expect(res.body.fields).toBeNull();
    expect(res.body.message).toMatch(/fill the form in yourself/i);
  }, 30000);

  it('refuses a non-image upload', async () => {
    const res = await request(app)
      .post('/api/document/scan')
      .attach('document', Buffer.from('not an image'), {
        filename: 'payload.txt',
        contentType: 'text/plain',
      });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toMatch(/JPEG, PNG or WEBP/i);
  });

  it('stores uploads under the configured upload directory only', async () => {
    const before = fs.readdirSync(process.env.UPLOAD_DIR);
    const file = await qrPng('stored', buildSecureQr(SAMPLE_FIELDS));

    await request(app).post('/api/document/scan').attach('document', file);

    const after = fs.readdirSync(process.env.UPLOAD_DIR);
    expect(after.length).toBe(before.length + 1);
  }, 30000);
});
