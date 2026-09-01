const prisma = require('../prismaClient');

const PUBLIC_FIELDS = [
  'fullName', 'dob', 'gender', 'nationality', 'idType', 'idNumber', 'address',
  'phone', 'email', 'checkInDate', 'checkOutDate', 'purposeOfVisit',
  'vehicleNumber', 'numberOfGuests', 'idDocumentImagePath', 'consentGiven',
];

const DATE_FIELDS = ['checkInDate', 'checkOutDate'];

function pick(obj, keys) {
  const out = {};
  for (const key of keys) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

// The form posts every field it has, so optional dates and counts arrive as
// empty strings. Prisma rejects those, so clear them out before they get there.
// Returns an error message if a supplied value is unusable.
function coerceTypes(data) {
  for (const field of DATE_FIELDS) {
    if (!(field in data)) continue;
    if (data[field] === '' || data[field] === null) {
      data[field] = null;
      continue;
    }
    const parsed = new Date(data[field]);
    if (Number.isNaN(parsed.getTime())) return `Invalid ${field}`;
    data[field] = parsed;
  }

  if ('numberOfGuests' in data) {
    if (data.numberOfGuests === '' || data.numberOfGuests === null) {
      delete data.numberOfGuests;
    } else {
      const count = Number(data.numberOfGuests);
      if (!Number.isInteger(count) || count < 1) return 'Invalid numberOfGuests';
      data.numberOfGuests = count;
    }
  }

  return null;
}

async function create(req, res) {
  const data = pick(req.body, PUBLIC_FIELDS);

  if (!data.fullName || !data.phone) {
    return res.status(400).json({ error: 'fullName and phone are required' });
  }
  if (!data.consentGiven) {
    return res.status(400).json({ error: 'Guest consent is required' });
  }

  const typeError = coerceTypes(data);
  if (typeError) return res.status(400).json({ error: typeError });

  const registration = await prisma.registration.create({ data });
  res.status(201).json(registration);
}

async function list(req, res) {
  const { status } = req.query;
  const registrations = await prisma.registration.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: 'desc' },
  });
  res.json(registrations);
}

async function getOne(req, res) {
  const registration = await prisma.registration.findUnique({ where: { id: req.params.id } });
  if (!registration) return res.status(404).json({ error: 'Not found' });
  res.json(registration);
}

const EDITABLE_FIELDS = [...PUBLIC_FIELDS, 'status'];

async function update(req, res, next) {
  const data = pick(req.body, EDITABLE_FIELDS);

  const typeError = coerceTypes(data);
  if (typeError) return res.status(400).json({ error: typeError });

  if (data.status) data.reviewedByStaffId = req.staff.staffId;

  try {
    const registration = await prisma.registration.update({
      where: { id: req.params.id },
      data,
    });
    res.json(registration);
  } catch (err) {
    // P2025 is Prisma's "record to update not found". Anything else is a real
    // failure and should not be disguised as a 404.
    if (err.code === 'P2025') return res.status(404).json({ error: 'Not found' });
    return next(err);
  }
}

module.exports = { create, list, getOne, update };
