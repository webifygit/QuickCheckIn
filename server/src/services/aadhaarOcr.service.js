const path = require('path');
const Jimp = require('jimp');
const { createWorker, PSM } = require('tesseract.js');
const logger = require('../lib/logger');

// Reads the printed text off an Aadhaar card, for the cards whose QR cannot be
// read at all.
//
// That case is not rare and it is not the guest's fault. A cut-out Aadhaar card
// is about 8.5cm wide, which puts the secure QR near 2.5cm; at ~137 modules
// that is 0.18mm each, and consumer printing bleeds them together. Measured on a
// real card: the finder square photographs perfectly crisp while the data
// squares have merged into blobs, and no decoder reads it - whole image or
// tiled, with every option turned up. The grid is destroyed at the printer.
//
// The printed text on the same card is perfectly legible, so it is what is left
// to read. This is strictly a fallback: the QR is exact and signed, while this
// is a guess that a human then checks.
//
// THIS IS A MEASUREMENT SPIKE. It runs after a failed QR decode, records what
// it found and how long it took, and does not yet feed the guest's form. The
// question it exists to answer is whether tesseract fits inside a Vercel
// function at all - the traineddata has to be bundled rather than fetched, and
// the filesystem is read-only outside /tmp. Both are the shape of bug that had
// the QR decoder silently running on its fallback in production for weeks.

// Bundled rather than downloaded. tesseract.js otherwise fetches ~5MB from a CDN
// on every cold start, which is slow, fails closed, and is exactly how the wasm
// decoder ended up never running here. Written out as a literal path so the
// serverless file tracer can see it.
const TESSDATA_DIR = path.join(__dirname, '..', '..', 'tessdata');

// The only writable directory a serverless function has, and its contents do not
// survive the invocation. Without this tesseract tries to cache beside the
// process and dies on a read-only filesystem.
const CACHE_DIR = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME ? '/tmp' : TESSDATA_DIR;

// Text has to be tall enough for tesseract, which is why the whole card cannot
// simply be enlarged: at the scale that makes the name readable a full card runs
// past 5000px, and the pass costs more than the timeout allows. Regions are
// cropped small and enlarged hard instead.
const ROI_TARGET_WIDTH = 2400;

// Where each field sits as a fraction of the card itself, not of the photo.
// Aadhaar's layout is fixed, so once the card's own edges are known these hold
// wherever it sits in frame. Derived from a real card and, so far, only one -
// which is the weakest part of this and the reason for the confidence logging.
const REGIONS = {
  // Name, date of birth and gender, printed as a block beside the photograph.
  identity: { x: 0.3, y: 0.18, w: 0.46, h: 0.36, psm: PSM.SINGLE_COLUMN },
  // The number, printed large across the lower third.
  number: { x: 0.1, y: 0.55, w: 0.85, h: 0.3, psm: PSM.SINGLE_COLUMN },
};

let workerPromise = null;

// One worker for the life of the process, so a warm invocation pays nothing.
// A failure is not cached: a cold start that lost the network deserves another
// attempt rather than a permanently broken fallback.
function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng', 1, {
      langPath: TESSDATA_DIR,
      cachePath: CACHE_DIR,
      // The bundled file is uncompressed; left on, tesseract looks for .gz.
      gzip: false,
    }).catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

