const multer = require('multer');
const config = require('../config');

// Uploads are held in memory, not written to disk by multer. The buffer goes
// straight to the storage driver, so there is no window where an unreferenced
// ID image sits in a temp directory, and the same code path works whether the
// destination is a local volume or a private S3 bucket.

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// A client-supplied Content-Type is a claim, not a fact. These are the real
// signatures, checked after the bytes arrive.
const MAGIC_SIGNATURES = [
  { mime: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/png',
    test: (b) =>
      b.length > 8 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  {
    mime: 'image/webp',
    test: (b) =>
      b.length > 12 &&
      b.toString('ascii', 0, 4) === 'RIFF' &&
      b.toString('ascii', 8, 12) === 'WEBP',
  },
];

function detectImageMime(buffer) {
  return MAGIC_SIGNATURES.find((signature) => signature.test(buffer))?.mime || null;
}

const upload = multer({
  storage: multer.memoryStorage(),
  // fieldSize bounds the one text field this endpoint takes - a QR's decoded
  // text, from the client-side scanner. A real secure QR runs to a few thousand
  // digits; 16KB leaves room without letting a caller hand the parser a payload
  // whose cost is superlinear in its length.
  limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1, fields: 10, fieldSize: 16 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'document'));
    }
    cb(null, true);
  },
});

// Multer signals its own failures (oversized file, wrong field) through an error
// class. Without this they surface as a 500, which reads as "the site is broken"
// when the truth is "that photo is too big".
function handleUploadErrors(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const limitMb = Math.round(config.MAX_UPLOAD_BYTES / (1024 * 1024));
      return res.status(413).json({ error: `That image is too large. Please upload a photo under ${limitMb}MB.` });
    }
    // An oversized text field is not something a guest can cause through the
    // form, so this message is for whoever is holding the request - not for a
    // guest to act on. The default below would have blamed their photo.
    if (err.code === 'LIMIT_FIELD_VALUE') {
      return res.status(400).json({ error: 'A form field was too large to accept.' });
    }
    return res.status(400).json({ error: 'Please upload a single JPEG, PNG or WEBP image.' });
  }
  return next(err);
}

module.exports = { upload, handleUploadErrors, detectImageMime, ALLOWED_MIME_TYPES };
