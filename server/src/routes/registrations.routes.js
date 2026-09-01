const express = require('express');
const { requireStaffAuth } = require('../middleware/auth.middleware');
const {
  create,
  list,
  getOne,
  update,
  getDocument,
} = require('../controllers/registrations.controller');

const router = express.Router();

// Public: the guest form posts here. Everything else is staff-only.
router.post('/', create);

router.get('/', requireStaffAuth, list);
router.get('/:id', requireStaffAuth, getOne);
router.patch('/:id', requireStaffAuth, update);

// The only route that returns an uploaded ID image, and it requires a staff token.
router.get('/:id/document', requireStaffAuth, getDocument);

module.exports = router;
