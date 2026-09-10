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
// Measured on a guest's own card, which is why this no longer asks for a better
// photo. On a small cut-out Aadhaar card the finder squares photograph perfectly
// sharp while the data squares are merged into blobs - roughly six pixels per
// module, well above any decoder's floor, and still unreadable. The symbol packs
// ~137 modules into about 2.5cm, so each is around 0.18mm, and consumer printing
// bleeds them together. The grid is destroyed on the card, before a camera is
// involved: run lengths across it come out uniformly random instead of clustered
// at a module width.
//
// So the advice is a different card, not a different photograph. Telling this
// guest to hold it closer sends them round a loop that cannot terminate.
const NO_QR_MESSAGE =
  "We couldn't read an Aadhaar QR code on this image. If this is a small cut-out card, that is usually the card rather than your photo — the code packs a lot of detail into about 2.5cm, and home or shop printing blurs the squares together, which no camera can recover. Your full A4 Aadhaar letter carries the same code printed much larger and normally reads. If this is a PAN card, passport, licence or voter ID, there is no Aadhaar code on it to read. Either way your photo has been saved for the front desk — please fill in the details below.";

// Said when the QR could not be read but the printed text could.
//
// It leads with what worked. The first version opened on the QR having failed,
// which is true and was the wrong thing to say first: a guest whose details have
// all just filled in correctly reads a caution about a failure as "this is
// broken", and goes looking for the problem. What they actually need to know is
// that the details came from ink rather than from the signed code, so they are
// worth a second look - a request, not an apology.
const OCR_MESSAGE =
  "We've filled in your details by reading the printed text on your card, because its QR code couldn't be read. Please check each one before you submit — reading print is less exact than the code, so small mistakes are possible.";

const NOT_AADHAAR_MESSAGE =
  "We found a QR code, but not an Aadhaar one, so there was nothing to fill in from it. Your photo has been saved for the front desk — please fill in the details below.";

// The client may have read the QR itself, off a live camera, and send its text
// alongside the photo (see client/src/components/QrCamera.jsx). Two things are
// worth being clear about.
//
// Trust: this text is guest-supplied, and so is every field on the form the
// guest types by hand. Accepting it grants no capability that typing did not
// already grant. What must not move is the parsing - parseAadhaarQr is where
// the Aadhaar number is reduced to its last four digits, and running it here
// keeps that guarantee out of reach of the browser. The client sends QR text,
// never fields.
//
// Size: a QR's text is the one input a caller controls the length of, and the
// parser's cost is superlinear in it. Bounded by multer's fieldSize, and again
// here, so an implausible value is ignored rather than parsed.
const MAX_CLIENT_QR_CHARS = 8_000;

function clientQrText(req) {
  const value = req.body?.qrText;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_CLIENT_QR_CHARS ? trimmed : null;
}

// Reads the printed text off a card whose QR could not be decoded.
//
// This is the last thing tried, and it is a guess where the QR is a fact: the
// QR's payload is signed by UIDAI, while this is tesseract's opinion of some
// ink. Guests are told as much, and the front desk still checks it. Fields that
// did not come out cleanly are left empty rather than filled with something
// plausible, because a wrong value the guest has to notice is worse than a
// blank one they simply complete.
//
// Required lazily. tesseract pulls in a worker and a 5MB model, and a guest
// whose QR read on the first pass should not pay to load either.
async function readPrintedFields(buffer, documentKey) {
  try {
    const { readAadhaarFields } = require('../services/aadhaarOcr.service');
    const result = await readAadhaarFields(buffer);
    if (!result) {
      logger.info({ documentKey }, 'OCR found nothing usable');
      return null;
    }
    // The values themselves are the guest's name and address and are not logged.
    // What is worth keeping is which fields a real card gave up and how sure the
    // region was - that is how the geometry gets checked against cards other
    // than the one it was derived from.
    logger.info({ documentKey, ...result.diagnostics }, 'Fields read from printed text');
    return result.fields;
  } catch (err) {
    // OCR must never be why a guest's upload fails: they can still type.
    logger.warn({ err: err.message, documentKey }, 'OCR fallback threw');
    return null;
  }
}

