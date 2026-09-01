import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSecureQr } from '../../server/tests/helpers/secureQr.js';

const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
const QRCode = requireFromServer('qrcode');

export const CARD = {
  referenceId: '567820190301103055123',
  name: 'Priya Sunil Deshmukh',
  dob: '02-11-1993',
  gender: 'F',
  careOf: 'D/O Sunil Deshmukh',
  district: 'Pune',
  landmark: 'Near City Hospital',
  house: '18B',
  location: 'Baner',
  pincode: '411045',
  postOffice: 'Baner',
  state: 'Maharashtra',
  street: 'Baner Road',
  subDistrict: 'Haveli',
  vtc: 'Pune City',
};

// The exact values the app should show once the card has been read.
export const EXPECTED = {
  fullName: 'Priya Sunil Deshmukh',
  dob: '02/11/1993',
  gender: 'FEMALE',
  maskedId: 'XXXX XXXX 5678',
};

// Writes a real scannable Aadhaar-style QR image for the upload step.
export async function writeAadhaarCardImage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-aadhaar-'));
  const file = path.join(dir, 'aadhaar-card.png');
  await QRCode.toFile(file, [{ data: buildSecureQr(CARD), mode: 'byte' }], {
    scale: 6,
    margin: 4,
  });
  return file;
}
