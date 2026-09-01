const zlib = require('zlib');
const Jimp = require('jimp');
const jsQR = require('jsqr');

// Aadhaar cards carry a QR code with the holder's demographic details.
// Two formats exist in the wild:
//   - Secure QR (2018+): a huge decimal integer -> bytes -> gzip -> 0xFF-delimited fields
//   - Legacy QR (pre-2018): a plain XML string (<PrintLetterBarcodeData .../>)
// Decoding happens entirely on our server, so the ID image is never sent anywhere.

async function decodeQrFromImage(imagePath) {
  const image = await Jimp.read(imagePath);

  // Aadhaar's secure QR is dense, so a single pass on a phone photo often fails.
  // Try progressively cleaned-up variants until one decodes.
  const variants = [
    (img) => img,
    (img) => img.clone().greyscale().contrast(0.3),
    (img) => img.clone().greyscale().normalize(),
    (img) => img.clone().greyscale().contrast(0.5).scale(2),
    (img) => img.clone().greyscale().scale(0.5),
  ];

  for (const makeVariant of variants) {
    let candidate;
    try {
      candidate = makeVariant(image);
    } catch (err) {
      continue;
    }

    const { data, width, height } = candidate.bitmap;
    const result = jsQR(new Uint8ClampedArray(data), width, height);
    if (result && result.data) {
      return result.data;
    }
  }

  return null;
}

function bigIntStringToBuffer(value) {
  let hex = BigInt(value).toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  return Buffer.from(hex, 'hex');
}

// Secure QR field order after the version/indicator prefix.
const SECURE_QR_FIELDS = [
  'referenceId', 'name', 'dob', 'gender', 'careOf', 'district', 'landmark',
  'house', 'location', 'pincode', 'postOffice', 'state', 'street',
  'subDistrict', 'vtc',
];

function parseSecureQr(qrString) {
  const compressed = bigIntStringToBuffer(qrString);
  const decompressed = zlib.gunzipSync(compressed);

  // Fields are delimited by byte 0xFF. Everything past the text fields is
  // the photo/signature blob, which we ignore.
  const parts = [];
  let start = 0;
  for (let i = 0; i < decompressed.length && parts.length <= SECURE_QR_FIELDS.length + 1; i += 1) {
    if (decompressed[i] === 0xff) {
      parts.push(decompressed.slice(start, i).toString('utf8'));
      start = i + 1;
    }
  }

  // Some cards prefix a version token ("V2"/"V3"); others start with the
  // email/mobile indicator digit. Either way, the first token is not a field.
  let cursor = 0;
  if (/^V\d+$/i.test(parts[0])) cursor = 2;
  else cursor = 1;

  const raw = {};
  SECURE_QR_FIELDS.forEach((field, index) => {
    raw[field] = (parts[cursor + index] || '').trim();
  });

  return raw;
}

function parseLegacyXmlQr(qrString) {
  const raw = {};
  const attrRe = /(\w+)="([^"]*)"/g;
  let match;
  while ((match = attrRe.exec(qrString)) !== null) {
    raw[match[1]] = match[2];
  }
  return raw;
}

function buildAddress(raw) {
  return [
    raw.careOf || raw.co,
    raw.house,
    raw.street,
    raw.landmark || raw.lm,
    raw.location || raw.loc,
    raw.vtc,
    raw.postOffice || raw.po,
    raw.subDistrict || raw.subdist,
    raw.district || raw.dist,
    raw.state,
    raw.pincode || raw.pc,
  ]
    .map((part) => (part || '').trim())
    .filter(Boolean)
    .join(', ');
}

const GENDER_MAP = { M: 'MALE', F: 'FEMALE', T: 'TRANSGENDER' };

function normalizeGender(value) {
  if (!value) return '';
  const key = value.trim().toUpperCase();
  return GENDER_MAP[key] || (['MALE', 'FEMALE', 'TRANSGENDER'].includes(key) ? key : '');
}

function normalizeDob(raw) {
  const value = (raw.dob || '').trim();
  if (value) return value.replace(/-/g, '/');
  // Legacy cards sometimes carry only a year of birth.
  if (raw.yob) return `01/01/${raw.yob}`;
  return '';
}

// We deliberately keep only the last 4 digits. Private entities in India are
// generally not permitted to store full Aadhaar numbers, and the secure QR
// only exposes the last 4 anyway (inside referenceId).
function maskedAadhaar(raw) {
  const fromReference = (raw.referenceId || '').slice(0, 4);
  const fromUid = (raw.uid || '').slice(-4);
  const lastFour = /^\d{4}$/.test(fromReference) ? fromReference : fromUid;
  return /^\d{4}$/.test(lastFour) ? `XXXX XXXX ${lastFour}` : '';
}

function parseAadhaarQr(qrString) {
  const trimmed = (qrString || '').trim();
  if (!trimmed) return null;

  const raw = /^\d+$/.test(trimmed) ? parseSecureQr(trimmed) : parseLegacyXmlQr(trimmed);

  return {
    fullName: (raw.name || '').trim(),
    dob: normalizeDob(raw),
    gender: normalizeGender(raw.gender),
    idNumber: maskedAadhaar(raw),
    address: buildAddress(raw),
  };
}

module.exports = { decodeQrFromImage, parseAadhaarQr, parseSecureQr, parseLegacyXmlQr };