// The only place QR text becomes form fields, whichever device read it. Keeping
// it here is what makes the masking inside parseAadhaarQr unconditional.
function fieldsFromQr(qrString, documentKey, notAadhaarMessage) {
  let fields = null;
  try {
    fields = parseAadhaarQr(qrString);
  } catch (err) {
    logger.warn({ err: err.message, documentKey }, 'Aadhaar QR parse failed');
  }
  if (!fields || !fields.fullName) return { fields: null, message: notAadhaarMessage };
  return { fields };
}

// Said when QR text arrived without an image, so nothing was saved.
const NOT_AADHAAR_TEXT_MESSAGE =
  "That doesn't look like an Aadhaar QR code, so there was nothing to fill in. Please fill in the details below.";

// A failed scan is never an error condition. The guest can always type their
// details in, so every path below returns 200 with whatever we managed to read.
async function scan(req, res) {
  const suppliedQr = clientQrText(req);

  // QR text with no image: read from an e-Aadhaar PDF opened on the guest's own
  // phone. The PDF holds the full signed record and never leaves the device, so
  // only the text arrives - parsed and masked here like any other read, and
  // nothing is stored.
  if (!req.file) {
    if (!suppliedQr) {
      return res.status(400).json({ error: 'No image uploaded' });
    }
    logger.info({ decoder: 'client', stored: false }, 'QR text received without an image');
    return res.json({
      documentKey: null,
      ...fieldsFromQr(suppliedQr, null, NOT_AADHAAR_TEXT_MESSAGE),
    });
  }

  // The browser's Content-Type is unverified. Trust the bytes instead, so a
  // renamed PDF or a script cannot be stored as though it were a photo.
  const detectedMime = detectImageMime(req.file.buffer);
  if (!detectedMime) {
    return res.status(400).json({ error: 'That file is not a JPEG, PNG or WEBP image.' });
  }

  const documentKey = await storage.save(req.file.buffer, detectedMime);

  let qrString = suppliedQr;
  let diagnostics = qrString ? { decoder: 'client' } : null;

  // Only decode here if the client did not. A frame that already yielded a QR
  // in the browser holds nothing a second pass would find, and this is the
  // expensive half of the request - a wasm init and up to 2.5s of jsQR budget,
  // which on a serverless deployment is a cold start per guest.
  if (!qrString) {
    try {
      ({ text: qrString, diagnostics } = await decodeQrWithDiagnostics(req.file.buffer));
    } catch (err) {
      // Corrupt or hostile image data. The upload is still kept - staff can look
      // at the photo even when the QR is unreadable.
      logger.warn({ err: err.message, documentKey }, 'QR decode failed');
    }
  }

  if (!qrString) {
    // The photo itself is the guest's ID and is not something to log, but its
    // shape is exactly what is needed to tell "this is not an Aadhaar card"
    // apart from "the symbol was too small to resolve" - and without it, a
    // report of "the scan didn't work" is unanswerable.
    logger.info({ documentKey, ...(diagnostics || {}) }, 'No QR found in uploaded image');

    const printed = await readPrintedFields(req.file.buffer, documentKey);
    if (printed) {
      return res.json({ documentKey, fields: printed, source: 'ocr', message: OCR_MESSAGE });
    }

    return res.json({ documentKey, fields: null, message: NO_QR_MESSAGE });
  }

  logger.info({ documentKey, ...(diagnostics || {}) }, 'QR decoded from uploaded image');

  return res.json({ documentKey, ...fieldsFromQr(qrString, documentKey, NOT_AADHAAR_MESSAGE) });
}

module.exports = { scan };
