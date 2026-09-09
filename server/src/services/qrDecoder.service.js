const fs = require('fs');
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

// The jsQR sweep stops here whatever it has found. This budget is spent in full
// on every image that has no readable Aadhaar QR - which includes every PAN
// card, licence and passport a guest uploads, so it is not a rare path. At five
// seconds the guest watched a spinner for nearly seven before being told to
// type the details in; ZXing has already had its say by then, and on every
// image measured it read strictly more than the sweep did. Two and a half
// seconds keeps the fallback for the case it exists for - the wasm module
// failing to load - without charging every other guest for it.
const JSQR_BUDGET_MS = 2_500;

// The wasm binary is loaded from disk rather than fetched: zxing-wasm's default
// loader expects a URL it can fetch, which is a browser assumption.
//
// Resolved through the package's own exports map, with the specifier written
// out in full. That is not a style preference - a serverless build decides what
// to ship by reading the source, and it only recognises a require.resolve whose
// argument is a literal string. The path this replaced was assembled with
// path.join from a different entry point, which no bundler can follow: the file
// was left out of the deployment, this init failed with ENOENT on every cold
// start, and every scan silently fell through to the jsQR path - the slow
// fallback that exists for when the wasm cannot load, quietly doing all the
// work in production while the fast decoder was never even tried.
const WASM_PATH = require.resolve('zxing-wasm/reader/zxing_reader.wasm');

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

// Sampled every fourth pixel in both directions - enough to characterise a photo
// and cheap enough to run on an image that has already failed to decode.
//
// Two numbers, both measured against card photos that do decode:
//
//   brightness - a card fills the frame with a light document. One that decoded
//     measured 167/255; a photo taken in poor light measured 76.
//   detail - the share of adjacent pixels differing sharply, which is what both
//     printed text and a QR's modules produce. A card photo that decoded
//     measured 9.1% in its busiest region; an out-of-focus one measured 1.0%.
//
// Neither proves anything on its own. Together with "no QR was found" they are
// the difference between telling a guest to find better light and letting them
// photograph the same card six times.
function measureQuality(grey) {
  const { width, height, data } = grey.bitmap;
  const luminance = (x, y) => data[(y * width + x) << 2];

  let sum = 0;
  let samples = 0;
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      sum += luminance(x, y);
      samples += 1;
    }
  }

  // Detail is measured per cell and the busiest one wins: a QR occupies a small
  // part of the frame, so averaging over the whole image would bury it.
  const CELLS = 12;
  const cellWidth = Math.floor(width / CELLS);
  const cellHeight = Math.floor(height / CELLS);
  let busiest = 0;

  if (cellWidth > 2 && cellHeight > 2) {
    for (let row = 0; row < CELLS; row += 1) {
      for (let column = 0; column < CELLS; column += 1) {
        let edges = 0;
        let counted = 0;
        for (let y = row * cellHeight; y < (row + 1) * cellHeight - 1; y += 2) {
          for (let x = column * cellWidth; x < (column + 1) * cellWidth - 1; x += 2) {
            if (Math.abs(luminance(x, y) - luminance(x + 1, y)) > 60) edges += 1;
            counted += 1;
          }
        }
        if (counted) busiest = Math.max(busiest, edges / counted);
      }
    }
  }

  return {
    brightness: samples ? Math.round(sum / samples) : null,
    detail: Number((busiest * 100).toFixed(1)),
  };
}

