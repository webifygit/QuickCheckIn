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

// The only routes that return an uploaded ID image, and both require a staff
// token. The bare path stays as the front, which is what every client asking
// before there was a back side meant by it.
router.get('/:id/document', staffOnly, getDocument);
router.get('/:id/document/:side', staffOnly, getDocument);

module.exports = router;
