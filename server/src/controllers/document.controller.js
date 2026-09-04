const { parseAadhaarQr } = require('../services/aadhaarQr.service');
const { decodeQrFromImage } = require('../services/qrDecoder.service');
const { detectImageMime } = require('../middleware/upload.middleware');
const { storage } = require('../lib/storage');
const logger = require('../lib/logger');

// Only an Aadhaar card can auto-fill: the details come out of the QR code
// printed on it, and no other Indian ID carries one in that format. A guest who
// uploads a PAN card, a licence or a passport has done nothing wrong, so these
// messages say what actually happened instead of blaming the photo - the old
// wording sent people off to retake a picture that was never the problem.
const NO_QR_MESSAGE =
  "We couldn't find an Aadhaar QR code on this image. Only Aadhaar cards fill the form in automatically — if this is a PAN card, passport, licence or voter ID, your photo has been saved for the front desk and you can fill in the details below. If it is an Aadhaar card, try again with the whole card in frame, well lit and in focus.";

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
  try {
    qrString = await decodeQrFromImage(req.file.buffer);
  } catch (err) {
    // Corrupt or hostile image data. The upload is still kept - staff can look
    // at the photo even when the QR is unreadable.
    logger.warn({ err: err.message, documentKey }, 'QR decode failed');
  }

  if (!qrString) {
    return res.json({ documentKey, fields: null, message: NO_QR_MESSAGE });
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
