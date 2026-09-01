const prisma = require('../prismaClient');
const { storage } = require('../lib/storage');
const logger = require('../lib/logger');
const {
  createRegistrationSchema,
  buildUpdateSchema,
  listQuerySchema,
  formatZodError,
  stripUndefined,
} = require('../lib/validation');

// The stored document key is an internal detail. Leaking it would let anyone
// holding it request the image, so it never crosses the API boundary - the
// client asks for /:id/document instead and gets the bytes through staff auth.
function toPublicRegistration(registration) {
  const { idDocumentKey, ...rest } = registration;
  return { ...rest, hasIdDocument: Boolean(idDocumentKey) };
}

// Statuses at which the guest's ID image has served its purpose. Keeping the
// image past this point is the single largest piece of risk in the system, so
// it goes as soon as a human has confirmed the details.
const PURGE_AT_STATUSES = new Set(['APPROVED', 'CHECKED_IN', 'REJECTED']);

async function create(req, res) {
  const parsed = createRegistrationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(formatZodError(parsed.error));
  }

  const registration = await prisma.registration.create({ data: stripUndefined(parsed.data) });
  logger.info({ registrationId: registration.id }, 'Registration submitted');
  res.status(201).json(toPublicRegistration(registration));
}

async function list(req, res) {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json(formatZodError(parsed.error));
  }

  const { status, search, take, skip } = parsed.data;

  const where = {};
  if (status) where.status = status;
  if (search) {
    where.OR = [
      { fullName: { contains: search, mode: 'insensitive' } },
      { phone: { contains: search } },
      { email: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [registrations, total] = await Promise.all([
    prisma.registration.findMany({ where, orderBy: { createdAt: 'desc' }, take, skip }),
    prisma.registration.count({ where }),
  ]);

  res.json({ registrations: registrations.map(toPublicRegistration), total, take, skip });
}

async function getOne(req, res) {
  const registration = await prisma.registration.findUnique({ where: { id: req.params.id } });
  if (!registration) return res.status(404).json({ error: 'Not found' });
  res.json(toPublicRegistration(registration));
}

async function update(req, res, next) {
  const existing = await prisma.registration.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const parsed = buildUpdateSchema(existing).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(formatZodError(parsed.error));
  }

  const data = stripUndefined(parsed.data);

  // The reviewer is always taken from the verified token, never from the body.
  if (data.status && data.status !== existing.status) {
    data.reviewedByStaffId = req.staff.staffId;
    data.reviewedAt = new Date();
  }

  // Purge the ID image on the review decision, and record when. Done before the
  // write so a storage failure cannot leave the row claiming a deleted image
  // that is in fact still sitting in the bucket.
  const shouldPurge =
    data.status && PURGE_AT_STATUSES.has(data.status) && existing.idDocumentKey;

  if (shouldPurge) {
    try {
      await storage.remove(existing.idDocumentKey);
      data.idDocumentKey = null;
      data.idDocumentDeletedAt = new Date();
      logger.info({ registrationId: existing.id }, 'ID document purged after review');
    } catch (err) {
      logger.error({ err: err.message, registrationId: existing.id }, 'ID document purge failed');
      return res.status(502).json({
        error: 'Could not remove the stored ID image, so the status was left unchanged. Please retry.',
      });
    }
  }

  try {
    const registration = await prisma.registration.update({ where: { id: req.params.id }, data });
    res.json(toPublicRegistration(registration));
  } catch (err) {
    // P2025 is Prisma's "record to update not found". Anything else is a real
    // failure and should not be disguised as a 404.
    if (err.code === 'P2025') return res.status(404).json({ error: 'Not found' });
    return next(err);
  }
}

// Streams the ID image to signed-in staff. This is the only way to read one:
// there is no static path and no public URL.
async function getDocument(req, res) {
  const registration = await prisma.registration.findUnique({ where: { id: req.params.id } });
  if (!registration) return res.status(404).json({ error: 'Not found' });

  if (!registration.idDocumentKey) {
    return res.status(404).json({
      error: registration.idDocumentDeletedAt
        ? 'The ID image was deleted after this registration was reviewed.'
        : 'No ID document was uploaded.',
    });
  }

  const buffer = await storage.read(registration.idDocumentKey);
  if (!buffer) {
    logger.warn({ registrationId: registration.id }, 'Document key present but object missing');
    return res.status(404).json({ error: 'The stored ID image could not be found.' });
  }

  const extension = registration.idDocumentKey.split('.').pop();
  const contentType =
    { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[extension] || 'application/octet-stream';

  res.set({
    'Content-Type': contentType,
    // Personal ID data must not be cached by proxies or written to disk caches.
    'Cache-Control': 'no-store, private',
    'Content-Disposition': 'inline',
    'X-Content-Type-Options': 'nosniff',
  });
  res.send(buffer);
}

module.exports = { create, list, getOne, update, getDocument };
