// Aadhaar numbers are reduced to their last four digits before anything is
// written down. Private entities in India are generally not permitted to hold
// full Aadhaar numbers, and nothing here needs one: the front desk only has to
// match the card in front of them to the record they are looking at.
//
// This has to happen on the server, for every path a number can arrive by - the
// card's QR, a guest typing it in, a staff member correcting a mis-scan - because
// the client is the one place the rule cannot be enforced.

const MASKED_RE = /^XXXX XXXX \d{4}$/;
const AADHAAR_DIGIT_COUNT = 12;

const digitsOf = (value) => String(value ?? '').replace(/\D/g, '');

// Already-masked values pass through untouched, which is what lets staff re-save
// a record without the stored `XXXX XXXX 1234` being rejected as malformed.
function isMaskedAadhaar(value) {
  return MASKED_RE.test(String(value ?? '').trim());
}

// Either the masked form we store, or the 12 digits printed on a card - spaces
// and hyphens allowed, because that is how people copy them off the card.
function looksLikeAadhaar(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return false;
  if (isMaskedAadhaar(trimmed)) return true;
  return /^[\d\s-]+$/.test(trimmed) && digitsOf(trimmed).length === AADHAAR_DIGIT_COUNT;
}

// Returns the masked form, or null when there is not even a last-four to keep.
// Never returns the input unchanged unless it was already masked.
function maskAadhaarNumber(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  if (isMaskedAadhaar(trimmed)) return trimmed;

  const digits = digitsOf(trimmed);
  if (digits.length < 4) return null;
  return `XXXX XXXX ${digits.slice(-4)}`;
}

module.exports = {
  isMaskedAadhaar,
  looksLikeAadhaar,
  maskAadhaarNumber,
  AADHAAR_DIGIT_COUNT,
};
