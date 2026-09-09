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

// A valid 1x1 PNG with nothing to decode. Attached wherever a test needs the
// upload to succeed while the image itself yields no QR.
function blankPng() {
  const file = path.join(fixtureDir, 'blank.png');
  fs.writeFileSync(
    file,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64'
    )
  );
  return file;
}

beforeAll(async () => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aadhaar-fixtures-'));
});

afterAll(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
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
    const res = await request(app).post('/api/document/scan').attach('document', blankPng());

    expect(res.status).toBe(200);
    expect(res.body.fields).toBeNull();
    expect(res.body.message).toMatch(/fill in the details below/i);
    // A guest who uploaded a PAN card, a licence or a passport is not holding a
    // bad photo, and telling them to retake it sends them in circles. The
    // message has to name the real reason.
    expect(res.body.message).toMatch(/close up enough to fill the frame/i);
    // The upload is still kept, so the guest does not have to re-photograph it.
    expect(res.body.documentKey).toMatch(/\.png$/);
  }, 30000);

  it('falls back to manual entry for a QR that is not an Aadhaar card', async () => {
    const file = await qrPng('other', 'https://example.com/not-an-aadhaar');

    const res = await request(app).post('/api/document/scan').attach('document', file);

    expect(res.status).toBe(200);
    expect(res.body.fields).toBeNull();
    expect(res.body.message).toMatch(/fill in the details below/i);
  }, 30000);

  it('falls back to manual entry when the payload looks secure but is corrupt', async () => {
    // Numeric, so the parser takes the secure-QR path, but it is not gzip -
    // this must degrade gracefully rather than 500.
    const file = await qrPng('corrupt', '9999999999999999999999999999');

    const res = await request(app).post('/api/document/scan').attach('document', file);

    expect(res.status).toBe(200);
    expect(res.body.fields).toBeNull();
    expect(res.body.message).toMatch(/fill in the details below/i);
  }, 30000);

  // The live-camera path (client/src/components/QrCamera.jsx) reads the QR in
  // the browser and sends its text with the frame it read it from. Every test
  // below attaches an image with nothing to decode, which is what proves the
  // server used the supplied text rather than quietly reading the photo.
  describe('when the client decoded the QR itself', () => {
    it('auto-fills from the supplied QR text', async () => {
      const res = await request(app)
        .post('/api/document/scan')
        .field('qrText', buildSecureQr(SAMPLE_FIELDS))
        .attach('document', blankPng());

      expect(res.status).toBe(200);
      expect(res.body.fields).toMatchObject({
        fullName: 'Asha Ramesh Kulkarni',
        dob: '14/08/1991',
        gender: 'FEMALE',
      });
      // The photo is still stored: staff review the frame the details came from.
      expect(res.body.documentKey).toMatch(/\.png$/);
    });

    // The whole reason parsing stays on the server. A browser that could send
    // fields instead of QR text would be a browser that could skip the masking.
    it('still masks the Aadhaar number down to four digits', async () => {
      const uid = '123456789012';

      const res = await request(app)
        .post('/api/document/scan')
        .field(
          'qrText',
          `<?xml version="1.0"?><PrintLetterBarcodeData uid="${uid}" name="Ramesh Kulkarni" gender="M" yob="1985" state="Maharashtra"/>`
        )
        .attach('document', blankPng());

      expect(res.body.fields.idNumber).toBe('XXXX XXXX 9012');
      expect(JSON.stringify(res.body)).not.toContain(uid);
    });

    // Two bounds, and they fail differently on purpose. A payload longer than
    // any real QR is ignored and the guest carries on typing, because a failed
    // scan is never an error condition. A payload large enough to be an attack
    // on the parser is refused outright at the boundary.
    it('ignores a payload longer than any real QR, and still lets the guest continue', async () => {
      const res = await request(app)
        .post('/api/document/scan')
        .field('qrText', '9'.repeat(10_000))
        .attach('document', blankPng());

      expect(res.status).toBe(200);
      expect(res.body.fields).toBeNull();
      expect(res.body.message).toMatch(/fill in the details below/i);
      expect(res.body.documentKey).toMatch(/\.png$/);
    }, 30000);

    it('refuses a field too large to accept, without blaming the photo', async () => {
      const res = await request(app)
        .post('/api/document/scan')
        .field('qrText', '9'.repeat(64_000))
        .attach('document', blankPng());

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/field was too large/i);
      expect(res.body.error).not.toMatch(/JPEG|PNG|WEBP/i);
    });

    it('falls back to manual entry when the text is not an Aadhaar QR', async () => {
      const res = await request(app)
        .post('/api/document/scan')
        .field('qrText', 'https://example.com/not-an-aadhaar')
        .attach('document', blankPng());

      expect(res.status).toBe(200);
      expect(res.body.fields).toBeNull();
      expect(res.body.message).toMatch(/fill in the details below/i);
    });
  });

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
