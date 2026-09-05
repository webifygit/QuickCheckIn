import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { buildSecureQr } from './helpers/secureQr.js';

const require = createRequire(import.meta.url);
const QRCode = require('qrcode');
const Jimp = require('jimp');
const { decodeQrFromImage } = require('../src/services/qrDecoder.service');

const CARD = {
  referenceId: '123420190101120000',
  name: 'Asha Ramesh Kulkarni',
  dob: '14-08-1991',
  gender: 'F',
  careOf: 'C/O Ramesh Kulkarni',
  district: 'Pune',
  landmark: 'Near Paud Phata',
  house: 'Flat 402',
  location: 'Kothrud',
  pincode: '411038',
  postOffice: 'Kothrud',
  state: 'Maharashtra',
  street: 'Paud Road',
  subDistrict: 'Haveli',
  vtc: 'Pune',
};

// A real secure QR carries a compressed photo blob, which is what pushes the
// symbol to ~137 modules. A fixture without one is a much easier symbol than
// anything the decoder meets in production, so include the padding.
const payload = () => buildSecureQr(CARD, { photoBytes: 1400 });

async function renderCard(payloadText, { qrPixels = 700, rotate = 0, blur = 0 } = {}) {
  const png = await QRCode.toBuffer(payloadText, {
    errorCorrectionLevel: 'L',
    margin: 4,
    scale: 10,
  });
  const qr = (await Jimp.read(png)).resize(qrPixels, qrPixels, Jimp.RESIZE_BILINEAR);

  // The symbol sits in a corner of a larger frame, as it does on a card.
  const card = new Jimp(Math.round(qrPixels * 3.4), Math.round(qrPixels * 2.2), 0xf2efe8ff);
  card.composite(qr, card.bitmap.width - qrPixels - 40, card.bitmap.height - qrPixels - 40);

  // Rotate with the canvas allowed to grow. Jimp's no-resize mode keeps the
  // frame and lets the corners fall outside it, which clipped the symbol - the
  // QR sits 40px from the bottom-right corner - and made this a test of a photo
  // with part of the QR missing rather than one taken at a slight angle.
  if (rotate) card.rotate(rotate, true);
  if (blur) card.blur(blur);
  return card.getBufferAsync(Jimp.MIME_JPEG);
}

// Every case here renders a ~137-module symbol with Jimp and then runs it
// through the real decoder - ZXing's wasm module first, then the jsQR sweep
// over enhanced variants when ZXing declines. That is seconds of genuine work
// per case (the no-QR photo is the slowest, because nothing short-circuits the
// sweep), so these carry their own timeout rather than vitest's 5s default.
// Raising the default globally instead would let a hung test elsewhere sit for
// a minute before failing.
const DECODE_TIMEOUT_MS = 60_000;

describe('reading the QR off a card photo', () => {
  it('reads a full-size secure QR', async () => {
    const expected = payload();

    expect(await decodeQrFromImage(await renderCard(expected))).toBe(expected);
  }, DECODE_TIMEOUT_MS);

  // Nobody holds a card square to the lens.
  it('reads one from a photo taken at a slight angle', async () => {
    const expected = payload();

    expect(await decodeQrFromImage(await renderCard(expected, { rotate: 7 }))).toBe(expected);
  }, DECODE_TIMEOUT_MS);

  // The symbol here has roughly three pixels per module, which is about the
  // floor for any decoder - a guest photographing the whole card from a step back.
  it('reads a small symbol in a large frame', async () => {
    const expected = payload();

    expect(await decodeQrFromImage(await renderCard(expected, { qrPixels: 420 }))).toBe(expected);
  }, DECODE_TIMEOUT_MS);

  it('returns null for a photo with no QR in it, rather than throwing', async () => {
    const blank = await new Jimp(1200, 800, 0xffffffff).getBufferAsync(Jimp.MIME_JPEG);

    expect(await decodeQrFromImage(blank)).toBeNull();
  }, DECODE_TIMEOUT_MS);

  // Deliberately distinct from "no QR in this photo": an operator running
  // scripts/scan-check.js against real cards needs to tell a corrupt file apart
  // from a card the decoder simply could not read. The scan route treats both
  // as "fill the form in yourself", so nothing reaches a guest either way.
  it('rejects bytes that are not a decodable image, rather than reporting no QR', async () => {
    await expect(decodeQrFromImage(Buffer.from('not an image'))).rejects.toThrow();
  }, DECODE_TIMEOUT_MS);
});

describe('telling a guest what was wrong with the photo', () => {
  const { describePhotoProblem } = require('../src/services/qrDecoder.service');

  // The thresholds come from measured card photos: one that decoded scored 167
  // brightness and 9.1% detail; the one that sent us down this path scored 76
  // and 1.0%.
  const photo = (quality) => ({ source: { width: 2000, height: 1500 }, quality });

  it('names darkness when the photo is underexposed', () => {
    expect(describePhotoProblem(photo({ brightness: 76, detail: 1 }))).toMatch(/dark/i);
  });

  // A real Aadhaar card arrived sharp, well lit, and undecodable: the card's own
  // printing had merged the modules of a ~177-module symbol at the four pixels
  // per module a whole-card photo affords. Measuring the image cannot tell that
  // apart from camera blur, so a low-detail photo is not accused of anything.
  it('does not accuse a bright photo of being out of focus', () => {
    expect(describePhotoProblem(photo({ brightness: 180, detail: 0.6 }))).toBeNull();
  });

  // A thumbnail has no exposure or focus worth commenting on.
  it('says nothing about an image too small to judge', () => {
    expect(
      describePhotoProblem({ source: { width: 1, height: 1 }, quality: { brightness: 0, detail: 0 } })
    ).toBeNull();
  });

  // A well-taken photo of a PAN card or a licence has nothing wrong with it.
  // Blaming the photo there sends the guest round a loop with no exit.
  it('blames nothing when the photo is fine and the card simply has no Aadhaar QR', () => {
    expect(describePhotoProblem(photo({ brightness: 167, detail: 9.1 }))).toBeNull();
  });

  it('says nothing when quality was never measured', () => {
    expect(describePhotoProblem({})).toBeNull();
    expect(describePhotoProblem(null)).toBeNull();
  });
});
