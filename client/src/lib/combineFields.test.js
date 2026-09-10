import { describe, it, expect } from 'vitest';
import { combineScan } from './combineFields';

const empty = { form: { fullName: '', dob: '', idNumber: '', address: '' }, sources: {} };

describe('combining scan results into the form', () => {
  it('fills empty fields and records where each came from', () => {
    const result = combineScan(empty, { fullName: 'Irshad Memon', idNumber: 'XXXX XXXX 7966' }, 'ocr');

    expect(result.changes).toEqual({ fullName: 'Irshad Memon', idNumber: 'XXXX XXXX 7966' });
    expect(result.sourceChanges).toEqual({ fullName: 'ocr', idNumber: 'ocr' });
    expect(result.conflicts).toEqual([]);
  });

  it('never overwrites something the guest typed', () => {
    const state = { form: { ...empty.form, fullName: 'Irshad A Memon' }, sources: {} };

    expect(combineScan(state, { fullName: 'Irshad Memon' }, 'qr').changes).toEqual({});
  });

  it('does not let printed text overwrite the signed QR', () => {
    const state = { form: { ...empty.form, fullName: 'Irshad Memon' }, sources: { fullName: 'qr' } };

    expect(combineScan(state, { fullName: 'lrshad Memon' }, 'ocr').changes).toEqual({});
  });

  it('lets the QR replace a value read from printed text', () => {
    const state = { form: { ...empty.form, fullName: 'lrshad Memon' }, sources: { fullName: 'ocr' } };

    expect(combineScan(state, { fullName: 'Irshad Memon' }, 'qr').changes).toEqual({ fullName: 'Irshad Memon' });
  });

  it('adds the back of the card to the front without disturbing it', () => {
    const state = {
      form: { ...empty.form, fullName: 'Irshad Memon', idNumber: 'XXXX XXXX 7966' },
      sources: { fullName: 'ocr', idNumber: 'ocr' },
    };
    const result = combineScan(state, { address: 'C/O: Mohammed Farid, 380001', idNumber: 'XXXX XXXX 7966' }, 'ocr');

    expect(result.changes).toEqual({ address: 'C/O: Mohammed Farid, 380001', idNumber: 'XXXX XXXX 7966' });
    expect(result.conflicts).toEqual([]);
  });

  describe('when the ID number disagrees', () => {
    // Two photos whose last four digits differ are almost certainly two cards.
    it('clears it between two printed-text reads and reports the conflict', () => {
      const state = { form: { ...empty.form, idNumber: 'XXXX XXXX 7966' }, sources: { idNumber: 'ocr' } };
      const result = combineScan(state, { idNumber: 'XXXX XXXX 1234' }, 'ocr');

      expect(result.changes).toEqual({ idNumber: '' });
      expect(result.cleared).toEqual(['idNumber']);
      expect(result.conflicts).toEqual(['idNumber']);
    });

    it('keeps the QR number over a photo and still reports it', () => {
      const state = { form: { ...empty.form, idNumber: 'XXXX XXXX 7966' }, sources: { idNumber: 'qr' } };
      const result = combineScan(state, { idNumber: 'XXXX XXXX 1234' }, 'ocr');

      expect(result.changes).toEqual({});
      expect(result.conflicts).toEqual(['idNumber']);
    });

    it('takes the QR number over a photo and still reports it', () => {
      const state = { form: { ...empty.form, idNumber: 'XXXX XXXX 1234' }, sources: { idNumber: 'ocr' } };
      const result = combineScan(state, { idNumber: 'XXXX XXXX 7966' }, 'qr');

      expect(result.changes).toEqual({ idNumber: 'XXXX XXXX 7966' });
      expect(result.conflicts).toEqual(['idNumber']);
    });
  });
});
