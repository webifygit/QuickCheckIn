const express = require('express');
const { requireStaffAuth } = require('../middleware/auth.middleware');
const { create, list, getOne, update } = require('../controllers/registrations.controller');

const router = express.Router();

router.post('/', create);
router.get('/', requireStaffAuth, list);
router.get('/:id', requireStaffAuth, getOne);
router.patch('/:id', requireStaffAuth, update);

module.exports = router;
