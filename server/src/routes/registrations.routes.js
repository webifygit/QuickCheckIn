const express = require('express');
const { requireStaffAuth } = require('../middleware/auth.middleware');
const { submitLimiter, staffLimiter } = require('../middleware/rateLimit.middleware');
const {
  create,
  list,
  getOne,
  update,
  getDocument,
} = require('../controllers/registrations.controller');

const router = express.Router();

// Public: the guest form posts here, on the public per-IP budget. Everything
// else is staff-only and metered per account - see rateLimit.middleware.
router.post('/', submitLimiter, create);

const staffOnly = [requireStaffAuth, staffLimiter];

router.get('/', staffOnly, list);
router.get('/:id', staffOnly, getOne);
router.patch('/:id', staffOnly, update);

// The only route that returns an uploaded ID image, and it requires a staff token.
router.get('/:id/document', staffOnly, getDocument);

module.exports = router;
