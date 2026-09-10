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
// The two sides carry different fields, so they are read by separate
// extractors: the front for name, date of birth, gender and number, the back for
// address and number. Every photo goes through the same pipeline whether it
// came from the gallery or the camera.
//
// Measured on Vercel before it was trusted with anything: 2.4s warm, 3.8s cold,
// no timeouts. The traineddata is bundled rather than fetched and the cache
// points at /tmp, because the alternatives are a 5MB download per cold start and
// a read-only filesystem.
//
// Every field is gated on structure rather than on tesseract's confidence,
// which cannot be trusted: an empty string routinely comes back at 95. A field
// that does not survive its validator is returned blank, never guessed at.

// Written out as a literal path so the serverless file tracer can see it.
const TESSDATA_DIR = path.join(__dirname, '..', '..', 'tessdata');

// The only writable directory a serverless function has.
const CACHE_DIR = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME ? '/tmp' : TESSDATA_DIR;

// Text has to be tall enough for tesseract, so regions are cropped small and
// enlarged hard rather than the whole card enlarged at once.
const ROI_TARGET_WIDTH = 2400;

// Where each field sits as a fraction of the card itself, not of the photo.
// Aadhaar's layout is fixed, so once the card's edges are known these hold
// wherever it sits in frame. Derived from one real card so far - the weakest part
// of this, and the reason each region's confidence is logged.
//
// The number is printed in the same place on both sides, so both extractors
// read it, and a photo is only ever read for it once.
const NUMBER_REGION = { x: 0.1, y: 0.55, w: 0.85, h: 0.3, psm: PSM.SINGLE_COLUMN };

const FRONT_REGIONS = {
  // Name, date of birth and gender, printed as a block beside the photograph.
  identity: { x: 0.3, y: 0.18, w: 0.46, h: 0.36, psm: PSM.SINGLE_COLUMN },
  number: NUMBER_REGION,
};

const BACK_REGIONS = {
  address: { x: 0, y: 0.15, w: 0.62, h: 0.7, psm: PSM.SINGLE_BLOCK },
  number: NUMBER_REGION,
};

let workerPromise = null;

// One worker for the life of the process, so a warm invocation pays nothing.
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

async function prepareCard(buffer) {
  const image = await Jimp.read(buffer);
  const { width: W, height: H } = image.bitmap;
  const box = findCard(image);
  return image
    .crop(
      Math.round(box.x0 * W),
      Math.round(box.y0 * H),
      Math.max(1, Math.round((box.x1 - box.x0) * W)),
      Math.max(1, Math.round((box.y1 - box.y0) * H))
    )
    .greyscale();
}

// Reads the given regions off an already-prepared card into `found`. Regions
// already read are skipped, so trying the other side does not re-read the number.
async function readRegions(worker, card, regions, found, timings) {
  for (const [name, region] of Object.entries(regions)) {
    if (found[name]) continue;
    const at = Date.now();
    try {
      await worker.setParameters({ tessedit_pageseg_mode: region.psm });
      const { data } = await worker.recognize(await cropRegion(card, region).getBufferAsync('image/png'));
      // Line breaks are kept: the address's structure survives only in them.
      found[name] = { text: data.text.trim(), confidence: Math.round(data.confidence) };
    } catch (err) {
      found[name] = { text: '', confidence: 0, error: err.message };
    }
    timings[`${name}Ms`] = Date.now() - at;
  }
}

// Aadhaar numbers carry a Verhoeff check digit, and here that is not a nicety.
// A card prints two long numbers next to each other - the Aadhaar and the VID -
// and OCR picks whichever it likes: every preprocessed read of one real card
// returned the VID's digits. The checksum is what tells them apart.
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
  digits
    .split('')
    .reverse()
    .map(Number)
    .forEach((digit, i) => {
      c = VERHOEFF_D[c][VERHOEFF_P[i % 8][digit]];
    });
  return c === 0;
}

// Only ever the last four leave this function. The full number is read to be
// checksummed and then dropped - the guarantee that it is never stored should
// not depend on a later step remembering to mask it.
function maskedNumberFrom(text) {
  const candidates = (text.replace(/[^\d\s]/g, ' ').match(/\b\d{4}\s?\d{4}\s?\d{4}\b/g) || []).map((m) =>
    m.replace(/\s/g, '')
  );
  const valid = candidates.find(isValidAadhaar);
  return valid ? `XXXX XXXX ${valid.slice(-4)}` : '';
}

const GENDERS = [
  [/\bFEMALE\b/i, 'FEMALE'],
  [/\bTRANSGENDER\b/i, 'TRANSGENDER'],
  // Last, and only after FEMALE has had its turn - it contains MALE.
  [/\bMALE\b/i, 'MALE'],
];

