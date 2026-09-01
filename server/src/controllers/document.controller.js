const path = require('path');
const { decodeQrFromImage, parseAadhaarQr } = require('../services/aadhaarQr.service');

function relativeUploadPath(file) {
  return path.relative(path.join(__dirname, '..', '..'), file.path).replace(/\\/g, '/');
}

async function scan(req, res) {
  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded' });
  }

  const imagePath = relativeUploadPath(req.file);

  try {
    const qrString = await decodeQrFromImage(req.file.path);

    if (!qrString) {
      return res.json({
        imagePath,
        fields: null,
        message:
          "Couldn't read the QR code on this image. Make sure the whole card is visible, well lit, and in focus — or just fill the form in yourself.",
      });
    }

    const fields = parseAadhaarQr(qrString);
    if (!fields || !fields.fullName) {
      return res.json({
        imagePath,
        fields: null,
        message:
          "We found a QR code but couldn't read Aadhaar details from it. Please fill the form in yourself.",
      });
    }

    return res.json({ imagePath, fields });
  } catch (err) {
    console.error('QR scan failed:', err.message);
    return res.json({
      imagePath,
      fields: null,
      message: "Couldn't read details from this image. Please fill the form in yourself.",
    });
  }
}

module.exports = { scan };
