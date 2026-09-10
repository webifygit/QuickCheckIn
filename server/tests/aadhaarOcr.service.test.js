import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { frontFieldsFrom, backFieldsFrom, chooseSide, isValidAadhaar } = require('../src/services/aadhaarOcr.service');

// Everything here runs on text, not images: these are the rules that decide what
// a guest's form gets filled with, pinned down separately from whether tesseract
// read a card well on a given day.
const front = (identity, number = '') => frontFieldsFrom({ identity: { text: identity }, number: { text: number } });
const back = (address, number = '') => backFieldsFrom({ address: { text: address }, number: { text: number } });

describe('the Aadhaar number is checked, not just found', () => {
  // A card prints the Aadhaar and the VID side by side, and OCR takes whichever
  // it likes - every preprocessed read of one real card returned the VID.
  it('accepts a real number and rejects the VID printed beside it', () => {
    expect(isValidAadhaar('484293107966')).toBe(true);
    expect(isValidAadhaar('916337070155')).toBe(false);
  });

  it('rejects numbers that cannot be Aadhaar at all', () => {
    expect(isValidAadhaar('123456789012')).toBe(false);
    expect(isValidAadhaar('084293107966')).toBe(false);
    expect(isValidAadhaar('184293107966')).toBe(false);
    expect(isValidAadhaar('48429310796')).toBe(false);
  });

  it('never returns more of the number than the last four, from either side', () => {
    const fromFront = front('', '4842 9310 7966');
    const fromBack = back('', '4842 9310 7966');

    expect(fromFront.idNumber).toBe('XXXX XXXX 7966');
    expect(fromBack.idNumber).toBe('XXXX XXXX 7966');
    expect(JSON.stringify([fromFront, fromBack])).not.toContain('484293107966');
  });

  it('leaves the number blank when nothing valid was read', () => {
    expect(front('some text 9163 3707 0155 and more').idNumber).toBe('');
  });
});

describe('the front extractor', () => {
  it('reads the name, date of birth and gender off a real card', () => {
    // The exact text tesseract produces from the card this was built against.
    expect(front('EE Irshad Memon\n18/02/1985 yo MALE on')).toMatchObject({
      fullName: 'Irshad Memon',
      dob: '18/02/1985',
      gender: 'MALE',
    });
  });

  it('is not fooled by the issue date', () => {
    const fields = front('Issue Date: 09/04/2012\nRajesh Kumar\nDOB: 01/01/1990\nMALE');

    expect(fields.dob).toBe('01/01/1990');
    expect(fields.fullName).toBe('Rajesh Kumar');
  });

  it.each(['Rajesh Kumar', 'Manpreet Singh', 'Sunita Devi', 'Irshad Memon', 'Asha Kulkarni'])(
    'reads the name %s rather than skipping it',
    (name) => {
      expect(front(`Government of India\n${name}\nDOB: 01/01/1990\nMALE`).fullName).toBe(name);
    }
  );

  it('does not mistake the government header for a name', () => {
    expect(front('Government of India\nDOB: 01/01/1990\nMALE').fullName).toBe('');
  });

  it('reads FEMALE as FEMALE', () => {
    expect(front('Asha Kulkarni\n14/08/1991\nFEMALE').gender).toBe('FEMALE');
  });

  // A real guest's back photo put their address in the name field: with no date
  // of birth to anchor on, capitalised place names were taken for a name.
  it('does not take place names on the back of a card for a name', () => {
    expect(front('Aamena Residency Nr Shahwazuuddin\nDargah Khanpur Ahmedabad City').fullName).toBe('');
  });

  it('still falls back to name-shaped words when a gender line proves it is the front', () => {
    expect(front('Irshad Memon\nMALE').fullName).toBe('Irshad Memon');
  });

  it('returns no address - that is the back extractor\'s job', () => {
    expect(front('Irshad Memon\n18/02/1985\nMALE')).not.toHaveProperty('address');
  });
});