const DATE = /\b(\d{2})\s*[/.-]\s*(\d{2})\s*[/.-]\s*(\d{4})\b/;

// Cards print an issue or download date too, and taking the first date found
// silently makes a guest's birthday the day their card was printed.
const OTHER_DATE_LINE = /issue|download|print/i;

function dobLineIndex(lines) {
  return lines.findIndex((line) => DATE.test(line) && !OTHER_DATE_LINE.test(line));
}

function dobFrom(lines) {
  const index = dobLineIndex(lines);
  if (index < 0) return '';
  const [, day, month, year] = lines[index].match(DATE);
  if (Number(year) < 1900 || Number(year) > new Date().getFullYear()) return '';
  if (Number(day) < 1 || Number(day) > 31 || Number(month) < 1 || Number(month) > 12) return '';
  return `${day}/${month}/${year}`;
}

// Aadhaar prints the name directly above the date of birth, so position is what
// finds it. There is deliberately no list of surnames to skip: Kumar, Singh, Devi
// and Memon are among the commonest names in the country, and any such list
// silently blanks the name for the guests who carry them.
const NOT_A_NAME =
  /\b(DOB|VID|UID|Aadhaar|Government|India|Authority|Unique|Identification|Male|Female|Transgender|Issue|Date|Download)\b/i;

// Specks at the edge of a crop come through as one- or two-letter words; no real
// name part is that short.
function trimSpecks(line) {
  return line
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 2)
    .join(' ');
}

function looksLikeName(line) {
  const words = line.trim().split(/\s+/);
  return (
    words.length >= 2 &&
    words.length <= 5 &&
    /^[A-Za-z][A-Za-z.\s]+$/.test(line.trim()) &&
    !NOT_A_NAME.test(line) &&
    !DATE.test(line)
  );
}

function nameFrom(lines) {
  const index = dobLineIndex(lines);

  // Walk up from the date of birth; anything further than a few lines is the
  // header, so stop rather than climb.
  for (let i = index - 1; i >= 0 && i >= index - 3; i -= 1) {
    const line = trimSpecks(lines[i].replace(/^(name|नाम|નામ)\s*[:.]?\s*/i, ''));
    if (looksLikeName(line)) return line;
  }

  // No usable date to anchor on: fall back to name-shaped words, which is weaker
  // but beats returning nothing.
  const beforeDate = (index < 0 ? lines : lines.slice(0, index)).join(' ');
  const titled = (beforeDate.match(/\b[A-Z][a-z]{2,}\b/g) || []).filter((w) => !NOT_A_NAME.test(w));
  return titled.length >= 2 ? titled.slice(-4).join(' ') : '';
}

// Every card prints the address twice, once in the local script, and tesseract
// renders that pass as convincing nonsense - so the address starts at the English
// block's care-of line, matched loosely in case the crop clips its first letter.
const CARE_OF = /(?:^|\s)[CSWDcswd]?\s*\/\s*[Oo]\b/;
const PINCODE = /\b[1-9]\d{5}\b/;

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
    .split(',')
    .map((part) =>
      part
        .trim()
        .replace(/^[^A-Za-z0-9]+/, '')
        .replace(/\s+[^A-Za-z0-9\s]+$/, '')
        // A one- or two-letter word ending a line is a speck off the border.
        // Digits stay: a house or plot number belongs there.
        .replace(/\s+[A-Za-z]{1,2}$/, '')
    )
    .filter((part) => part.length > 1);

  // Fragments past the end of the address, trimmed only from the tail: the same
  // fragment in the middle is more likely a house number than a speck.
  while (joined.length && joined[joined.length - 1].length < 3) joined.pop();

  const address = joined.join(', ').trim();

  // An address has a shape - a pincode, or several parts. Without one this is
  // noise, and a plausible wrong address is the hardest error for a guest to spot.
  const hasPincode = PINCODE.test(address);
  const parts = joined.filter((p) => p.trim().length > 2).length;
  return address.length >= 25 && (hasPincode || parts >= 4) ? address : '';
}

const linesOf = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

// FRONT EXTRACTOR - name, date of birth, gender and the masked number.
function frontFieldsFrom(found) {
  const identity = found.identity?.text || '';
  const lines = linesOf(identity);
  const gender = GENDERS.find(([re]) => re.test(identity));
  return {
    fullName: nameFrom(lines),
    dob: dobFrom(lines),
    gender: gender ? gender[1] : '',
    idNumber: maskedNumberFrom(`${found.number?.text || ''} ${identity}`),
  };
}

