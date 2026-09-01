import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { buildSecureQr, SAMPLE_FIELDS } from './helpers/secureQr.js';

const require = createRequire(import.meta.url);
const { parseAadhaarQr, parseSecureQr, parseLegacyXmlQr } = require('../src/services/aadhaarQr.service');

const legacyXml = (attrs) =>
  `<?xml version="1.0" encoding="UTF-8"?><PrintLetterBarcodeData ${Object.entries(attrs)
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ')}/>`;

describe('parseSecureQr', () => {
  it('reads every demographic field off a V2 card', () => {
    const raw = parseSecureQr(buildSecureQr(SAMPLE_FIELDS));

    expect(raw.name).toBe('Asha Ramesh Kulkarni');
    expect(raw.dob).toBe('14-08-1991');
    expect(raw.gender).toBe('F');
    expect(raw.referenceId).toBe('123420190301103055123');
    expect(raw.pincode).toBe('411038');
    expect(raw.vtc).toBe('Pune City');
  });

  it('reads cards that omit the version token and start with the indicator digit', () => {
    const raw = parseSecureQr(buildSecureQr(SAMPLE_FIELDS, { version: null }));

    expect(raw.name).toBe('Asha Ramesh Kulkarni');
    expect(raw.state).toBe('Maharashtra');
  });

  it('leaves fields the card did not carry as empty strings, not undefined', () => {
    const raw = parseSecureQr(buildSecureQr({ ...SAMPLE_FIELDS, landmark: '', careOf: '' }));

    expect(raw.landmark).toBe('');
    expect(raw.careOf).toBe('');
  });
});

describe('parseAadhaarQr - secure QR', () => {
  it('maps a secure QR onto the form fields', () => {
    const fields = parseAadhaarQr(buildSecureQr(SAMPLE_FIELDS));

    expect(fields.fullName).toBe('Asha Ramesh Kulkarni');
    expect(fields.dob).toBe('14/08/1991');
    expect(fields.gender).toBe('FEMALE');
    expect(fields.idNumber).toBe('XXXX XXXX 1234');
    expect(fields.address).toBe(
      'W/O Ramesh Kulkarni, Flat 402, Shanti Residency, Paud Road, Near Ganesh Mandir, ' +
        'Kothrud, Pune City, Kothrud, Haveli, Pune, Maharashtra, 411038'
    );
  });

  it('tolerates surrounding whitespace on the scanned string', () => {
    const fields = parseAadhaarQr(`  ${buildSecureQr(SAMPLE_FIELDS)}  `);
    expect(fields.fullName).toBe('Asha Ramesh Kulkarni');
  });
});

describe('parseAadhaarQr - legacy XML QR', () => {
  it('maps a legacy card onto the form fields', () => {
    const fields = parseAadhaarQr(
      legacyXml({
        uid: '123456789012',
        name: 'Ramesh Kulkarni',
        gender: 'M',
        yob: '1985',
        co: 'S/O Vasant Kulkarni',
        house: '12',
        street: 'MG Road',
        lm: 'Opp Post Office',
        loc: 'Camp',
        vtc: 'Pune',
        po: 'Camp',
        dist: 'Pune',
        state: 'Maharashtra',
        pc: '411001',
      })
    );

    expect(fields.fullName).toBe('Ramesh Kulkarni');
    expect(fields.gender).toBe('MALE');
    expect(fields.dob).toBe('01/01/1985');
    expect(fields.idNumber).toBe('XXXX XXXX 9012');
    expect(fields.address).toBe(
      'S/O Vasant Kulkarni, 12, MG Road, Opp Post Office, Camp, Pune, Camp, Pune, Maharashtra, 411001'
    );
  });

  it('prefers an explicit dob over the year of birth', () => {
    const fields = parseAadhaarQr(legacyXml({ name: 'X', dob: '02-03-1979', yob: '1979' }));
    expect(fields.dob).toBe('02/03/1979');
  });
});

describe('Aadhaar masking', () => {
  it('never exposes more than the last four digits of a legacy uid', () => {
    const uid = '123456789012';
    const fields = parseAadhaarQr(legacyXml({ uid, name: 'Ramesh Kulkarni' }));

    expect(fields.idNumber).toMatch(/^XXXX XXXX \d{4}$/);
    expect(JSON.stringify(fields)).not.toContain(uid);
    expect(JSON.stringify(fields)).not.toMatch(/\d{5,}/);
  });

  it('never leaks the secure QR reference id, which embeds a timestamp', () => {
    const fields = parseAadhaarQr(buildSecureQr(SAMPLE_FIELDS));

    expect(fields.idNumber).toBe('XXXX XXXX 1234');
    expect(JSON.stringify(fields)).not.toContain(SAMPLE_FIELDS.referenceId);
  });

  it('returns an empty id rather than a malformed mask when no digits are available', () => {
    expect(parseAadhaarQr(legacyXml({ name: 'X' })).idNumber).toBe('');
    expect(parseAadhaarQr(legacyXml({ name: 'X', uid: '12' })).idNumber).toBe('');
    expect(parseAadhaarQr(legacyXml({ name: 'X', uid: 'ABCDEFGH' })).idNumber).toBe('');
  });
});

describe('field normalisation', () => {
  it.each([
    ['M', 'MALE'],
    ['f', 'FEMALE'],
    ['T', 'TRANSGENDER'],
    ['MALE', 'MALE'],
    ['female', 'FEMALE'],
    ['  M  ', 'MALE'],
    ['X', ''],
    ['', ''],
    [undefined, ''],
  ])('normalises gender %s to %s', (input, expected) => {
    const attrs = { name: 'X' };
    if (input !== undefined) attrs.gender = input;
    expect(parseAadhaarQr(legacyXml(attrs)).gender).toBe(expected);
  });

  it('joins only the address parts the card actually carried', () => {
    const fields = parseAadhaarQr(
      legacyXml({ name: 'X', house: '12', state: 'Goa', street: '', dist: '  ' })
    );

    expect(fields.address).toBe('12, Goa');
    expect(fields.address).not.toMatch(/,\s*,/);
  });

  it('leaves the date of birth empty when the card carries neither dob nor yob', () => {
    expect(parseAadhaarQr(legacyXml({ name: 'X' })).dob).toBe('');
  });
});

describe('unreadable input', () => {
  it('returns null for an empty or whitespace-only scan', () => {
    expect(parseAadhaarQr('')).toBeNull();
    expect(parseAadhaarQr('   ')).toBeNull();
    expect(parseAadhaarQr(null)).toBeNull();
    expect(parseAadhaarQr(undefined)).toBeNull();
  });

  it('yields empty fields (not a crash) for a QR that is not an Aadhaar card', () => {
    const fields = parseAadhaarQr('https://example.com/some-other-qr');

    expect(fields.fullName).toBe('');
    expect(fields.idNumber).toBe('');
  });

  it('throws on a numeric QR that is not gzipped - callers must catch', () => {
    // Documents current behaviour: document.controller wraps this in try/catch
    // and falls back to manual entry.
    expect(() => parseAadhaarQr('12345678901234567890')).toThrow();
  });

  it('parseLegacyXmlQr pulls no attributes out of a non-XML string', () => {
    expect(parseLegacyXmlQr('not xml at all')).toEqual({});
  });
});