describe('the back extractor', () => {
  it('starts the address at the care-of line, not the top of the region', () => {
    const { address } = back(
      'noavedler ER2ME WIA VileTyR\nHME ICEL\nC/O: Mohammed Farid, 601 6th Floor\nAamena Residency, Nr Shahwazuuddin\nDargah, Khanpur, Ahmedabad City\nGujarat - 380001'
    );

    expect(address).toMatch(/^C\/O/);
    expect(address).not.toMatch(/noavedler/);
    expect(address).toContain('Aamena Residency');
    expect(address).toContain('380001');
  });

  // The pincode line is the one the region's edge tends to lose from the parsed
  // address while the raw text still has it.
  it('puts back a pincode the address lost', () => {
    const { address } = back(
      'C/O: Mohammed Farid, 601 6th Floor\nAamena Residency, Nr Shahwazuuddin\nDargah, Khanpur, Ahmedabad City\n- 380001 %'
    );

    expect(address).toMatch(/, 380001$/);
  });

  it('does not borrow a pincode from the local-script copy above the English address', () => {
    const { address } = back('ગુજરાત 380001\nC/O: Mohammed Farid, 601 6th Floor\nAamena Residency, Nr Shahwazuuddin\nDargah, Khanpur, Ahmedabad City');

    expect(address).not.toContain('380001');
  });

  // Not every address has a care-of line. The label alone has to anchor it, even
  // on a line too short to survive the content filter.
  it('reads an address that has an Address label but no care-of line', () => {
    const { address } = back('Address:\nFlat 12, Shanti Nagar Society\nNear Bus Stand, Navrangpura\nAhmedabad, Gujarat - 380009');

    expect(address).toContain('Shanti Nagar Society');
    expect(address).toContain('380009');
    expect(address).not.toMatch(/address/i);
  });

  it('finds the Address label behind junk tesseract left in front of it', () => {
    const { address } = back('| Address: 12 Rose Villa Apartments\nMG Road, Navrangpura\nAhmedabad, Gujarat 380009');

    expect(address).toMatch(/^12 Rose Villa Apartments/);
    expect(address).toContain('380009');
  });

  it('returns no address for the front of a card', () => {
    expect(back('Irshad Memon\nDOB: 18/02/1985\nMALE').address).toBe('');
  });

  it('refuses text that has no shape of an address', () => {
    expect(back('C/O something short').address).toBe('');
  });

  it('returns no name, date of birth or gender', () => {
    const fields = back('C/O: Mohammed Farid, 601 6th Floor\nAamena Residency, Dargah\nAhmedabad City\nGujarat - 380001');
    expect(Object.keys(fields).sort()).toEqual(['address', 'idNumber']);
  });
});

describe('telling which side a photo was', () => {
  const frontFields = { fullName: 'Irshad Memon', dob: '18/02/1985', gender: 'MALE', idNumber: 'XXXX XXXX 7966' };
  const backFields = { address: 'C/O: Mohammed Farid, Ahmedabad, 380001', idNumber: 'XXXX XXXX 7966' };
  const numberOnly = { fullName: '', dob: '', gender: '', idNumber: 'XXXX XXXX 7966' };

  it('trusts the slot the guest used when that side read', () => {
    expect(chooseSide('front', frontFields, undefined)).toBe('front');
    expect(chooseSide('back', undefined, backFields)).toBe('back');
  });

  // The failure that prompted this: a back photo in the front slot came back
  // with nothing but the number.
  it('recognises a back photo put in the front slot', () => {
    expect(chooseSide('front', numberOnly, backFields)).toBe('back');
  });

  it('recognises a front photo put in the back slot', () => {
    expect(chooseSide('back', frontFields, { address: '', idNumber: 'XXXX XXXX 7966' })).toBe('front');
  });

  // The number is printed on both sides, so it cannot move a photo anywhere.
  it('keeps the slot when only the number was read', () => {
    expect(chooseSide('front', numberOnly, { address: '', idNumber: 'XXXX XXXX 7966' })).toBe('front');
  });

  // A name is not proof of the front: on the back, place names read as names.
  it('does not treat a name alone as proof a photo is the front', () => {
    const nameOnly = { fullName: 'Dargah Khanpur', dob: '', gender: '', idNumber: '' };
    expect(chooseSide('back', nameOnly, { address: '', idNumber: '' })).toBe('back');
  });

  it('decides from the evidence when there is no slot, as with a camera photo', () => {
    expect(chooseSide(null, frontFields, undefined)).toBe('front');
    expect(chooseSide(null, numberOnly, backFields)).toBe('back');
    expect(chooseSide(null, numberOnly, { address: '', idNumber: '' })).toBeNull();
  });
});