// BACK EXTRACTOR - the address with its pincode, and the masked number.
function backFieldsFrom(found) {
  const text = found.address?.text || '';
  let address = addressFrom(text);

  // The pincode sits on the block's last line, which the address's tail trimming
  // or the region's edge can lose. Put it back - but only one printed after the
  // care-of line, so a digit run in the local-script copy above cannot stand in.
  if (address && !PINCODE.test(address)) {
    const careOf = text.search(CARE_OF);
    const pincode = (careOf >= 0 ? text.slice(careOf) : '').match(PINCODE);
    if (pincode) address = `${address}, ${pincode[0]}`;
  }

  return {
    address,
    idNumber: maskedNumberFrom(`${found.number?.text || ''} ${text}`),
  };
}

const EXTRACTORS = {
  front: { regions: FRONT_REGIONS, fieldsFrom: frontFieldsFrom },
  back: { regions: BACK_REGIONS, fieldsFrom: backFieldsFrom },
};
const OTHER_SIDE = { front: 'back', back: 'front' };

// How many fields that only the given side carries were found. The number is on
// both sides, so it proves nothing about which one a photo is.
function evidenceFor(side, fields) {
  if (!fields) return 0;
  return side === 'front' ? ['fullName', 'dob', 'gender'].filter((k) => fields[k]).length : fields.address ? 1 : 0;
}

// Which side a photo was, from what each extractor found on it. The slot the
// guest used wins, unless it produced nothing that side carries and the other
// side's extractor did - a back photo in the front slot, which is exactly what
// left a real guest with nothing but their number.
function chooseSide(hint, front, back) {
  const f = evidenceFor('front', front);
  const b = evidenceFor('back', back);
  if (hint && OTHER_SIDE[hint]) {
    const own = hint === 'front' ? f : b;
    const other = hint === 'front' ? b : f;
    return own === 0 && other > 0 ? OTHER_SIDE[hint] : hint;
  }
  if (f === 0 && b === 0) return null;
  return f >= b ? 'front' : 'back';
}

async function extractCard(buffer, sideHint) {
  const startedAt = Date.now();
  const timings = {};

  const worker = await getWorker();
  timings.workerMs = Date.now() - startedAt;

  const prepareAt = Date.now();
  const card = await prepareCard(buffer);
  timings.prepareMs = Date.now() - prepareAt;

  const found = {};
  const results = {};
  const order = OTHER_SIDE[sideHint] ? [sideHint, OTHER_SIDE[sideHint]] : ['front', 'back'];

  for (const side of order) {
    await readRegions(worker, card, EXTRACTORS[side].regions, found, timings);
    results[side] = EXTRACTORS[side].fieldsFrom(found);
    // A photo in the right slot proves its side on the first pass and pays for
    // one side only; the other side is read only when the first found nothing.
    if (evidenceFor(side, results[side]) > 0) break;
  }

  const side = chooseSide(sideHint, results.front, results.back);
  const fields = side ? results[side] : { idNumber: (results.front || results.back).idNumber };

  timings.totalMs = Date.now() - startedAt;
  return { side, fields, found, timings };
}

// A hang is the failure to defend against, not a slow read: when tesseract's
// core wasm was missing from a deployment, the worker died without rejecting and
// every request sat until the platform's 60s ceiling. A card reads in about two
// seconds, so this budget only ever fires on that kind of fault.
const OCR_BUDGET_MS = 10_000;

// The entry point the scan route uses. Returns null rather than empty fields, so
// "found nothing" and "never ran" are handled alike, and never throws - a guest
// already being asked to type their details must not also meet a 500.
async function readAadhaarCard(buffer, sideHint = null) {
  let timer;
  let result;
  try {
    result = await Promise.race([
      extractCard(buffer, sideHint),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`OCR exceeded ${OCR_BUDGET_MS}ms`)), OCR_BUDGET_MS);
      }),
    ]);
  } catch (err) {
    logger.warn({ err: err.message }, 'OCR fallback failed');
    // A worker that timed out is not reusable.
    workerPromise = null;
    return null;
  } finally {
    clearTimeout(timer);
  }

  const populated = Object.entries(result.fields).filter(([, v]) => v);
  if (populated.length === 0) return null;

  return {
    side: result.side,
    fields: result.fields,
    // Logged rather than shown - never the values, which are the guest's name and
    // address - so the region geometry can be checked against real cards.
    diagnostics: {
      decoder: 'ocr',
      sideHint,
      side: result.side,
      filled: populated.map(([k]) => k),
      ...result.timings,
      confidence: Object.fromEntries(Object.entries(result.found).map(([k, v]) => [k, v.confidence])),
    },
  };
}

module.exports = {
  readAadhaarCard,
  frontFieldsFrom,
  backFieldsFrom,
  chooseSide,
  isValidAadhaar,
  FRONT_REGIONS,
  BACK_REGIONS,
};