// What a failed read is worth knowing about. "It didn't work" is not something
// anyone can act on; the size of the image and how far the symbol was from
// being readable is. Roughly three pixels per module is the floor for any
// decoder, and a real secure QR is about 137 modules across, so a card
// occupying a third of the frame needs the numbers below to be comfortable.
function describeImage(image) {
  const { width, height } = image.bitmap;
  return {
    width,
    height,
    megapixels: Number(((width * height) / 1_000_000).toFixed(1)),
  };
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

async function decodeWithJsQr(input, diagnostics) {
  const deadline = Date.now() + JSQR_BUDGET_MS;

  let image = await Jimp.read(input);

  if (diagnostics) diagnostics.source = describeImage(image);

  const sourcePixels = image.bitmap.width * image.bitmap.height;
  if (sourcePixels > MAX_SOURCE_PIXELS) {
    image = image.scale(Math.sqrt(MAX_SOURCE_PIXELS / sourcePixels));
    if (diagnostics) diagnostics.downscaledTo = describeImage(image);
  }

  // Greyscale once, up front: every pass below works from this.
  const grey = image.greyscale();

  if (diagnostics) diagnostics.quality = measureQuality(grey);

  let passesRun = 0;
  for (const makePass of jsqrPasses(grey)) {
    if (Date.now() > deadline) {
      if (diagnostics) diagnostics.jsqrRanOutOfTime = true;
      break;
    }

    let candidate;
    try {
      candidate = makePass();
    } catch (err) {
      // A transform that cannot be applied to this image is not a failure of
      // the scan - the next pass may still read it.
      continue;
    }

    passesRun += 1;
    const decoded = scanBitmap(candidate);
    if (decoded) {
      if (diagnostics) diagnostics.jsqrPasses = passesRun;
      return decoded;
    }
  }

  if (diagnostics) diagnostics.jsqrPasses = passesRun;
  return null;
}

// Accepts a Buffer (what the upload middleware holds) or a path (what
// scripts/scan-check.js passes). Returns the QR's text and a record of how the
// attempt went - the latter is what turns "it didn't work" into something
// anyone can act on, whether it is read from a log line or printed by
// scripts/scan-check.js.
async function decodeQrWithDiagnostics(input) {
  const startedAt = Date.now();
  const buffer = Buffer.isBuffer(input) ? input : await fs.promises.readFile(input);
  const diagnostics = { bytes: buffer.length, decoder: null };

  try {
    const zxingStartedAt = Date.now();
    const decoded = await decodeWithZXing(buffer);
    diagnostics.zxingMs = Date.now() - zxingStartedAt;
    if (decoded) {
      diagnostics.decoder = 'zxing';
      diagnostics.totalMs = Date.now() - startedAt;
      return { text: decoded, diagnostics };
    }
  } catch (err) {
    // A decoder that cannot read this image must not fail the request: the
    // slower one may still manage, and failing that the guest types it in.
    diagnostics.zxingError = err.message;
    logger.warn({ err: err.message }, 'ZXing decode failed, falling back to jsQR');
  }

  const jsqrStartedAt = Date.now();
  const decoded = await decodeWithJsQr(buffer, diagnostics);
  diagnostics.jsqrMs = Date.now() - jsqrStartedAt;
  diagnostics.totalMs = Date.now() - startedAt;
  if (decoded) diagnostics.decoder = 'jsqr';

  return { text: decoded, diagnostics };
}

// The plain form, for callers that only care whether it worked.
async function decodeQrFromImage(input) {
  const { text } = await decodeQrWithDiagnostics(input);
  return text;
}

// Called at boot so the wasm module is compiled before the first guest arrives.
// Never throws: a failure here degrades to the jsQR path, which is why it is
// worth having.
async function initQrDecoder() {
  const ready = await prepareZXing();
  logger.info({ decoder: ready ? 'zxing+jsqr' : 'jsqr only' }, 'QR decoder initialised');
  return ready;
}

// There was a describePhotoProblem() here that turned these measurements into a
// diagnosis for the guest - "too dark", "out of focus". It was wrong both times
// it met a real card.
//
// Out of focus: the photo was sharp; the card's own printing had merged the
// modules of a ~177-module symbol at the four pixels per module a whole-card
// photo affords.
//
// Too dark: mean brightness is meaningless on a close-up of a QR, which is half
// black by design. Measured across four real uploads the means ran 76-139 while
// the 90th percentile - the white modules - ran 177-222 on every single one.
// Bright photos, low means, and the check fired on the ones it should not have.
//
// Both numbers stay in the diagnostics, because they are worth having in a log
// when someone reports a failure. Neither is good enough to accuse a guest of
// anything, and a wrong diagnosis is worse than none: it sends someone off to
// fix a problem they do not have. The message now gives the advice that helps
// whatever the cause - get the QR close, fill the frame, avoid glare.

module.exports = {
  decodeQrFromImage,
  decodeQrWithDiagnostics,
  initQrDecoder,
};
