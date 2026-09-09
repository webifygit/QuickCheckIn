import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fieldsFromText, isValidAadhaar } = require('../src/services/aadhaarOcr.service');

// Everything here runs on text, not images: these are the rules that decide what
// a guest's form gets filled with, and they are worth pinning down separately
// from whether tesseract read the card well on a given day.
const identity = (text) => fieldsFromText({ identity: { text }, number: { text: '' }, address: { text: '' } });

describe('the Aadhaar number is checked, not just found', () => {
  // A card prints the Aadhaar and the VID side by side, and OCR takes whichever
  // it likes - every preprocessed read of one real card returned the VID.
  // Storing those digits as a guest's Aadhaar would be a silently wrong record.
  it('accepts a real number and rejects the VID printed beside it', () => {
    expect(isValidAadhaar('484293107966')).toBe(true);
    expect(isValidAadhaar('916337070155')).toBe(false);
  });

  it('rejects numbers that cannot be Aadhaar at all', () => {
    expect(isValidAadhaar('123456789012')).toBe(false);
    expect(isValidAadhaar('084293107966')).toBe(false); // never starts 0
    expect(isValidAadhaar('184293107966')).toBe(false); // never starts 1
    expect(isValidAadhaar('48429310796')).toBe(false); // eleven digits
  });

  it('never returns more of the number than the last four', () => {
    const fields = fieldsFromText({
      identity: { text: '' },
      number: { text: '4842 9310 7966' },
      address: { text: '' },
    });

    expect(fields.idNumber).toBe('XXXX XXXX 7966');
    expect(JSON.stringify(fields)).not.toContain('484293107966');
  });

  it('leaves the number blank when nothing valid was read', () => {
    expect(identity('some text 9163 3707 0155 and more').idNumber).toBe('');
  });
});

describe('reading the identity block', () => {
  it('reads the name, date of birth and gender off a real card', () => {
    // The exact text tesseract produces from the card this was built against.
    expect(identity('EE Irshad Memon\n18/02/1985 yo MALE on')).toMatchObject({
      fullName: 'Irshad Memon',
      dob: '18/02/1985',
      gender: 'MALE',
    });
  });

  // Cards print an issue or download date as well. Anchoring on the first date
  // found makes a guest's birthday the day their card was printed.
  it('is not fooled by the issue date', () => {
    const fields = identity('Issue Date: 09/04/2012\nRajesh Kumar\nDOB: 01/01/1990\nMALE');

    expect(fields.dob).toBe('01/01/1990');
    expect(fields.fullName).toBe('Rajesh Kumar');
  });

  // Any list of surnames to skip has to hold the commonest names in the country,
  // and then returns a blank name for the guests who carry them - silently.
  it.each(['Rajesh Kumar', 'Manpreet Singh', 'Sunita Devi', 'Irshad Memon', 'Asha Kulkarni'])(
    'reads the name %s rather than skipping it',
    (name) => {
      expect(identity(`Government of India\n${name}\nDOB: 01/01/1990\nMALE`).fullName).toBe(name);
    }
  );

  it('does not mistake the government header for a name', () => {
    expect(identity('Government of India\nDOB: 01/01/1990\nMALE').fullName).toBe('');
  });

  // FEMALE contains MALE, and a card that reads as the wrong gender is the kind
  // of error a guest skims past.
  it('reads FEMALE as FEMALE', () => {
    expect(identity('Asha Kulkarni\n14/08/1991\nFEMALE').gender).toBe('FEMALE');
  });
});

describe('reading the address block', () => {
  const address = (text) =>
    fieldsFromText({ identity: { text: '' }, number: { text: '' }, address: { text } }).address;

  it('starts at the care-of line, not the top of the region', () => {
    // Cards print the address twice, and tesseract renders the local-script pass
    // as convincing nonsense that must not be pasted onto the front of the real
    // address.
    const read = address(
      'noavedler ER2ME WIA VileTyR\nHME ICEL\nC/O: Mohammed Farid, 601 6th Floor\nAamena Residency, Nr Shahwazuuddin\nDargah, Khanpur, Ahmedabad City\nGujarat - 380001'
    );

    expect(read).toMatch(/^C\/O/);
    expect(read).not.toMatch(/noavedler/);
    expect(read).toContain('Aamena Residency');
  });

  it('returns nothing for the side of the card that has no address on it', () => {
    expect(address('Irshad Memon\nDOB: 18/02/1985\nMALE')).toBe('');
  });

  it('refuses text that has no shape of an address', () => {
    expect(address('C/O something short')).toBe('');
  });
});
