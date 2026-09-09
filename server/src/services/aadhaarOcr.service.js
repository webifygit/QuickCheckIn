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
  // The address, which is on the other side of the card entirely. Both sides
  // are put through the same regions because a guest's two uploads arrive as
  // separate requests and nothing says which is which - whichever region finds
  // something wins, and the ones looking at the wrong side come back empty.
  address: { x: 0, y: 0.15, w: 0.62, h: 0.7, psm: PSM.SINGLE_BLOCK },
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
      // Line breaks are kept: the address is the one field whose structure
      // survives in them, and flattening it here would throw that away before
      // the parser ever sees it.
      found[name] = { text: data.text.trim(), confidence: Math.round(data.confidence) };
    } catch (err) {
      found[name] = { text: '', confidence: 0, error: err.message };
    }
    timings[`${name}Ms`] = Date.now() - at;
  }

  timings.totalMs = Date.now() - startedAt;
  return { found, timings, cardBox: box };
}

// Aadhaar numbers carry a Verhoeff check digit, and here that is not a nicety.
// A card prints two long numbers next to each other - the Aadhaar and the VID -
// and OCR picks whichever it likes: every preprocessed read of one real card
// returned the VID's digits. Storing those as a guest's Aadhaar would be a
// silently wrong record, which is worse than no record because it looks right.
// The checksum is what tells them apart.
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

function isValidAadhaar(digits) {
  if (!/^\d{12}$/.test(digits)) return false;
  // A real number never starts 0 or 1, which rejects a lot of misreads for free.
  if (digits[0] === '0' || digits[0] === '1') return false;
  let c = 0;
  const reversed = digits.split('').reverse().map(Number);
  reversed.forEach((digit, i) => {
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][digit]];
  });
  return c === 0;
}

// Only ever the last four leave this function. The full number is read to be
// checksummed and then dropped on the floor - the guarantee that it is never
// stored should not depend on a later step remembering to mask it.
function maskedNumberFrom(text) {
  const candidates = (text.replace(/[^\d\s]/g, ' ').match(/\b\d{4}\s?\d{4}\s?\d{4}\b/g) || [])
    .map((m) => m.replace(/\s/g, ''));
  const valid = candidates.find(isValidAadhaar);
  return valid ? `XXXX XXXX ${valid.slice(-4)}` : '';
}

const GENDERS = [
  [/\bFEMALE\b/i, 'FEMALE'],
  [/\bTRANSGENDER\b/i, 'TRANSGENDER'],
  // Last, and only after FEMALE has had its turn - it contains MALE.
  [/\bMALE\b/i, 'MALE'],
];

// The name sits before the date of birth in the identity block, surrounded by
// whatever tesseract made of the Gujarati or Hindi line above it. Title-cased
// words are what survives cleanly, and picking those out of the noise is more
// reliable than trying to clean the noise up.
function nameFrom(text) {
  const beforeDob = text.split(/\d{2}\s*[/.-]\s*\d{2}\s*[/.-]\s*\d{4}/)[0] || '';
  const titled = beforeDob.match(/\b[A-Z][a-z]{2,}\b/g) || [];
  if (titled.length >= 2) return titled.slice(-4).join(' ');
  // Some cards print the name in capitals, where the rule above finds nothing.
  const shouted = (beforeDob.match(/\b[A-Z]{3,}\b/g) || []).filter((w) => !/^(DOB|MALE|FEMALE|VID)$/.test(w));
  return shouted.length >= 2 ? shouted.slice(-4).join(' ') : '';
}

function dobFrom(text) {
  const m = text.match(/\b(\d{2})\s*[/.-]\s*(\d{2})\s*[/.-]\s*(\d{4})\b/);
  if (!m) return '';
  const year = Number(m[3]);
  if (year < 1900 || year > new Date().getFullYear()) return '';
  return `${m[1]}/${m[2]}/${m[3]}`;
}

// The address block is the one field where tesseract's line breaks carry
// meaning, so it is rebuilt rather than flattened.
//
// It has to start from an anchor rather than from the top of the region. Every
// card prints the address twice - once in the local script and once in English -
// and tesseract renders the Gujarati or Hindi pass as convincing-looking
// nonsense that would otherwise be pasted onto the front of a real address. The
// English block always opens with a care-of line, so that is where to begin.
// The leading letter is matched loosely because a crop that clips it, or a
// misread, must not lose the whole field.
const CARE_OF = /(?:^|\s)[CSWDcswd]?\s*\/\s*[Oo]\b/;

function addressFrom(text) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 8 && (l.match(/[A-Za-z]/g) || []).length / l.length > 0.55);

  const start = lines.findIndex((l) => CARE_OF.test(l) || /^address/i.test(l));
  if (start < 0) return '';

  const joined = lines
    .slice(start, start + 7)
    .join(', ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/^address:?\s*/i, '')
    // Tesseract leaves specks at the edges of lines - a stray "3%" where the
    // card's border was. Dropped only from the ends of parts, where they are
    // artefacts; the same characters in the middle are usually real.
    .split(',')
    .map((part) => part.trim().replace(/^[^A-Za-z0-9]+/, '').replace(/\s+[^A-Za-z0-9\s]+$/, ''))
    .filter((part) => part.length > 1)
    .join(', ')
    .trim();

  // An address has a shape: a pincode, or several parts. Without one of those
  // this is the identity block on the other side of the card, or noise that
  // happened to contain a slash - and a plausible-looking wrong address is the
  // hardest kind of error for a guest to spot in their own details.
  const hasPincode = /\b\d{6}\b/.test(joined);
  const parts = joined.split(',').filter((p) => p.trim().length > 2).length;
  return joined.length >= 25 && (hasPincode || parts >= 4) ? joined : '';
}

// Turns what the regions read into the same shape parseAadhaarQr returns, so
// the caller cannot tell the two apart and nothing downstream needs to care.
// Every field is independent: a card that yields a date of birth but no legible
// name gives up the name rather than guessing at it, because a wrong value a
// guest has to notice and correct is worse than an empty box.
function fieldsFromText(found) {
  const identity = found.identity?.text || '';
  const number = found.number?.text || '';
  const address = found.address?.text || '';

  const gender = GENDERS.find(([re]) => re.test(identity));
  return {
    fullName: nameFrom(identity),
    dob: dobFrom(identity),
    gender: gender ? gender[1] : '',
    idNumber: maskedNumberFrom(`${number} ${identity}`),
    address: addressFrom(address),
  };
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

// The entry point the scan route uses: read the card, turn it into form fields,
// and say nothing at all unless something usable came out. Returns null rather
// than an object of empty strings, so a caller can treat "OCR found nothing"
// and "OCR was never attempted" the same way.
async function readAadhaarFields(buffer) {
  const result = await tryReadCardText(buffer);
  if (!result) return null;

  const fields = fieldsFromText(result.found);
  const populated = Object.entries(fields).filter(([, v]) => v);
  if (populated.length === 0) return null;

  return {
    fields,
    // Which fields were filled, and how confident the region each came from was.
    // Logged rather than shown: it is how the region geometry gets checked
    // against real cards instead of the one it was derived from.
    diagnostics: {
      decoder: 'ocr',
      filled: populated.map(([k]) => k),
      ...result.timings,
      confidence: Object.fromEntries(
        Object.entries(result.found).map(([k, v]) => [k, v.confidence])
      ),
    },
  };
}

module.exports = {
  readAadhaarFields,
  tryReadCardText,
  readCardText,
  fieldsFromText,
  isValidAadhaar,
  REGIONS,
};
