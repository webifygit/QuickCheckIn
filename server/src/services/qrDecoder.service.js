const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const jsQR = require('jsqr');
const { readBarcodesFromImageFile, prepareZXingModule } = require('zxing-wasm/reader');
const logger = require('../lib/logger');

// Reading the QR off a photo of an Aadhaar card is the hardest thing this
// service does, and the payload is what makes it hard: once the card's photo
// blob is included it runs to about 1.5KB, which puts the symbol at version
// 30-40 - roughly 137 modules across. A decoder needs around three pixels per
// module, so on a photo of a whole card there is very little headroom, and any
// perspective from holding the card at an angle eats what is left.
//
// Two decoders, in this order:
//
//   ZXing (WebAssembly) does perspective correction and its own binarisation.
//   On card photos taken at an angle it reads symbols jsQR cannot, and it
//   answers in about a tenth of a second either way.
//
//   jsQR is the fallback. It is pure JavaScript, so it still runs if the wasm
//   module fails to initialise, and its sweep of enhanced variants occasionally
//   catches an image ZXing declines. It is slow, which is why it goes second.
//
// Measured on a fixture set of synthetic card photos (see scripts/scan-check.js
// for running real ones): ZXing reads 7 of 9 in 40-150ms; the jsQR sweep reads
// 6 of 9 in 0.6-6.7s. The two the pair cannot read are genuinely unreadable -
// too few pixels per module, or too much motion blur - and the guest is better
// served by the manual form.

// A photo decodes to four bytes per pixel, so 12MP is ~48MB for the source
// bitmap: the most one request may hold in the jsQR path. Downscaling below
// this is what makes readable cards unreadable - it takes the symbol under the
// sampling floor.
const MAX_SOURCE_PIXELS = 12_000_000;

// The largest single buffer a jsQR pass may build, which is what bounds the 2x
// upscale on a big source.
const MAX_VARIANT_PIXELS = 17_000_000;

// The jsQR sweep stops here whatever it has found. A guest is waiting on this
// request, and past a few seconds they are better served by typing the form in.
const JSQR_BUDGET_MS = 5_000;

// The wasm binary is loaded from disk rather than fetched: zxing-wasm's default
// loader expects a URL it can fetch, which is a browser assumption.
const WASM_PATH = path.join(
  path.dirname(require.resolve('zxing-wasm/reader')),
  '..',
  '..',
  'reader',
  'zxing_reader.wasm'
);

const READER_OPTIONS = {
  formats: ['QRCode'],
  // Spend the extra effort: this runs once per guest, not per video frame.
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  maxNumberOfSymbols: 1,
};

// Compiled once and reused. Initialised eagerly at boot by initQrDecoder() so
// the first guest of the day does not pay for it; falls back to lazy if that
// was skipped. A failure here is remembered, not retried per request.
let zxingReady = null;

function prepareZXing() {
  if (!zxingReady) {
    zxingReady = (async () => {
      const wasmBinary = await fs.promises.readFile(WASM_PATH);
      await prepareZXingModule({ overrides: { wasmBinary }, fireImmediately: true });
      return true;
    })().catch((err) => {
      logger.error({ err: err.message }, 'ZXing wasm failed to initialise, falling back to jsQR');
      return false;
    });
  }
  return zxingReady;
}

async function decodeWithZXing(buffer) {
  if (!(await prepareZXing())) return null;

  const results = await readBarcodesFromImageFile(new Blob([buffer]), READER_OPTIONS);
  return results.find((result) => result.text)?.text || null;
}

function scanBitmap(image) {
  const { data, width, height } = image.bitmap;
  if (width * height > MAX_VARIANT_PIXELS) return null;
  const result = jsQR(new Uint8ClampedArray(data), width, height, {
    inversionAttempts: 'attemptBoth',
  });
  return result?.data || null;
}

// Jimp throws if a crop runs a pixel past the edge, and rounding a fractional
// grid does exactly that, so every box is clamped to the bitmap.
function cropFraction(image, xFraction, yFraction, sizeFraction) {
  const { width, height } = image.bitmap;
  const x = Math.max(0, Math.min(width - 1, Math.round(width * xFraction)));
  const y = Math.max(0, Math.min(height - 1, Math.round(height * yFraction)));
  const w = Math.max(1, Math.min(width - x, Math.round(width * sizeFraction)));
  const h = Math.max(1, Math.min(height - y, Math.round(height * sizeFraction)));
  return image.clone().crop(x, y, w, h);
}

