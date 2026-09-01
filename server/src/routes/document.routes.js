const express = require('express');
const { upload, handleUploadErrors } = require('../middleware/upload.middleware');
const { scan } = require('../controllers/document.controller');

const router = express.Router();

// handleUploadErrors sits between multer and the controller so an oversized or
// wrong-typed file becomes a 413/400 with a readable message, not a 500.
router.post('/scan', upload.single('document'), handleUploadErrors, scan);

module.exports = router;
