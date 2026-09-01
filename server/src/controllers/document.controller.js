const { decodeQrFromImage, parseAadhaarQr } = require('../services/aadhaarQr.service');
const { detectImageMime } = require('../middleware/upload.middleware');
const { storage } = require('../lib/storage');
const logger = require('../lib/logger');

const CANNOT_READ_MESSAGE =
  "Couldn't read the QR code on this image. Make sure the whole card is visible, well lit, and in focus — or just fill the form in yourself.";

const NOT_AADHAAR_MESSAGE =
  "We found a QR code but couldn't read Aadhaar details from it. Please fill the form in yourself.";

// A failed scan is never an error condition. The guest can always type their
// details in, so every path below returns 200 with whatever we managed to read.
async function scan(req, res) {
  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded' });
  }

  // The browser's Content-Type is unverified. Trust the bytes instead, so a
  // renamed PDF or a script cannot be stored as though it were a photo.
  const detectedMime = detectImageMime(req.file.buffer);
  if (!detectedMime) {
    return res.status(400).json({ error: 'That file is not a JPEG, PNG or WEBP image.' });
  }

  const documentKey = await storage.save(req.file.buffer, detectedMime);

  let qrString = null;
  try {
    qrString = await decodeQrFromImage(req.file.buffer);
  } catch (err) {
    // Corrupt or hostile image data. The upload is still kept - staff can look
    // at the photo even when the QR is unreadable.
    logger.warn({ err: err.message, documentKey }, 'QR decode failed');
  }

  if (!qrString) {
    return res.json({ documentKey, fields: null, message: CANNOT_READ_MESSAGE });
  }

  let fields = null;
  try {
    fields = parseAadhaarQr(qrString);
  } catch (err) {
    logger.warn({ err: err.message, documentKey }, 'Aadhaar QR parse failed');
  }

  if (!fields || !fields.fullName) {
    return res.json({ documentKey, fields: null, message: NOT_AADHAAR_MESSAGE });
  }

  return res.json({ documentKey, fields });
}

module.exports = { scan };
