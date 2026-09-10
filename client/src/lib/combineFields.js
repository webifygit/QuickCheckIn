// Decides what one scan result may change on the form. Every way in - camera,
// photo upload, e-Aadhaar PDF - goes through here, so they all follow one set of
// rules about what can overwrite what.
//
// A value's source says how far to trust it: the QR is signed by UIDAI, printed
// text is tesseract's reading of ink. A filled field with no source was typed by
// the guest, and no scan ever overwrites it.
const RANK = { ocr: 1, qr: 2 };

const lastFour = (value) => (value || '').replace(/\D/g, '').slice(-4);

export function combineScan({ form, sources }, incoming, source) {
  const changes = {};
  const sourceChanges = {};
  const cleared = [];
  const filled = [];
  const conflicts = [];

  for (const [key, value] of Object.entries(incoming || {})) {
    if (!value) continue;
    const current = form[key];
    const currentSource = sources[key];

    if (current && !currentSource) continue;

    // The last four digits are printed on both sides and carried in the QR, so
    // they are the one cross-check available. A mismatch usually means two
    // different cards, and a wrong number is worse than a blank one.
    const mismatch = key === 'idNumber' && Boolean(current) && lastFour(current) !== lastFour(value);
    if (mismatch) conflicts.push(key);

    if (current && RANK[currentSource] > RANK[source]) continue;

    if (mismatch && RANK[currentSource] === RANK[source]) {
      changes[key] = '';
      cleared.push(key);
      continue;
    }

    changes[key] = value;
    sourceChanges[key] = source;
    filled.push(key);
  }

  return { changes, sourceChanges, cleared, filled, conflicts };
}
