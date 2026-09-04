import zlib from 'node:zlib';
import crypto from 'node:crypto';

// A real card's photo blob is incompressible, and its size is what pushes the
// symbol to ~137 modules - the thing that makes decoding hard. Derived from a
// hash chain rather than randomness so a fixture is byte-identical run to run.
function incompressibleBytes(length) {
  const parts = [];
  let seed = crypto.createHash('sha256').update('aadhaar-fixture').digest();
  while (parts.reduce((total, part) => total + part.length, 0) < length) {
    parts.push(seed);
    seed = crypto.createHash('sha256').update(seed).digest();
  }
  return Buffer.concat(parts).subarray(0, length);
}

// Builds a synthetic Aadhaar "secure QR" payload in the same shape real cards use:
// text fields delimited by byte 0xFF, gzipped, then encoded as one huge decimal integer.
export function buildSecureQr(
  fields,
  { version = 'V2', emailMobileIndicator = '3', photoBytes = 5 } = {}
) {
  const ordered = [
    fields.referenceId, fields.name, fields.dob, fields.gender, fields.careOf,
    fields.district, fields.landmark, fields.house, fields.location, fields.pincode,
    fields.postOffice, fields.state, fields.street, fields.subDistrict, fields.vtc,
  ].map((value) => (value === undefined ? '' : String(value)));

  const tokens = version ? [version, emailMobileIndicator] : [emailMobileIndicator];
  const chunks = [];
  for (const token of [...tokens, ...ordered]) {
    chunks.push(Buffer.from(token, 'utf8'), Buffer.from([0xff]));
  }
  // Real cards append a photo/signature blob past the text fields; the parser
  // must ignore it, so include one. Pass photoBytes to make it life-sized.
  chunks.push(photoBytes === 5 ? Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]) : incompressibleBytes(photoBytes));

  const compressed = zlib.gzipSync(Buffer.concat(chunks));
  return BigInt(`0x${compressed.toString('hex')}`).toString(10);
}

export const SAMPLE_FIELDS = {
  referenceId: '123420190301103055123',
  name: 'Asha Ramesh Kulkarni',
  dob: '14-08-1991',
  gender: 'F',
  careOf: 'W/O Ramesh Kulkarni',
  district: 'Pune',
  landmark: 'Near Ganesh Mandir',
  house: 'Flat 402, Shanti Residency',
  location: 'Kothrud',
  pincode: '411038',
  postOffice: 'Kothrud',
  state: 'Maharashtra',
  street: 'Paud Road',
  subDistrict: 'Haveli',
  vtc: 'Pune City',
};
