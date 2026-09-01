const { z } = require('zod');

// Every field a guest or staff member can send is described here. Anything not
// named is dropped before it reaches Prisma, which is what keeps a guest from
// setting their own `status`, `id` or `reviewedByStaffId`.

const ID_TYPES = ['AADHAAR', 'PASSPORT', 'DRIVING_LICENSE', 'VOTER_ID', 'OTHER'];
const STATUSES = ['PENDING', 'APPROVED', 'CHECKED_IN', 'REJECTED'];
const GENDERS = ['MALE', 'FEMALE', 'TRANSGENDER'];

// Keys are minted by the storage layer as `<millis>-<32 hex chars><ext>`.
// Refusing anything else stops a caller from pointing a record at a path of
// their choosing.
const STORAGE_KEY_RE = /^\d{10,}-[0-9a-f]{32}\.(jpg|png|webp|bin)$/;

// The form posts every field it has, so untouched inputs arrive as empty
// strings. For a nullable column that means "clear it" - staff correcting a
// mistyped check-out date need the blank to reach the database as NULL. Mapping
// it to undefined instead would silently mean "leave it alone".
const blankToNull = (value) => (typeof value === 'string' && value.trim() === '' ? null : value);

// For columns that are NOT NULL with a default (idType, numberOfGuests) a blank
// means "no opinion" - drop the key and let the default stand.
const blankToUndefined = (value) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalText = (max) =>
  z.preprocess(blankToNull, z.string().trim().max(max).nullable().optional());

// Deliberately permissive: guests arrive with international numbers in many
// shapes. We check it could plausibly be dialled, not that it matches one country.
const phoneSchema = z
  .string()
  .trim()
  .min(1, 'Phone number is required')
  .refine((value) => /^[+]?[\d\s()-]+$/.test(value), 'Phone number contains invalid characters')
  .refine((value) => {
    const digits = value.replace(/[^\d]/g, '');
    return digits.length >= 7 && digits.length <= 15;
  }, 'Enter a valid phone number');

const dateSchema = z.preprocess(
  blankToNull,
  z
    .union([z.string(), z.date(), z.null()])
    .optional()
    .refine(
      (value) => value === undefined || value === null || !Number.isNaN(new Date(value).getTime()),
      'Enter a valid date'
    )
    .transform((value) => (value === undefined || value === null ? value : new Date(value)))
);

const guestCountSchema = z.preprocess(
  blankToUndefined,
  z.coerce
    .number({ message: 'Number of guests must be a number' })
    .int('Number of guests must be a whole number')
    .min(1, 'At least one guest is required')
    .max(20, 'Too many guests for a single registration')
    .optional()
);

const baseFields = {
  fullName: z.string().trim().min(1, 'Full name is required').max(120),
  dob: optionalText(40),
  gender: z.preprocess(blankToNull, z.enum(GENDERS).nullable().optional()),
  nationality: optionalText(60),
  idType: z.preprocess(blankToUndefined, z.enum(ID_TYPES).optional()),
  idNumber: optionalText(40),
  address: optionalText(500),
  phone: phoneSchema,
  email: z.preprocess(
    blankToNull,
    z.string().trim().email('Enter a valid email address').max(160).nullable().optional()
  ),
  checkInDate: dateSchema,
  checkOutDate: dateSchema,
  purposeOfVisit: optionalText(200),
  vehicleNumber: optionalText(30),
  numberOfGuests: guestCountSchema,
  idDocumentKey: z.preprocess(
    blankToNull,
    z.string().regex(STORAGE_KEY_RE, 'Invalid document reference').nullable().optional()
  ),
};

// A stay cannot end before it starts. Checked on create, and on update against
// whatever the record already holds - so changing only the check-out date is
// still validated against the stored check-in date.
function checkDateOrder(data, ctx, existing = {}) {
  const checkIn = data.checkInDate !== undefined ? data.checkInDate : existing.checkInDate;
  const checkOut = data.checkOutDate !== undefined ? data.checkOutDate : existing.checkOutDate;

  if (checkIn && checkOut && new Date(checkOut) < new Date(checkIn)) {
    ctx.addIssue({
      code: 'custom',
      path: ['checkOutDate'],
      message: 'Check-out date cannot be before check-in date',
    });
  }
}

const createRegistrationSchema = z
  .object({
    ...baseFields,
    consentGiven: z.literal(true, { message: 'Guest consent is required to submit this form' }),
  })
  .superRefine((data, ctx) => checkDateOrder(data, ctx));

// Staff may additionally move a registration through the review flow. Every
// other field stays editable so they can correct a mis-scanned detail.
function buildUpdateSchema(existing = {}) {
  const optionalBase = Object.fromEntries(
    Object.entries(baseFields).map(([key, schema]) => [key, schema.optional()])
  );

  return z
    .object({
      ...optionalBase,
      fullName: z.string().trim().min(1, 'Full name is required').max(120).optional(),
      phone: phoneSchema.optional(),
      status: z.enum(STATUSES, { message: 'Unknown status' }).optional(),
      consentGiven: z.boolean().optional(),
    })
    .superRefine((data, ctx) => checkDateOrder(data, ctx, existing));
}

const loginSchema = z.object({
  email: z.string().trim().min(1, 'Email is required').email('Enter a valid email address').max(160),
  password: z.string().min(1, 'Password is required').max(200),
});

const listQuerySchema = z.object({
  status: z.preprocess(blankToUndefined, z.enum(STATUSES, { message: 'Unknown status' }).optional()),
  search: z.preprocess(blankToUndefined, z.string().trim().max(120).optional()),
  take: z.coerce.number().int().min(1).max(200).default(100),
  skip: z.coerce.number().int().min(0).default(0),
});

// Zod keeps keys whose value resolved to undefined. Prisma treats an explicit
// `undefined` as "no change", but the presence of the key still muddies both
// assertions and logs, so drop them.
function stripUndefined(data) {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}

// Turns a Zod failure into the shape the client renders: one summary message
// plus per-field errors the form can attach to the right input.
function formatZodError(error) {
  const fieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
  }
  return {
    error: error.issues[0]?.message || 'Invalid request',
    fieldErrors,
  };
}

module.exports = {
  createRegistrationSchema,
  buildUpdateSchema,
  loginSchema,
  listQuerySchema,
  formatZodError,
  stripUndefined,
  STATUSES,
  ID_TYPES,
  GENDERS,
  STORAGE_KEY_RE,
};
