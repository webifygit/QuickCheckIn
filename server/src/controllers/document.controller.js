const { parseAadhaarQr } = require('../services/aadhaarQr.service');
const { decodeQrWithDiagnostics } = require('../services/qrDecoder.service');
const { detectImageMime } = require('../middleware/upload.middleware');
const { storage } = require('../lib/storage');
const logger = require('../lib/logger');

// Only an Aadhaar card can auto-fill: the details come out of the QR code
// printed on it, and no other Indian ID carries one in that format. A guest who
// uploads a PAN card, a licence or a passport has done nothing wrong, so these
// messages say what actually happened instead of blaming the photo - the old
// wording sent people off to retake a picture that was never the problem.
const NO_QR_MESSAGE =
  "We couldn't read an Aadhaar QR code on this image. Aadhaar's code is a dense one: photograph it on its own, close up enough to fill the frame, with no reflection across it — a picture of the whole card usually does not carry enough detail. Sending the photo through a chat app first shrinks it, so upload the original. If this is a PAN card, passport, licence or voter ID, your photo has been saved for the front desk and you can fill in the details below.";

const NOT_AADHAAR_MESSAGE =
  "We found a QR code, but not an Aadhaar one, so there was nothing to fill in from it. Your photo has been saved for the front desk — please fill in the details below.";

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
  let diagnostics = null;
  try {
    ({ text: qrString, diagnostics } = await decodeQrWithDiagnostics(req.file.buffer));
  } catch (err) {
    // Corrupt or hostile image data. The upload is still kept - staff can look
    // at the photo even when the QR is unreadable.
    logger.warn({ err: err.message, documentKey }, 'QR decode failed');
  }

  if (!qrString) {
    // The photo itself is the guest's ID and is not something to log, but its
    // shape is exactly what is needed to tell "this is not an Aadhaar card"
    // apart from "the symbol was too small to resolve" - and without it, a
    // report of "the scan didn't work" is unanswerable.
    logger.info({ documentKey, ...(diagnostics || {}) }, 'No QR found in uploaded image');

    return res.json({ documentKey, fields: null, message: NO_QR_MESSAGE });
  }

  logger.info({ documentKey, ...(diagnostics || {}) }, 'QR decoded from uploaded image');

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