// An overlapping grid: a QR straddling a tile boundary would be cut in half by a
// flush one, and half a symbol decodes to nothing.
function gridTiles(image, divisions, overlap = 0.3) {
  const step = 1 / divisions;
  const size = step * (1 + overlap);
  const tiles = [];

  for (let row = 0; row < divisions; row += 1) {
    for (let column = 0; column < divisions; column += 1) {
      const x = Math.max(0, Math.min(1 - size, column * step - (size - step) / 2));
      const y = Math.max(0, Math.min(1 - size, row * step - (size - step) / 2));
      tiles.push(() => cropFraction(image, x, y, size));
    }
  }
  return tiles;
}

// Each pass is one guess at why the previous one failed, in measured order of
// how often it is the answer.
function jsqrPasses(grey) {
  const pixels = grey.bitmap.width * grey.bitmap.height;
  const passes = [
    // By far the most productive pass: the photo exactly as it arrived.
    () => grey,
    // Flat or oddly exposed lighting - a card shot under a reception lamp.
    () => grey.clone().normalize(),
  ];

  // Too few pixels per module. Enlarging adds no information, but it gives
  // jsQR's binariser and grid sampler room to resolve modules it otherwise
  // merges. Skipped on large sources, where it would blow the buffer ceiling.
  if (pixels * 4 <= MAX_VARIANT_PIXELS) {
    passes.push(
      () => grey.clone().scale(2),
      () => grey.clone().scale(2).contrast(0.35),
      () => grey.clone().normalize().scale(2)
    );
  }

  // Sensor noise on a dim shot: shrinking averages it away, at the cost of the
  // resolution the earlier passes needed.
  passes.push(() => grey.clone().scale(0.5).normalize());

  // Last resort, and the only pass that assumes nothing about where the symbol
  // is: a QR occupying a small part of a wide frame, which no whole-image pass
  // can enlarge without exceeding the buffer ceiling.
  for (const tile of gridTiles(grey, 3)) {
    passes.push(() => tile(), () => tile().normalize());
  }

  return passes;
}

async function decodeWithJsQr(input) {
  const deadline = Date.now() + JSQR_BUDGET_MS;

  let image = await Jimp.read(input);

  const sourcePixels = image.bitmap.width * image.bitmap.height;
  if (sourcePixels > MAX_SOURCE_PIXELS) {
    image = image.scale(Math.sqrt(MAX_SOURCE_PIXELS / sourcePixels));
  }

  // Greyscale once, up front: every pass below works from this.
  const grey = image.greyscale();

  for (const makePass of jsqrPasses(grey)) {
    if (Date.now() > deadline) break;

    let candidate;
    try {
      candidate = makePass();
    } catch (err) {
      // A transform that cannot be applied to this image is not a failure of
      // the scan - the next pass may still read it.
      continue;
    }

    const decoded = scanBitmap(candidate);
    if (decoded) return decoded;
  }

  return null;
}

// Accepts a Buffer (what the upload middleware holds) or a path (what
// scripts/scan-check.js passes). Returns the QR's text, or null.
async function decodeQrFromImage(input) {
  const buffer = Buffer.isBuffer(input) ? input : await fs.promises.readFile(input);

  try {
    const decoded = await decodeWithZXing(buffer);
    if (decoded) return decoded;
  } catch (err) {
    // A decoder that cannot read this image must not fail the request: the
    // slower one may still manage, and failing that the guest types it in.
    logger.warn({ err: err.message }, 'ZXing decode failed, falling back to jsQR');
  }

  return decodeWithJsQr(buffer);
}

// Called at boot so the wasm module is compiled before the first guest arrives.
// Never throws: a failure here degrades to the jsQR path, which is why it is
// worth having.
async function initQrDecoder() {
  const ready = await prepareZXing();
  logger.info({ decoder: ready ? 'zxing+jsqr' : 'jsqr only' }, 'QR decoder initialised');
  return ready;
}

module.exports = { decodeQrFromImage, initQrDecoder };