// The card is the bright rectangle in a darker frame. Row and column brightness
// profiles find it without contour detection, which keeps this to one cheap pass
// over a 320px thumbnail.
function findCard(image) {
  const small = image.clone().greyscale().resize(320, Jimp.AUTO);
  const { width, height, data } = small.bitmap;
  const luminance = (x, y) => data[(y * width + x) << 2];

  const samples = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) samples.push(luminance(x, y));
  }
  samples.sort((a, b) => a - b);
  const threshold = samples[Math.floor(samples.length * 0.55)];

  const columns = new Array(width).fill(0);
  const rows = new Array(height).fill(0);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (luminance(x, y) > threshold) {
        columns[x] += 1;
        rows[y] += 1;
      }
    }
  }

  // A row or column counts as card if a third of it is bright, which ignores
  // both a stray highlight and a bright patch of background.
  const span = (hits, across) => {
    const needed = across * 0.35;
    const first = hits.findIndex((v) => v > needed);
    if (first < 0) return [0, 1];
    const last = hits.length - 1 - [...hits].reverse().findIndex((v) => v > needed);
    return [first / hits.length, (last + 1) / hits.length];
  };

  const [x0, x1] = span(columns, height);
  const [y0, y1] = span(rows, width);
  return { x0, x1, y0, y1 };
}

function cropRegion(card, region) {
  const { width, height } = card.bitmap;
  const x = Math.max(0, Math.round(width * region.x));
  const y = Math.max(0, Math.round(height * region.y));
  const w = Math.max(1, Math.min(width - x, Math.round(width * region.w)));
  const h = Math.max(1, Math.min(height - y, Math.round(height * region.h)));
  const crop = card.clone().crop(x, y, w, h).normalize();
  return crop.scale(Math.max(1, Math.min(5, ROI_TARGET_WIDTH / w)));
}

// Returns what it read plus how long every part of it took. The timings are the
// output that matters right now: they decide whether this stays in the function
// or moves to a service of its own.
async function readCardText(buffer) {
  const startedAt = Date.now();
  const timings = {};

  const worker = await getWorker();
  timings.workerMs = Date.now() - startedAt;

  const image = await Jimp.read(buffer);
  const { width: W, height: H } = image.bitmap;
  const box = findCard(image);
  const card = image.crop(
    Math.round(box.x0 * W),
    Math.round(box.y0 * H),
    Math.max(1, Math.round((box.x1 - box.x0) * W)),
    Math.max(1, Math.round((box.y1 - box.y0) * H))
  ).greyscale();
  timings.prepareMs = Date.now() - startedAt - timings.workerMs;

  const found = {};
  for (const [name, region] of Object.entries(REGIONS)) {
    const at = Date.now();
    try {
      await worker.setParameters({ tessedit_pageseg_mode: region.psm });
      const { data } = await worker.recognize(await cropRegion(card, region).getBufferAsync('image/png'));
      found[name] = { text: data.text.replace(/\s+/g, ' ').trim(), confidence: Math.round(data.confidence) };
    } catch (err) {
      found[name] = { text: '', confidence: 0, error: err.message };
    }
    timings[`${name}Ms`] = Date.now() - at;
  }

  timings.totalMs = Date.now() - startedAt;
  return { found, timings, cardBox: box };
}

// A hang is the failure this has to be defended against, not a slow read.
// When tesseract's core wasm was missing from the deployment, emscripten aborted
// inside the worker and killed it without ever rejecting the promise waiting on
// it: every request sat until the platform's 60s ceiling and returned a 504. A
// missing file turned into an outage on the one path that was already failing.
//
// Ten seconds is far outside anything measured - a whole card reads in about
// two - so this only ever fires on that kind of fault. The wait is abandoned
// rather than cancelled, since a wedged worker will not answer anyway; the
// process is short-lived and the next invocation starts clean.
const OCR_BUDGET_MS = 10_000;

// Never throws: this is a fallback behind a fallback, and a guest who is already
// being asked to type their details must not also meet a 500 or a timeout.
async function tryReadCardText(buffer) {
  let timer;
  try {
    return await Promise.race([
      readCardText(buffer),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`OCR exceeded ${OCR_BUDGET_MS}ms`)), OCR_BUDGET_MS);
      }),
    ]);
  } catch (err) {
    logger.warn({ err: err.message }, 'OCR fallback failed');
    // A worker that timed out is not reusable, and holding the promise would
    // make every later call wait on the same wedged one.
    workerPromise = null;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { tryReadCardText, readCardText, REGIONS };
