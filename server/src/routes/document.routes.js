const express = require('express');
const { upload } = require('../middleware/upload.middleware');
const { scan } = require('../controllers/document.controller');

const router = express.Router();

router.post('/scan', upload.single('document'), scan);

module.exports = router;
